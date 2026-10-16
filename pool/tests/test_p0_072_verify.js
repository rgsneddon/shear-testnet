/**
 * P0 072. v12 pays the block pot in coinbase notes. The pull book stays
 * empty, no sweep is built, and no path on this magic reaches poolWithdrawTx.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
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
import { custodialPullAllowed } from '../../crypto/levy.js';
import { noteCommitOfDest20, openedCoinbaseNanos } from '../../crypto/note.js';
import { MAGIC_TESTNET, MAGIC_TESTNET_V12 } from '../../crypto/reserve_books.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import { potSharesFromBatch } from '../../node/src/chain.js';
import { AUTO_PAYOUT_MIN_NANOS } from '../src/auto_payout.js';
import { configuredFeeIdentity, createPool, publicMinerTag } from '../src/pool.js';

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
  assert.equal(pool.pullBook.dueAuto({ tipHeight: 80, need: 1 }).length, 0, where);
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

/** /api/stats keys that match the pull pattern and are not a custodial balance. */
const STATS_BENIGN_PULL_KEYS = new Set([
  'windowOwedUnits',
  'windowOwedNotes',
  'hashOwedNanos',
  'pending',
]);

/** Miner JSON also publishes the zeroed pull display. Any other name still fails. */
const MINER_BENIGN_PULL_KEYS = new Set([
  ...STATS_BENIGN_PULL_KEYS,
  'pendingShe',
  'pendingDisplay',
  'pendingConfirmShe',
  'pendingConfirmDisplay',
]);

export function pullBalanceKeys(value, allow) {
  const found = [];
  function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) walk(node[i], `${path}[${i}]`);
      return;
    }
    for (const key of Object.keys(node)) {
      const here = path ? `${path}.${key}` : key;
      if (PULL_KEY.test(key) && !allow.has(key)) found.push(here);
      walk(node[key], here);
    }
  }
  walk(value, '');
  return found;
}

function assertNoPullKeys(value, allow, where) {
  const found = pullBalanceKeys(value, allow);
  assert.deepEqual(found, [], `${where} ${found.join(' ')}`);
}

function assertStatsShowNoPull(stats, where) {
  const rec = stats.reconcile;
  assert.ok(rec, where);
  assert.equal(rec.potCreditsNanos, 0, where);
  assert.equal(rec.hashCreditsNanos, 0, where);
  assert.equal(rec.attributedFeeNanos, 0, where);
  assert.equal(rec.expectedNetPotNanos, 0, where);
  assert.equal(rec.driftNanos, 0, where);
  assert.equal(rec.sealsLifetime, 0, where);
  assert.equal(rec.ok, true, where);
  assert.equal(stats.autoPayoutLastError, null, where);
  assert.equal(stats.blocksLifetime, 0, where);
  assert.equal(stats.sealsLifetime, 0, where);
  assertNoPullKeys(stats, STATS_BENIGN_PULL_KEYS, where);
}

function assertUnknownMiner(res, tag, where) {
  assert.equal(res.status, 404, where);
  const body = res.json();
  assert.equal(body && typeof body, 'object', where);
  assert.equal(body.ok, false, where);
  assert.equal(body.reason, 'unknown_miner', where);
  assert.equal(body.tag, tag, where);
  assertNoPullKeys(body, STATS_BENIGN_PULL_KEYS, where);
  return body;
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

function assertMinerPageShowsNoPull(html, where) {
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
  assertNoPullKeys(boot, MINER_BENIGN_PULL_KEYS, where);
  if (boot.ok) {
    assert.equal(boot.pendingShe, 0, where);
    assert.equal(boot.unconfirmedShe, 0, where);
    assert.equal(boot.creditConfirmedShe, 0, where);
    assert.equal(boot.sentShe, 0, where);
    assert.equal(boot.pendingConfirmShe, 0, where);
    assert.equal(boot.confirmedSentShe, 0, where);
    assert.equal((boot.ledger || []).length, 0, where);
  } else {
    assert.equal(boot.ok, false, where);
    assert.equal(boot.pendingShe, undefined, where);
    assert.equal(boot.owedPi, undefined, where);
  }
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
  for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]*levy\.js)\2/g)) {
    const name = m[1];
    const use = new RegExp(`(?:^|[^A-Za-z0-9_$])${name}\\s*\\[`);
    assert.doesNotMatch(src, use, `${file} computed access on ${name} reaches ${NAME}`);
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
    assert.equal(custodialPullAllowed(), false);
    assert.equal(custodialPullAllowed(MAGIC_TESTNET), false);
    assert.equal(custodialPullAllowed(MAGIC_TESTNET_V12), false);
    assert.equal(custodialPullAllowed('shear-v1'), true);

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

    const gated = 'export function buildAutoPayoutTx() {\n  if (!custodialPullAllowed()) return { ok: false, reason: \'custodial_pull\' };\n  const tx = poolWithdrawTx({ from: 1 });\n  return tx;\n}\n';
    assertFileUnreachable('gated.js', gated);
    const dead = 'export function handleWalletApi() {\n  if (false && path === \'/api/pool/withdraw\') {\n    const tx = poolWithdrawTx({ from: 1 });\n    return tx;\n  }\n}\n';
    assertFileUnreachable('dead.js', dead);
    const oldOnly = 'export function oldBook() {\n  if (custodialPullAllowed()) {\n    return poolWithdrawTx({ from: 1 });\n  }\n  return { ok: false, reason: \'custodial_pull\' };\n}\n';
    assertFileUnreachable('old.js', oldOnly);
    const decl = 'export function poolWithdrawTx({ from } = {}) {\n  return { kind: \'pool-withdraw\', from };\n}\n';
    assertFileUnreachable('levy.js', decl);

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
    assert.ok(calls >= 1, 'production still names the refused builder');
  });

  it('stats key scan rejects injected owedNanos and dueNanos', () => {
    const benign = {
      ok: true,
      windowOwedNotes: 0,
      windowOwedUnits: '0',
      hashOwedNanos: null,
      recentTxs: [{ pending: false, kind: 'block' }],
    };
    assert.deepEqual(pullBalanceKeys(benign, STATS_BENIGN_PULL_KEYS), []);
    const injected = {
      ...benign,
      owedNanos: 1,
      dueNanos: 2,
      reconcile: { owedNanos: 3 },
      miners: [{ dueNanos: 4 }],
    };
    let message = '';
    try {
      assertNoPullKeys(injected, STATS_BENIGN_PULL_KEYS, 'inject');
    } catch (err) {
      message = String(err && err.message);
    }
    assert.match(message, /\bowedNanos\b/);
    assert.match(message, /\bdueNanos\b/);
    assert.match(message, /reconcile\.owedNanos/);
    assert.match(message, /miners\[0\]\.dueNanos/);
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
      try {
        const port = await listenLocal(pool);
        const base = `http://127.0.0.1:${port}`;
        const dests = [];
        for (let i = 0; i < n; i += 1) dests.push(minerDest());
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

          const beforeSweep = queued.length;
          const sent = await pool.sweepAutoPayouts();
          assert.equal(sent.length, 0, where);
          assert.equal(queued.length, beforeSweep, `${where} sweep reached queueTx`);
          const again = await pool.runAutoPayoutSweep();
          assert.equal(again.length, 0, where);
          assert.equal(queued.length, beforeSweep, `${where} timer sweep reached queueTx`);
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
            const minerPage = await httpCall(`${base}/miner/${tag}`);
            assert.equal(minerPage.status, 200, where);
            assertMinerPageShowsNoPull(minerPage.text, `${where} ${tag}`);
            const api = await httpCall(`${base}/api/miners/${tag}`);
            const body = api.json();
            if (api.status === 404) {
              assertUnknownMiner(api, tag, `${where} ${tag}`);
            } else {
              assert.equal(api.status, 200, where);
              assert.equal(body.ok, true, where);
              assert.equal(body.tag, tag, where);
              assert.equal(body.pendingShe, 0, where);
              assert.equal(body.unconfirmedShe, 0, where);
              assert.equal(body.creditConfirmedShe, 0, where);
              assert.equal(body.sentShe, 0, where);
              assert.equal((body.ledger || []).length, 0, where);
              assertNoPullKeys(body, MINER_BENIGN_PULL_KEYS, `${where} ${tag}`);
            }
          }
          const ghostTag = 'm00000000';
          assert.equal(dests.some((dest) => publicMinerTag(dest) === ghostTag), false, where);
          const ghost = await httpCall(`${base}/api/miners/${ghostTag}`);
          assertUnknownMiner(ghost, ghostTag, `${where} unknown miner`);
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
        assert.equal(Number(pool.store.tip().height) - heightBefore, POTS.length * 2, `n=${n} sealed blocks`);
        assert.equal(queued.length, 0, `n=${n} queueTx`);
      } finally {
        pool.close();
      }
    }
  });
});
