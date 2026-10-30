/**
 * P0 072. v12 pays the block pot in coinbase notes. The pull book stays
 * empty, no sweep is built, and no path on this magic reaches poolWithdrawTx.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOCK_SUBSIDY_NANOS,
  POOL_FEE_BPS,
  SHARE_FLOOR_BITS,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { hash20FromAddress, newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { noteCommitOfDest20, openedCoinbaseNanos } from '../../crypto/note.js';
import { MAGIC_TESTNET, MAGIC_TESTNET_V12 } from '../../crypto/reserve_books.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import { potSharesFromBatch } from '../../node/src/chain.js';
import { AUTO_PAYOUT_MIN_NANOS } from '../src/auto_payout.js';
import { CLIENT, SHEARK_MINER_VERSION, configuredFeeIdentity, createPool, publicMinerTag } from '../src/pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FEE = configuredFeeIdentity().feeDest;
const NAME = 'poolWithdrawTx';

const POTS = [
  { name: 'below', nanos: AUTO_PAYOUT_MIN_NANOS - 1 },
  { name: 'at', nanos: AUTO_PAYOUT_MIN_NANOS },
  { name: 'above', nanos: AUTO_PAYOUT_MIN_NANOS * 17 },
];

let powTag = 72000;
function nextPow() {
  powTag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag >>> 0, 4);
  return h.toString('hex');
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function credit(pool, dest, header, bits, low) {
  const nonce = nonceWithShareTarget(BigInt(low), bits);
  const got = pool.creditAcceptedShare({
    dest,
    nonce,
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    verifiedHeader: header,
    hash: '11',
  });
  assert.equal(got.ok, true, got.reason || 'credit');
  return String(nonce);
}

function bitsFor(i, n) {
  if (n === 1) return SHARE_FLOOR_BITS;
  if (i === 1) return Math.min(shareCreditMaxBits(), SHARE_FLOOR_BITS + 8);
  return SHARE_FLOOR_BITS + (i % 3);
}

async function seal(pool) {
  const got = await pool.sealFoundShare({
    jobId: pool.lastJob.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(got.ok, true, got.reason || 'seal');
  return got;
}

function ncHex(nc) {
  return Buffer.from(nc).toString('hex');
}

function openedByKind(vouts) {
  const by = new Map();
  for (const o of vouts || []) {
    const v = openedCoinbaseNanos(o);
    assert.equal(typeof v, 'number', `output opens (${o.kind})`);
    assert.ok(v >= 0, o.kind);
    const key = `${o.kind}:${ncHex(o.noteCommit)}`;
    by.set(key, (by.get(key) || 0) + v);
  }
  return by;
}

function isPullTx(tx) {
  if (!tx || typeof tx !== 'object') return false;
  if (String(tx.kind || '') === 'pool-withdraw') return true;
  return Array.isArray(tx.vout) && tx.vout.some((o) => String(o?.kind || '') === 'pool-withdraw');
}

function bookFile(dir) {
  return path.join(dir, 'pull-book.json');
}

function assertBookEmpty(pool, dir, dests, where) {
  assert.equal(pool.pullBook.dueAuto, undefined, where);
  assert.equal(pool.pullBook.unpaidPotNanos({ tipHeight: 80, need: 1 }), 0, where);
  for (const dest of dests) {
    const tag = publicMinerTag(dest);
    const view = pool.pullBook.view(tag, { tipHeight: 80, need: 1 });
    assert.equal(view.pendingNanos, 0, where);
    assert.equal(view.confirmedNanos, 0, where);
    assert.equal(view.unconfirmedNanos, 0, where);
    assert.equal(view.sentNanos, 0, where);
    assert.equal(pool.pullBook.ledger(tag).length, 0, where);
  }
  const file = bookFile(dir);
  if (!fs.existsSync(file)) return;
  const disk = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(disk, /ssa1/, where);
  const parsed = JSON.parse(disk);
  assert.equal((parsed.credits || []).length, 0, where);
  assert.equal((parsed.pulled || []).length, 0, where);
  assert.equal(Number(parsed.sealsLifetime) || 0, 0, where);
}

async function listenLocal(pool) {
  await new Promise((resolve, reject) => {
    const fail = (err) => {
      pool.stratum.off('error', fail);
      pool.httpServer.off('error', fail);
      reject(err);
    };
    pool.stratum.on('error', fail);
    pool.httpServer.on('error', fail);
    pool.stratum.listen(0, '127.0.0.1', () => {
      pool.httpServer.listen(0, '127.0.0.1', () => {
        pool.stratum.off('error', fail);
        pool.httpServer.off('error', fail);
        resolve();
      });
    });
  });
  return pool.httpServer.address().port;
}

function httpCall(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          text,
          json() {
            return JSON.parse(text);
          },
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function bootFromMinerPage(html) {
  const marker = 'const BOOT = ';
  const at = html.indexOf(marker);
  assert.ok(at >= 0, 'miner page boot');
  const start = at + marker.length;
  if (html.startsWith('null', start)) return null;
  assert.equal(html[start], '{');
  let depth = 0;
  let inStr = false;
  let esc = false;
  let i = start;
  for (; i < html.length; i += 1) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return JSON.parse(html.slice(start, i));
}

const PULL_KEY = /owed|due|pending|unpaid|withdraw/i;

/**
 * Benign matches are one exact JSON path plus a type. The same key under any
 * other path is a pull balance. `recentTxs[i].pending` is the block-row flag.
 */
const BENIGN_PULL_PATHS = [
  {
    path: /^hashOwedNanos$/,
    ok: (v) => v === null || (typeof v === 'number' && Number.isFinite(v)),
  },
  {
    path: /^windowOwedUnits$/,
    ok: (v) => typeof v === 'string',
  },
  {
    path: /^windowOwedNotes$/,
    ok: (v) => typeof v === 'number' && Number.isFinite(v),
  },
  {
    path: /^recentTxs\[\d+\]\.pending$/,
    ok: (v) => typeof v === 'boolean',
  },
];

/** Custodial display from pull.pendingNanos and banner.pending. Zero everywhere. */
const CUSTODIAL_DISPLAY = {
  pendingShe: (v) => v === 0,
  pendingConfirmShe: (v) => v === 0,
  pendingDisplay: (v) => v === '0',
  pendingConfirmDisplay: (v) => v === '0',
};

export function pullBalanceKeys(value) {
  const found = [];
  function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) walk(node[i], `${path}[${i}]`);
      return;
    }
    for (const key of Object.keys(node)) {
      const here = path ? `${path}.${key}` : key;
      const child = node[key];
      const display = CUSTODIAL_DISPLAY[key];
      if (display) {
        if (!display(child)) found.push(here);
      } else if (PULL_KEY.test(key)) {
        const rule = BENIGN_PULL_PATHS.find((r) => r.path.test(here));
        if (!rule || !rule.ok(child)) found.push(here);
      }
      walk(child, here);
    }
  }
  walk(value, '');
  return found;
}

function assertNoPullKeys(value, where) {
  const found = pullBalanceKeys(value);
  assert.deepEqual(found, [], `${where} ${found.join(' ')}`);
}

function assertStatsShowNoPull(stats, where) {
  // Nothing to reconcile: the pull book holds no credits on any book.
  assert.equal(stats.reconcile, undefined, where);
  assert.equal(stats.autoPayoutLastError, null, where);
  assert.equal(stats.blocksLifetime, 0, where);
  assert.equal(stats.sealsLifetime, 0, where);
  assertNoPullKeys(stats, where);
}

function assertUnknownMiner(res, tag, where) {
  assert.equal(res.status, 404, where);
  const body = res.json();
  assert.equal(body && typeof body, 'object', where);
  assert.equal(body.ok, false, where);
  assert.equal(body.reason, 'unknown_miner', where);
  assert.equal(body.tag, tag, where);
  assert.equal(body.pendingShe, undefined, where);
  assert.equal(body.pendingDisplay, undefined, where);
  assert.equal(body.pendingConfirmShe, undefined, where);
  assert.equal(body.pendingConfirmDisplay, undefined, where);
  assertNoPullKeys(body, where);
  return body;
}

function assertKnownMiner(body, tag, where, scan) {
  assert.equal(body && typeof body, 'object', where);
  assert.equal(body.ok, true, where);
  assert.equal(body.tag, tag, where);
  assert.equal(body.pendingShe, 0, where);
  assert.equal(body.pendingDisplay, '0', where);
  assert.equal(body.pendingConfirmShe, 0, where);
  assert.equal(body.pendingConfirmDisplay, '0', where);
  assert.equal(body.unconfirmedShe, 0, where);
  assert.equal(body.creditConfirmedShe, 0, where);
  assert.equal(body.sentShe, 0, where);
  assert.equal((body.ledger || []).length, 0, where);
  assertNoPullKeys(body, where);
  scan.api += 1;
}

function assertPoolPageShowsNoPull(html, where) {
  assert.match(html, /This pool is not custodial/, where);
  assert.doesNotMatch(html, /owedPi|pendingShe|pendingNanos|potCreditsNanos|dueAuto|unpaidPot|Owed toward|pull balance/i, where);
  const paintAt = html.indexOf('function paint(s)');
  const paintEnd = html.indexOf('function esc(', paintAt);
  assert.ok(paintAt >= 0 && paintEnd > paintAt, where);
  const paint = html.slice(paintAt, paintEnd);
  assert.doesNotMatch(paint, /reconcile|potCredits|pendingShe|owedPi|autoPayout|dueAuto|unpaid/, where);
}

function assertMinerPageShowsNoPull(html, where, scan) {
  assert.match(html, /id="m-pending">Shear Privacy</, where);
  assert.match(html, /id="m-confirmed">Shear Privacy</, where);
  assert.match(html, /id="m-hashbonus">Shear Privacy</, where);
  assert.equal(html.split('fmtPullShe(').length, 2, where);
  const paintAt = html.indexOf('function paint(d)');
  const paintEnd = html.indexOf('function tick()', paintAt);
  assert.ok(paintAt >= 0 && paintEnd > paintAt, where);
  const paint = html.slice(paintAt, paintEnd);
  assert.match(paint, /set\('m-pending', 'Shear Privacy'\)/, where);
  assert.match(paint, /set\('m-confirmed', 'Shear Privacy'\)/, where);
  assert.doesNotMatch(paint, /fmtPullShe|pendingShe|pendingDisplay|owedPi/, where);
  const boot = bootFromMinerPage(html);
  assert.ok(boot, where);
  assertNoPullKeys(boot, where);
  if (boot.ok) {
    assert.equal(boot.pendingShe, 0, where);
    assert.equal(boot.pendingDisplay, '0', where);
    assert.equal(boot.pendingConfirmShe, 0, where);
    assert.equal(boot.pendingConfirmDisplay, '0', where);
    assert.equal(boot.unconfirmedShe, 0, where);
    assert.equal(boot.creditConfirmedShe, 0, where);
    assert.equal(boot.sentShe, 0, where);
    assert.equal(boot.confirmedSentShe, 0, where);
    assert.equal((boot.ledger || []).length, 0, where);
    if (scan) scan.boot += 1;
    return true;
  } else {
    assert.equal(boot.ok, false, where);
    assert.equal(boot.pendingShe, undefined, where);
    assert.equal(boot.pendingDisplay, undefined, where);
    assert.equal(boot.pendingConfirmShe, undefined, where);
    assert.equal(boot.pendingConfirmDisplay, undefined, where);
    assert.equal(boot.owedPi, undefined, where);
    return false;
  }
}

function loginProbe(port, login) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error('probe_login_timeout'));
    }, 20_000);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    sock.on('error', fail);
    sock.on('data', (chunk) => {
      if (settled) return;
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) {
          fail(new Error(`probe_login_${msg.error}`));
          return;
        }
        if (msg.id === 1 && (msg.result?.status === 'OK' || msg.result === 'OK')) {
          settled = true;
          clearTimeout(timer);
          resolve(sock);
          return;
        }
      }
    });
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({
        id: 1,
        method: 'login',
        params: {
          login,
          client: CLIENT,
          version: SHEARK_MINER_VERSION,
          threads: 1,
          name: 'ShearK-Miner',
        },
      })}\n`);
    });
  });
}

const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'throw', 'void', 'delete', 'await', 'else', 'do']);

function skipLineComment(src, i) {
  while (i < src.length && src[i] !== '\n') i += 1;
  return i;
}

function skipBlockComment(src, i) {
  i += 2;
  while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
  return Math.min(src.length, i + 2);
}

function skipQuoted(src, i) {
  const q = src[i];
  const start = i;
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === q) return i + 1;
    i += 1;
  }
  if (src.slice(start, i).includes(NAME)) {
    throw new Error(`${NAME} hidden in a string at ${lineOf(src, start)}`);
  }
  return i;
}

function skipRegex(src, i) {
  const start = i;
  i += 1;
  let klass = false;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '[') klass = true;
    else if (src[i] === ']') klass = false;
    else if (src[i] === '/' && !klass) {
      i += 1;
      while (i < src.length && /[a-z]/i.test(src[i])) i += 1;
      return i;
    } else if (src[i] === '\n') break;
    i += 1;
  }
  if (src.slice(start, i).includes(NAME)) {
    throw new Error(`${NAME} hidden in a regex at ${lineOf(src, start)}`);
  }
  return i;
}

function canStartRegex(prev) {
  if (!prev) return true;
  if (prev.type === 'word') return REGEX_AFTER.has(prev.word);
  if (prev.type === 'punct' && (prev.c === ')' || prev.c === ']')) return false;
  return true;
}

function tokensOf(src) {
  const tokens = [];
  let i = 0;
  let prev = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      i = skipLineComment(src, i + 2);
      continue;
    }
    if (c === '/' && n === '*') {
      i = skipBlockComment(src, i);
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      const end = skipQuoted(src, i);
      const raw = src.slice(i + 1, Math.max(i + 1, end - 1));
      if (raw.includes(NAME) || src.slice(i, end).includes(NAME)) {
        throw new Error(`${NAME} hidden in a string at ${lineOf(src, i)}`);
      }
      tokens.push({ type: 'str', value: raw, index: i });
      i = end;
      prev = { type: 'punct', c: '"' };
      continue;
    }
    if (c === '/' && canStartRegex(prev)) {
      i = skipRegex(src, i);
      prev = { type: 'punct', c: '/' };
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      i += 1;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i += 1;
      const word = src.slice(start, i);
      const tok = { type: 'word', word, index: start };
      tokens.push(tok);
      prev = tok;
      continue;
    }
    if ('{}()[];,'.includes(c)) {
      const tok = { type: 'punct', c, index: i };
      tokens.push(tok);
      prev = tok;
      i += 1;
      continue;
    }
    if (!/\s/.test(c)) prev = { type: 'punct', c };
    i += 1;
  }
  return tokens;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i = Math.min(src.length, i + 2);
      out += ' ';
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      const start = i;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += src.slice(start, i);
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function headerBefore(src, braceIndex) {
  const raw = src.slice(Math.max(0, braceIndex - 700), braceIndex);
  return stripComments(raw).replace(/\s+/g, ' ');
}

function blockStartsWithReturn(src, braceIndex) {
  const rest = src.slice(braceIndex + 1, braceIndex + 40).replace(/^\s+/, '');
  return rest.startsWith('return') || rest.startsWith('throw');
}

/**
 * A call is off the v12 path when this magic returns before it, the call's
 * own block is `if (false && ...)` with no `||`, `?`, `:`, or comma.
 * Comments, `else`, and `false ||` stay live.
 */
function openFunction(fnStack) {
  for (let i = fnStack.length - 1; i >= 0; i -= 1) {
    if (!fnStack[i].pending) return fnStack[i];
  }
  return null;
}

function atFunctionBody(fnStack, blockStack) {
  const openFn = openFunction(fnStack);
  if (!openFn) return false;
  if (blockStack.some((b) => b.kind === 'obj')) return false;
  const blocks = blockStack.filter((b) => b.kind === 'block').length;
  return blocks === openFn.depth + 1;
}

export function v12CallVerdict(src, callIndex) {
  const tokens = tokensOf(src);
  const calls = tokens.filter((t) => t.type === 'word' && t.word === NAME && t.index === callIndex);
  assert.equal(calls.length, 1);
  const fnStack = [];
  const blockStack = [];
  let stmtStart = 0;
  let paren = 0;
  for (const tok of tokens) {
    if (tok.index > callIndex) break;
    if (tok.type === 'punct' && tok.c === '(') {
      paren += 1;
      continue;
    }
    if (tok.type === 'punct' && tok.c === ')') {
      paren -= 1;
      continue;
    }
    if (tok.type === 'word' && tok.word === 'function') {
      fnStack.push({ pending: true, gated: false, depth: 0 });
      continue;
    }
    if (tok.type === 'punct' && tok.c === '{') {
      if (paren > 0) {
        blockStack.push({ kind: 'obj' });
        continue;
      }
      const pre = headerBefore(src, tok.index);
      const pending = fnStack.length && fnStack[fnStack.length - 1].pending;
      const isFn = !!(pending && /\)\s*$/.test(pre));
      const keywordBlock = /(?:^|[^\w$])(try|catch|finally|else|do)\s*$/.test(pre);
      const isBlock = isFn || keywordBlock || /\)\s*$/.test(pre) || /=>\s*$/.test(pre) || /(?:^|[;{}])\s*$/.test(pre);
      if (isFn) {
        const frame = fnStack[fnStack.length - 1];
        frame.pending = false;
        frame.depth = blockStack.filter((b) => b.kind === 'block').length;
        stmtStart = tok.index + 1;
      }
      if (!isBlock) {
        blockStack.push({ kind: 'obj' });
        continue;
      }
      const rawCond = stripComments(src.slice(stmtStart, tok.index));
      const flat = rawCond.replace(/\s+/g, ' ').trim();
      const dead = /if\s*\(\s*false\s*&&([^?:,{};|]*)\)\s*$/.test(flat);
      const onlyOld = /if\s*\(\s*custodialPullAllowed\s*\(\s*\)\s*\)\s*$/.test(flat);
      const gateBlock = /if\s*\(\s*!\s*custodialPullAllowed\s*\(\s*\)\s*\)\s*$/.test(flat)
        && blockStartsWithReturn(src, tok.index);
      const body = atFunctionBody(fnStack, blockStack);
      if (body && gateBlock) openFunction(fnStack).gated = true;
      blockStack.push({
        kind: 'block',
        dead: body && dead,
        onlyOld: body && onlyOld,
      });
      if (body) stmtStart = tok.index + 1;
      continue;
    }
    if (tok.type === 'punct' && tok.c === '}') {
      const top = blockStack.pop();
      if (top && top.kind === 'block') {
        const openFn = openFunction(fnStack);
        const blocks = blockStack.filter((b) => b.kind === 'block').length;
        if (openFn && blocks === openFn.depth) {
          fnStack.splice(fnStack.lastIndexOf(openFn), 1);
        } else if (atFunctionBody(fnStack, blockStack)) {
          stmtStart = tok.index + 1;
        }
      }
      continue;
    }
    if (!atFunctionBody(fnStack, blockStack)) continue;
    if (tok.type === 'punct' && tok.c === ';') {
      const raw = src.slice(stmtStart, tok.index);
      if (/if\s*\(\s*!\s*custodialPullAllowed\s*\(\s*\)\s*\)\s*return\b/.test(raw)) {
        openFunction(fnStack).gated = true;
      }
      stmtStart = tok.index + 1;
    }
  }
  if (blockStack.some((b) => b.dead || b.onlyOld)) return 'dead';
  const openFn = openFunction(fnStack);
  if (openFn && openFn.gated) return 'gated';
  return 'reaches';
}

function classifyUses(src) {
  const tokens = tokensOf(src);
  const uses = [];
  let importing = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.type === 'word' && tok.word === 'import') importing = true;
    if (tok.type === 'punct' && tok.c === ';') importing = false;
    if (!(tok.type === 'word' && tok.word === NAME)) continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (prev && prev.type === 'word' && prev.word === 'function') {
      uses.push({ kind: 'decl', index: tok.index });
      continue;
    }
    if (importing) {
      if (next && next.type === 'word' && next.word === 'as') {
        uses.push({ kind: 'alias', index: tok.index });
      } else {
        uses.push({ kind: 'import', index: tok.index });
      }
      continue;
    }
    if (next && next.type === 'punct' && next.c === '(') {
      uses.push({ kind: 'call', index: tok.index });
      continue;
    }
    if (next && next.type === 'punct' && next.c === ':') {
      uses.push({ kind: 'alias', index: tok.index });
      continue;
    }
    uses.push({ kind: 'other', index: tok.index });
  }
  return uses;
}

function assertNoComputedWithdraw(file, src) {
  const tokens = tokensOf(src);
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!(tok.type === 'punct' && tok.c === '[')) continue;
    const parts = [];
    let pure = true;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (t.type === 'punct' && t.c === ']') break;
      if (t.type === 'str') parts.push(t.value);
      else if (t.type === 'punct' && t.c === '+') continue;
      else {
        pure = false;
        break;
      }
    }
    if (pure && parts.length > 0 && parts.join('') === NAME) {
      assert.fail(`${file}:${lineOf(src, tok.index)} computed ${NAME}`);
    }
  }
  if (/import\s*\(\s*(['"])[^'"]*levy\.js\1\s*\)/.test(src)) {
    assert.fail(`${file} dynamic import() of the pool module`);
  }
  for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]*levy\.js)\2/g)) {
    const name = m[1];
    const use = new RegExp(`(?:^|[^A-Za-z0-9_$])${name}\\s*\\[`);
    assert.doesNotMatch(src, use, `${file} computed access on ${name} reaches ${NAME}`);
    const reflect = new RegExp(`Reflect\\s*\\.\\s*get\\s*\\(\\s*${name}\\b`);
    assert.doesNotMatch(src, reflect, `${file} Reflect.get on ${name} reaches ${NAME}`);
    const values = new RegExp(`Object\\s*\\.\\s*values\\s*\\(\\s*${name}\\b`);
    assert.doesNotMatch(src, values, `${file} Object.values on ${name} reaches ${NAME}`);
  }
}

export function assertFileUnreachable(file, src) {
  assertNoComputedWithdraw(file, src);
  const uses = classifyUses(src);
  for (const use of uses) {
    const at = `${file}:${lineOf(src, use.index)}`;
    if (use.kind === 'decl' || use.kind === 'import') continue;
    assert.notEqual(use.kind, 'alias', `${at} renames ${NAME}`);
    assert.notEqual(use.kind, 'other', `${at} uses ${NAME} outside a call`);
    const verdict = v12CallVerdict(src, use.index);
    assert.notEqual(verdict, 'reaches', `${at} v12 path reaches ${NAME}`);
  }
}

function productionSources(root) {
  const skip = new Set(['node_modules', 'vendor', 'tests', '.git', 'artifacts']);
  const out = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs)$/.test(ent.name) && !ent.name.endsWith('.test.js')) out.push(full);
    }
  }
  walk(root);
  return out;
}

describe('P0 072 v12 custodial pull', () => {
  it('no v12 source path reaches poolWithdrawTx', () => {
    assert.equal(MAGIC_TESTNET, MAGIC_TESTNET_V12);

    const ungated = 'export function leak() {\n  return poolWithdrawTx({ from: 1 });\n}\n';
    assert.throws(() => assertFileUnreachable('leak.js', ungated), /reaches poolWithdrawTx/);
    const after = 'export function late() {\n  const tx = poolWithdrawTx({});\n  if (!custodialPullAllowed()) return { ok: false };\n}\n';
    assert.throws(() => assertFileUnreachable('late.js', after), /reaches poolWithdrawTx/);
    const nested = 'export function hide(ready) {\n  if (ready) {\n    if (!custodialPullAllowed()) return { ok: false };\n  }\n  return poolWithdrawTx({});\n}\n';
    assert.throws(() => assertFileUnreachable('hide.js', nested), /reaches poolWithdrawTx/);
    const alias = 'import { poolWithdrawTx as build } from "./levy.js";\nexport function leak() { return build(); }\n';
    assert.throws(() => assertFileUnreachable('alias.js', alias), /renames poolWithdrawTx/);
    const earlierDead = 'export function leak(x) {\n  if (false) {}\n  if (x) { return poolWithdrawTx(); }\n}\n';
    assert.throws(() => assertFileUnreachable('earlier.js', earlierDead), /reaches poolWithdrawTx/);
    const orLive = 'export function leak(x) {\n  if (false || x) { return poolWithdrawTx(); }\n}\n';
    assert.throws(() => assertFileUnreachable('or.js', orLive), /reaches poolWithdrawTx/);
    const elseLive = 'export function leak() {\n  if (false) {} else { return poolWithdrawTx(); }\n}\n';
    assert.throws(() => assertFileUnreachable('else.js', elseLive), /reaches poolWithdrawTx/);
    const commentLive = 'export function leak(ready) {\n  if (ready) // if (false && y)\n  { return poolWithdrawTx(); }\n}\n';
    assert.throws(() => assertFileUnreachable('comment.js', commentLive), /reaches poolWithdrawTx/);
    const ternLive = 'export function leak(x) {\n  if (false && x ? 1 : 1) { return poolWithdrawTx(); }\n}\n';
    assert.throws(() => assertFileUnreachable('tern.js', ternLive), /reaches poolWithdrawTx/);
    const commaLive = 'export function leak(x) {\n  if (false && x, true) { return poolWithdrawTx(); }\n}\n';
    assert.throws(() => assertFileUnreachable('comma.js', commaLive), /reaches poolWithdrawTx/);
    const computed = 'import * as L from "./levy.js";\nexport function leak() {\n  return L[\'pool\' + \'WithdrawTx\']({ from: 1 });\n}\n';
    assert.throws(() => assertFileUnreachable('computed.js', computed), /computed poolWithdrawTx/);
    const dynamicImport = 'export async function leak() {\n  return import("./levy.js");\n}\n';
    assert.throws(() => assertFileUnreachable('dyn.js', dynamicImport), /dynamic import\(\)/);
    const reflectGet = 'import * as L from "./levy.js";\nexport function leak() {\n  return Reflect.get(L, \'pool\' + \'WithdrawTx\');\n}\n';
    assert.throws(() => assertFileUnreachable('reflect.js', reflectGet), /Reflect\.get/);
    const objectValues = 'import * as L from "./levy.js";\nexport function leak() {\n  return Object.values(L);\n}\n';
    assert.throws(() => assertFileUnreachable('values.js', objectValues), /Object\.values/);

    const gated = 'export function buildAutoPayoutTx() {\n  if (!custodialPullAllowed()) return { ok: false, reason: \'custodial_pull\' };\n  const tx = poolWithdrawTx({ from: 1 });\n  return tx;\n}\n';
    assertFileUnreachable('gated.js', gated);
    const dead = 'export function handleWalletApi() {\n  if (false && path === \'/api/pool/withdraw\') {\n    const tx = poolWithdrawTx({ from: 1 });\n    return tx;\n  }\n}\n';
    assertFileUnreachable('dead.js', dead);
    const oldOnly = 'export function oldBook() {\n  if (custodialPullAllowed()) {\n    return poolWithdrawTx({ from: 1 });\n  }\n  return { ok: false, reason: \'custodial_pull\' };\n}\n';
    assertFileUnreachable('old.js', oldOnly);
    const decl = 'export function poolWithdrawTx({ from } = {}) {\n  return { kind: \'pool-withdraw\', from };\n}\n';
    assertFileUnreachable('levy.js', decl);
    const unrelated = 'import * as L from "./wallet_api.js";\nexport async function leak(obj) {\n  const m = await import("./wallet_api.js");\n  return Reflect.get(obj, "x") || Object.values(m);\n}\n';
    assertFileUnreachable('other.js', unrelated);

    const files = productionSources(ROOT);
    const sep = path.sep;
    assert.ok(files.some((f) => f.endsWith(`${sep}crypto${sep}levy.js`)));
    assert.ok(files.some((f) => f.endsWith(`${sep}pool${sep}src${sep}auto_payout.js`)));
    assert.ok(files.some((f) => f.endsWith(`${sep}pool${sep}src${sep}wallet_api.js`)));
    assert.ok(files.some((f) => f.endsWith(`${sep}pool${sep}src${sep}pool.js`)));
    assert.equal(files.some((f) => f.includes(`${sep}tests${sep}`)), false);
    assert.equal(files.some((f) => f.endsWith('.test.js')), false);
    let calls = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      assertNoComputedWithdraw(rel, src);
      if (!src.includes(NAME)) continue;
      const before = classifyUses(src).filter((u) => u.kind === 'call').length;
      calls += before;
      assertFileUnreachable(path.relative(ROOT, file), src);
    }
    // The pool side no longer names the builder at all; the scan stays so a
    // call can never come back (crypto/levy.js keeps only the declaration
    // until the node-side removal is signed off).
    assert.equal(calls, 0, 'no production path calls the refused builder');
  });

  it('pull-balance scan is exact paths, types, and zero custodial display', () => {
    const benign = {
      ok: true,
      windowOwedNotes: 0,
      windowOwedUnits: '0',
      hashOwedNanos: null,
      recentTxs: [{ pending: false, kind: 'block' }, { pending: true, kind: 'block' }],
      pendingShe: 0,
      pendingDisplay: '0',
      pendingConfirmShe: 0,
      pendingConfirmDisplay: '0',
    };
    assert.deepEqual(pullBalanceKeys(benign), []);
    assert.deepEqual(pullBalanceKeys({ ...benign, hashOwedNanos: 0 }), []);
    const injected = {
      ...benign,
      owedNanos: 1,
      dueNanos: 2,
      reconcile: { owedNanos: 3 },
      miners: [{ dueNanos: 4 }],
    };
    let message = '';
    try {
      assertNoPullKeys(injected, 'inject');
    } catch (err) {
      message = String(err && err.message);
    }
    assert.match(message, /\bowedNanos\b/);
    assert.match(message, /\bdueNanos\b/);
    assert.match(message, /reconcile\.owedNanos/);
    assert.match(message, /miners\[0\]\.dueNanos/);

    const custody = { ...benign, custody: { hashOwedNanos: 314159265 } };
    assert.throws(() => assertNoPullKeys(custody, 'custody'), /custody\.hashOwedNanos/);
    const topPending = { ...benign, pending: 314159265 };
    assert.throws(() => assertNoPullKeys(topPending, 'top'), /(?:^|\s)pending(?:\s|$)/);
    const badRow = {
      ...benign,
      recentTxs: [{ pending: 314159265, kind: 'block' }],
    };
    assert.throws(() => assertNoPullKeys(badRow, 'row'), /recentTxs\[0\]\.pending/);
    const badType = { ...benign, recentTxs: [{ pending: 'false' }] };
    assert.throws(() => assertNoPullKeys(badType, 'type'), /recentTxs\[0\]\.pending/);

    const nonzero = [
      { pendingShe: 1 },
      { pendingShe: 314159265 },
      { pendingDisplay: '1' },
      { pendingDisplay: 0 },
      { pendingConfirmShe: 314159265 },
      { pendingConfirmDisplay: '314159265' },
      { stats: { pendingShe: 1, pendingDisplay: '0' } },
      { boot: { pendingConfirmDisplay: '1' } },
    ];
    for (const body of nonzero) {
      const faults = pullBalanceKeys(body);
      assert.ok(faults.length > 0, JSON.stringify(body));
      assert.throws(() => assertNoPullKeys(body, 'display'), /pending/);
    }
  });

  it('1, 3 and 17 miners across pots below, at and well above π keep coinbase notes and an empty pull book', { timeout: 600_000 }, async () => {
    assert.equal(configuredFeeIdentity().ok, true);
    assert.ok(POTS[0].nanos < AUTO_PAYOUT_MIN_NANOS);
    assert.equal(POTS[1].nanos, AUTO_PAYOUT_MIN_NANOS);
    assert.ok(POTS[2].nanos > AUTO_PAYOUT_MIN_NANOS * 8);
    for (const n of [1, 3, 17]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-072-n${n}-`));
      const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
      const queued = [];
      const orig = pool.store.queueTx.bind(pool.store);
      pool.store.queueTx = (tx, opts) => {
        queued.push(tx);
        return orig(tx, opts);
      };
      let probeSock = null;
      try {
        const port = await listenLocal(pool);
        const base = `http://127.0.0.1:${port}`;
        const dests = [];
        for (let i = 0; i < n; i += 1) dests.push(minerDest());
        const probe = dests[0];
        const probeTag = publicMinerTag(probe);
        probeSock = await loginProbe(pool.stratum.address().port, `${probe}.probe`);
        const scan = { api: 0, boot: 0 };
        const heightBefore = Number(pool.store.tip()?.height || 0);
        let low = 10 + n * 1000;
        for (const pot of POTS) {
          const where = `n=${n} ${pot.name}`;
          const rows = dests.map((dest, i) => ({
            tag: publicMinerTag(dest),
            dest,
            count: i + 1,
          }));
          const credited = pool.pullBook.creditRound(rows, {
            height: Math.max(1, Number(pool.store.tip()?.height || 0) + 1),
            nanos: pot.nanos,
            hashByDest: new Map(dests.map((dest, i) => [dest, (i + 1) * 1000])),
            finderTag: publicMinerTag(dests[0]),
            finderWorker: 'rig',
          });
          assert.equal(credited.ok, false, where);
          assert.equal(credited.reason, 'custodial_pull', where);
          assertBookEmpty(pool, dir, dests, where);

          const openJob = pool.issueJob(undefined, { force: true });
          assert.ok(openJob?.jobId, `${where} open job`);
          const parentHdr = Buffer.from(openJob.header, 'hex');
          for (let i = 0; i < dests.length; i += 1) {
            credit(pool, dests[i], parentHdr, bitsFor(i, n), low);
            low += 1;
            if (i === 0 && n > 1) {
              credit(pool, dests[0], parentHdr, SHARE_FLOOR_BITS, low);
              low += 1;
            }
          }
          await seal(pool);
          pool.rollOpenRound();
          const payJob = pool.issueJob(undefined, { force: true });
          assert.ok(payJob?.jobId, `${where} pay job`);
          const batch = pool.store.jobs.get(String(payJob.jobId))?.tpl?.shareBatch || [];
          assert.ok(batch.length > 0, `${where} empty shareBatch`);
          const carry = Math.max(0, Math.floor(Number(pool.store.tip()?.txs?.[0]?.carryNanos) || 0));
          const expectPays = potSharesFromBatch(batch, FEE, BLOCK_SUBSIDY_NANOS, carry);
          const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
          const feePays = expectPays.filter((p) => p.kind === 'pool-fee');
          const potPays = expectPays.filter((p) => p.kind === 'pot');
          assert.equal(feePays.length, 1, where);
          assert.equal(feePays[0].nanos, fee, where);
          const potSum = potPays.reduce((a, p) => a + p.nanos, 0);
          assert.equal(potSum, BLOCK_SUBSIDY_NANOS - fee + carry, where);
          assert.equal(potPays.length >= 1, true, where);
          if (n > 1) {
            assert.ok(new Set(potPays.map((p) => p.nanos)).size > 1, `${where} equal pot notes`);
          }
          await seal(pool);
          const coinbase = pool.store.tip().txs[0];
          assert.equal(coinbase.coinbase, true, where);
          assert.equal((coinbase.vout || []).some((o) => String(o?.kind || '') === 'pool-withdraw'), false, where);
          const opened = openedByKind(coinbase.vout);
          for (const p of expectPays) {
            const key = `${p.kind}:${ncHex(p.noteCommit)}`;
            assert.equal(opened.get(key), p.nanos, `${where} ${key}`);
          }
          const openedPot = [...opened.entries()].filter(([k]) => k.startsWith('pot:'));
          const openedPotSum = openedPot.reduce((a, [, v]) => a + v, 0);
          assert.equal(openedPot.length, potPays.length, where);
          assert.equal(openedPotSum, BLOCK_SUBSIDY_NANOS - fee + carry, where);
          pool.rollOpenRound();

          // No sweep exists to reach queueTx: miners are paid from the coinbase.
          assert.equal(pool.sweepAutoPayouts, undefined, where);
          assert.equal(pool.runAutoPayoutSweep, undefined, where);
          assert.equal(queued.filter(isPullTx).length, 0, where);
          assert.equal((pool.store.mempool || []).filter(isPullTx).length, 0, where);
          assertBookEmpty(pool, dir, dests, where);

          pool.paintStatsSnap();
          assert.equal(pool.httpServer.listening, true, `${where} http server`);
          const statsRes = await httpCall(`${base}/api/stats`);
          assert.equal(statsRes.status, 200, where);
          const stats = statsRes.json();
          assert.equal(stats.ok, true, where);
          assertStatsShowNoPull(stats, where);
          const page = await httpCall(`${base}/`);
          assert.equal(page.status, 200, where);
          assertPoolPageShowsNoPull(page.text, where);
          for (const dest of dests) {
            const tag = publicMinerTag(dest);
            const known = tag === probeTag;
            const beforeApi = scan.api;
            const beforeBoot = scan.boot;
            const minerPage = await httpCall(`${base}/miner/${tag}`);
            assert.equal(minerPage.status, 200, where);
            const bootOk = assertMinerPageShowsNoPull(minerPage.text, `${where} ${tag}`, known ? scan : null);
            assert.equal(bootOk, known, `${where} ${tag} boot.ok`);
            const api = await httpCall(`${base}/api/miners/${tag}`);
            if (known) {
              assert.equal(api.status, 200, `${where} probe miner`);
              assertKnownMiner(api.json(), tag, `${where} ${tag}`, scan);
              assert.equal(scan.api, beforeApi + 1, `${where} miner allowlist scan`);
              assert.equal(scan.boot, beforeBoot + 1, `${where} boot.ok scan`);
            } else {
              assert.equal(api.status, 404, where);
              assertUnknownMiner(api, tag, `${where} ${tag}`);
              assert.equal(scan.api, beforeApi, `${where} unknown miner scanned as known`);
              assert.equal(scan.boot, beforeBoot, `${where} unknown boot scanned as ok`);
            }
          }
          const ghostTag = 'm00000000';
          assert.equal(dests.some((dest) => publicMinerTag(dest) === ghostTag), false, where);
          const ghost = await httpCall(`${base}/api/miners/${ghostTag}`);
          assertUnknownMiner(ghost, ghostTag, `${where} unknown miner`);
          const beforeSweep = queued.length;
          const withdraw = await httpCall(`${base}/api/pool/withdraw`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              login: 'she1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
              dest: dests[0],
              nanos: pot.nanos,
            }),
          });
          assert.equal(withdraw.status, 410, where);
          assert.equal(queued.length, beforeSweep, `${where} withdraw reached queueTx`);
        }
        assert.ok(scan.api >= 1, `n=${n} miner API 200`);
        assert.ok(scan.boot >= 1, `n=${n} boot.ok`);
        assert.equal(scan.api, POTS.length, `n=${n} probe scan each pot`);
        assert.equal(scan.boot, POTS.length, `n=${n} probe boot each pot`);
        assert.equal(Number(pool.store.tip().height) - heightBefore, POTS.length * 2, `n=${n} sealed blocks`);
        assert.equal(queued.length, 0, `n=${n} queueTx`);
      } finally {
        try { probeSock?.destroy(); } catch { /* already closed */ }
        pool.close();
      }
    }
  });
});
