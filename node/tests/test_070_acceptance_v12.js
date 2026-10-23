/**
 * P0 070 acceptance. R5 crosses snap length, fork kind, share batch, dest
 * count, prune class, and the three book resume formats. R1 and R2 state a
 * height-independent bound. R3 refuses a tip-only snap as a genesis replay.
 * R4 is a source tripwire: a seed or reorg loop must not slice the prefix
 * once per height. One owedSeriesAll.slice per seed is the allowed shape.
 *
 * Bounds (do not grow with height or with fork depth):
 *   R1 wall < 5000 ms, lag < 2000 ms, max < min * 4 + 250. The tallest wall
 *   stays under heightRatio/16 of the short wall. Depth 8 stays under 4x
 *   depth 1 (a cost linear in depth fails).
 *   R2 wall < 2000 ms, lag < 2000 ms, same factor and slack, at depth 1.
 * Fork depths for the R1 rows are 1, 4, and 8.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { MAGIC_TESTNET, MAX_SHARES_PER_BLOCK, SAMPLE_PRUNE_CONFIRMATIONS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { writeChainBin } from '../../crypto/chainbin.js';
import { shouldPruneSamples } from '../../crypto/chronoflux.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  clearLiveSharePow,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
} from '../../crypto/share_batch.js';
import { decodeBookSnap, writeBookSnap } from '../src/book_snap.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { buildTemplate, retarget } from '../src/chain.js';
import { applyVerifiedIpcBlock } from '../src/p2p_ipc.js';
import { decodeWireBlock, encodeWireBlock, isFinalIngestFail, rejectUnprovenTipExtend } from '../src/p2p.js';
import { createStore, OWED_CHECKPOINT_SPACING } from '../src/store.js';
import { auditCirculatingSupply } from '../src/supply.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-070-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

const LENGTHS = [64, 1040, 2880, 2944];
const PRUNES = ['short', 'half', 'full'];
const BACKENDS = ['segments', 'chain.bin', 'chain.jsonl'];
const BATCHES = [4, 64, MAX_SHARES_PER_BLOCK - 1];
const DEST_COUNTS = [1, 3, 17];
const R1_WALL_MS = 5000;
const R1_LAG_MS = 2000;
const R2_WALL_MS = 2000;
const R2_LAG_MS = 2000;
const FLAT_FACTOR = 4;
const FLAT_SLACK_MS = 250;
const FORK_DEPTHS = [1, 4, 8];
const HEIGHT_PROPORTIONAL = 16;

const dirs = [];

function phase(event, extra = {}) {
  console.log(JSON.stringify({ event, t: new Date().toISOString(), ...extra }));
}

function keepDir(dir) {
  dirs.push(dir);
  return dir;
}

function scratchDir(tag) {
  return keepDir(fs.mkdtempSync(path.join(os.tmpdir(), tag)));
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function powTag(n) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((n >>> 0) || 1, 4);
  return h;
}

function openStore(dir, pruneAfter) {
  return createStore(dir, { pruneAfter, reorgHaltDepth: 8 });
}

function sealNext(store, dest, pow, shares = null) {
  const tip = store.tip();
  const now = tip
    ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000
    : 1_700_000_000_000;
  const parent = tip?.header || null;
  const batch = shares || [];
  if (batch.length && parent) {
    for (const share of batch) {
      rememberLiveSharePow(parent, share.nonce, {
        noteCommit: noteCommitOfShare(share),
        shareBits: share.shareBits,
        lz: share.lz,
      });
    }
  }
  const { tpl } = store.template({ miner: dest, now, shareBatch: batch });
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: pow, skipSharePow: true });
}

function grow(store, dest, n, tagBase) {
  for (let i = 0; i < n; i += 1) {
    const got = sealNext(store, dest, powTag(tagBase + i + 1));
    if (!got.ok) return got;
  }
  return { ok: true, height: store.tip().height };
}

function shareRow(dest, low, header, bits = SHARE_FLOOR_BITS) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    verifiedHeader: header,
  };
}

function forkBlock(store, dest, parentIndex, pow, shares = []) {
  const prefix = store.blocks.slice(0, parentIndex + 1);
  const prev = prefix[prefix.length - 1];
  const now = Number(decodeHeader(Buffer.from(prev.header)).timestamp) + 90_000;
  const bits = retarget(prefix, now);
  if (shares.length) {
    for (const share of shares) {
      rememberLiveSharePow(prev.header, share.nonce, {
        noteCommit: noteCommitOfShare(share),
        shareBits: share.shareBits,
        lz: share.lz,
      });
    }
  }
  const tpl = buildTemplate({
    prev: prev.hash,
    prevHeader: prev.header,
    prevBlock: prev,
    height: Number(prev.height) + 1,
    miner: dest,
    now,
    bits,
    shareBatch: shares,
    parentBlocks: prefix,
    parentFluxset: store.fluxThrough(parentIndex),
  });
  const headerBits = decodeHeader(Buffer.from(tpl.header)).bits;
  assert.equal(meetsTarget(pow, headerBits), true);
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    hash: pow,
    height: Number(prev.height) + 1,
    weight: tpl.weight,
    bSpendIds: [],
    bits: headerBits,
  };
}

function greaterHash(tipHash, bits) {
  const h = Buffer.from(tipHash);
  for (let i = h.length - 1; i >= 0; i -= 1) {
    if (h[i] >= 255) continue;
    h[i] += 1;
    if (meetsTarget(h, bits) && h.toString('hex') > Buffer.from(tipHash).toString('hex')) return h;
    h[i] -= 1;
  }
  throw new Error('no greater meeting hash');
}

function lesserHash(tipHash, bits) {
  const h = Buffer.from(tipHash);
  for (let i = h.length - 1; i >= 0; i -= 1) {
    if (h[i] === 0) continue;
    h[i] -= 1;
    if (meetsTarget(h, bits) && h.toString('hex') < Buffer.from(tipHash).toString('hex')) return h;
    h[i] += 1;
  }
  throw new Error('no lesser meeting hash');
}

function heavier(store, dest, parentIndex, count, tagBase) {
  const out = [];
  let prevBlocks = store.blocks.slice(0, parentIndex + 1);
  let prev = prevBlocks[prevBlocks.length - 1];
  let now = Number(decodeHeader(Buffer.from(prev.header)).timestamp) + 90_000;
  for (let i = 0; i < count; i += 1) {
    const bits = retarget(prevBlocks, now);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits,
      parentBlocks: prevBlocks,
    });
    const pow = powTag(tagBase + i + 1);
    assert.equal(meetsTarget(pow, decodeHeader(Buffer.from(tpl.header)).bits), true);
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      hash: pow,
      height: Number(prev.height) + 1,
      weight: tpl.weight,
      bSpendIds: [],
    };
    out.push(block);
    prev = block;
    prevBlocks = prevBlocks.concat([block]);
    now += 90_000;
  }
  return out;
}

function gapAdvances(length, depth = 1) {
  const anchor = length - 1 - depth;
  let best = -1;
  for (let at = 0; at <= anchor; at += 1) {
    const keep = at === 0 || ((at + 1) % OWED_CHECKPOINT_SPACING) === 0;
    if (keep && at >= best) best = at;
  }
  return anchor - best;
}

function snapStats(store) {
  const s = store.owedSeedStats();
  return {
    forkAdvances: s.forkAdvances,
    suffixAdvances: s.suffixAdvances,
    loadBlocks: s.loadBlocks,
    forkGenesis: s.forkGenesis,
  };
}

function assertOwedStill(before, after, label) {
  assert.equal(after.forkAdvances, before.forkAdvances, `${label} forkAdvances`);
  assert.equal(after.suffixAdvances, before.suffixAdvances, `${label} suffixAdvances`);
  assert.equal(after.loadBlocks, before.loadBlocks, `${label} loadBlocks`);
  assert.equal(after.forkGenesis, before.forkGenesis, `${label} forkGenesis`);
  assert.equal(after.forkGenesis, 0, label);
}

async function settleHeap() {
  // One collection misses memory that becomes garbage on the first pass
  // (the previous backend's near-cap side holds). The pause then lands
  // inside timed(), where lag tracks wall. Caps are unchanged.
  await new Promise((resolve) => setImmediate(resolve));
  if (typeof global.gc !== 'function') return;
  global.gc();
  await new Promise((resolve) => setImmediate(resolve));
  global.gc();
}

async function timed(fn) {
  let maxLag = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const slip = now - last - 40;
    if (slip > maxLag) maxLag = slip;
    last = now;
  }, 40);
  const t0 = performance.now();
  let result;
  try {
    result = await Promise.resolve(fn());
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 50));
    clearInterval(timer);
  }
  return { result, wall: performance.now() - t0, maxLag };
}

function canonOf(store) {
  const view = store.owedView();
  const supply = auditCirculatingSupply(store.blocks);
  assert.equal(supply.status, 'verified', supply.reason || 'supply');
  return JSON.stringify({
    rows: view.rows.map((r) => ({
      nc: Buffer.from(r.noteCommit).toString('hex'),
      d: Buffer.from(r.dest20).toString('hex'),
      b: Buffer.from(r.admitBase).toString('hex'),
      n: String(r.nanos),
      s: r.sinceHeight,
    })).sort((a, b) => (a.nc + a.s).localeCompare(b.nc + b.s)),
    series: view.series.map(String),
    supply: String(supply.circulatingNanos),
    height: store.blocks.length,
    tip: Buffer.from(store.tip().hash).toString('hex'),
  });
}

function cloneBook(src) {
  const dest = scratchDir('shear-070-');
  fs.cpSync(src, dest, { recursive: true });
  const key = fs.readFileSync(bookSealKeyPath(src));
  const to = bookSealKeyPath(dest);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, key);
  return dest;
}

function fileDiskDigest(filePath) {
  const h = createHash('sha256');
  h.update('bookdisk1');
  const buf = fs.readFileSync(filePath);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(buf.length >>> 0, 0);
  h.update(n);
  h.update(buf);
  return h.digest('hex');
}

function retargetSnap(dir, digestHex) {
  const key = fs.readFileSync(bookSealKeyPath(dir));
  const snapPath = path.join(dir, 'book.snap');
  const state = decodeBookSnap(fs.readFileSync(snapPath), key);
  assert.ok(state, 'snap decode');
  state.diskDigest = digestHex;
  writeBookSnap(snapPath, key, state);
}

function blockLine(block) {
  const copy = {
    ...block,
    header: Buffer.from(block.header).toString('hex'),
    hash: Buffer.from(block.hash).toString('hex'),
  };
  return JSON.stringify(copy, function replacer(k, v) {
    if (typeof v === 'bigint') throw new Error(`jsonl bigint ${k}`);
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
      return { type: 'Buffer', data: Array.from(v) };
    }
    return v;
  });
}

function writeJsonl(dir, blocks) {
  const file = path.join(dir, 'chain.jsonl');
  const fd = fs.openSync(file, 'w');
  try {
    for (const block of blocks) fs.writeSync(fd, `${blockLine(block)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function toBackend(dir, kind, pruneAfter) {
  if (kind === 'segments') return;
  const store = openStore(dir, pruneAfter);
  assert.equal(store.loadMode, 'snap', `${kind} convert load`);
  if (kind === 'chain.bin') {
    writeChainBin(path.join(dir, 'chain.bin'), store.blocks);
    fs.rmSync(path.join(dir, 'segments'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'chain.jsonl'), { force: true });
    retargetSnap(dir, fileDiskDigest(path.join(dir, 'chain.bin')));
    return;
  }
  writeJsonl(dir, store.blocks);
  fs.rmSync(path.join(dir, 'segments'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'chain.bin'), { force: true });
  retargetSnap(dir, fileDiskDigest(path.join(dir, 'chain.jsonl')));
}

function assertBackendFiles(dir, kind) {
  const seg = fs.existsSync(path.join(dir, 'segments'));
  const bin = fs.existsSync(path.join(dir, 'chain.bin'));
  const jsonl = fs.existsSync(path.join(dir, 'chain.jsonl'));
  if (kind === 'segments') {
    assert.equal(seg, true);
    return;
  }
  if (kind === 'chain.bin') {
    assert.equal(seg, false);
    assert.equal(bin, true);
    assert.equal(jsonl, false);
    return;
  }
  assert.equal(seg, false);
  assert.equal(bin, false);
  assert.equal(jsonl, true);
  const line = fs.readFileSync(path.join(dir, 'chain.jsonl'), 'utf8').split('\n')[0];
  const row = JSON.parse(line);
  assert.equal(typeof row.header, 'string');
  assert.ok(row.header.length > 32, 'jsonl header is hex, not a slim index');
}

function pruneDepthFor(kind, nextLen) {
  const floor = SAMPLE_PRUNE_CONFIRMATIONS;
  if (kind === 'full') return floor;
  if (kind === 'half') return Math.max(floor, Math.floor(nextLen / 2));
  return Math.max(floor, nextLen - 40);
}

function tipTemplate(store, dest) {
  const tip = store.tip();
  const now = Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000;
  const { tpl } = store.template({ miner: dest, now, shareBatch: [] });
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hash: Buffer.alloc(32),
    height: Number(tip.height) + 1,
  };
}

function withHeader(block, header) {
  return { ...block, header: Buffer.from(header) };
}

function flipVersion(block) {
  const header = Buffer.from(block.header);
  header.writeUInt32LE(99, 0);
  return withHeader(block, header);
}

function flipPrev(block, prevHash) {
  const header = Buffer.from(block.header);
  Buffer.from(prevHash).copy(header, 4);
  return withHeader(block, header);
}

function ipcMsg(block) {
  return {
    type: 'ipc_block',
    magic: MAGIC_TESTNET,
    powHash: Buffer.alloc(32, 0x11).toString('hex'),
    block: encodeWireBlock(block),
  };
}

function assertFlat(rows, label, wallCap, lagCap, proportional) {
  assert.equal(rows.length, LENGTHS.length, `${label} bands`);
  const walls = rows.map((row) => row.wall);
  const maxWall = Math.max(...walls);
  const minWall = Math.min(...walls);
  assert.ok(maxWall < wallCap, `${label} wall ${maxWall}`);
  assert.ok(maxWall < minWall * FLAT_FACTOR + FLAT_SLACK_MS, `${label} grew ${minWall} -> ${maxWall}`);
  if (proportional) {
    const short = rows[0];
    const tall = rows[rows.length - 1];
    const ratio = tall.n / short.n;
    assert.ok(ratio > 8, `${label} height ratio`);
    assert.ok(
      tall.wall * HEIGHT_PROPORTIONAL < ratio * Math.max(short.wall, 1),
      `${label} proportional ${tall.wall} vs ${short.wall} over ${ratio}`,
    );
  }
  for (const row of rows) {
    assert.ok(row.wall < wallCap, `${label} wall ${row.wall} at ${row.n}`);
    assert.ok(row.lag < lagCap, `${label} lag ${row.lag} at ${row.n}`);
  }
}

function assertDepthFlat(rows, label) {
  const deepDepth = FORK_DEPTHS[FORK_DEPTHS.length - 1];
  const shallowDepth = FORK_DEPTHS[0];
  for (const n of LENGTHS) {
    const at = rows.filter((row) => row.n === n);
    assert.equal(at.length, FORK_DEPTHS.length, `${label} depths at ${n}`);
    const shallow = at.find((row) => row.depth === shallowDepth);
    const deep = at.find((row) => row.depth === deepDepth);
    const ratio = deep.depth / shallow.depth;
    assert.ok(ratio >= 8, `${label} depth ratio`);
    assert.ok(
      deep.wall * 2 < ratio * Math.max(shallow.wall, 1) + FLAT_SLACK_MS,
      `${label} depth-proportional wall ${deep.wall} vs ${shallow.wall} over ${ratio} at ${n}`,
    );
    assert.ok(
      deep.lag * 2 < ratio * Math.max(shallow.lag, 1) + FLAT_SLACK_MS,
      `${label} depth-proportional lag ${deep.lag} vs ${shallow.lag} over ${ratio} at ${n}`,
    );
  }
}

async function assertTipOnly(dir, dest, pruneAfter, label) {
  tipOnlySnap(dir);
  const store = openStore(dir, pruneAfter);
  const loaded = store.owedSeedStats().loadBlocks;
  const n = store.blocks.length;
  assert.equal(store.loadMode, 'snap', label);
  assert.equal(store.owedSeedStats().forkGenesis, 0);
  if (loaded !== 0) assert.equal(loaded, n, label);
  const before = snapStats(store);
  const parent = n - 2;
  const probe = forkBlock(store, dest, parent, Buffer.alloc(32));
  const lose = greaterHash(Buffer.from(store.tip().hash), probe.bits);
  const got = await Promise.resolve(store.ingest(
    [forkBlock(store, dest, parent, lose)],
    { trustBlockHash: true, skipSharePow: true },
  ));
  const after = snapStats(store);
  const advances = after.forkAdvances - before.forkAdvances;
  assert.equal(after.forkGenesis, 0, label);
  assert.ok(advances < n / 2, `${label} re-paid ${advances} of ${n}`);
  assert.notEqual(advances, n);
  if (got.reason === 'owed_checkpoint') assert.equal(advances, 0);
  else {
    assert.equal(got.reason, 'side_hold', `${label} ${got.reason}`);
    assert.ok(advances <= OWED_CHECKPOINT_SPACING);
  }
  const again = openStore(dir, pruneAfter);
  assert.equal(again.loadMode, 'snap', label);
  assert.equal(again.owedSeedStats().loadBlocks, 0, label);
  assert.equal(again.owedSeedStats().forkGenesis, 0, label);
  return { loadBlocks: loaded, reason: got.reason, advances };
}

function functionBody(src, name) {
  const key = `function ${name}`;
  const at = src.indexOf(key);
  assert.ok(at >= 0, name);
  const brace = src.indexOf('{', at);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function braceBody(src, braceAt) {
  let depth = 0;
  for (let i = braceAt; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(braceAt + 1, i);
    }
  }
  throw new Error('unclosed for');
}

function assertNoPerHeightSlice(fnSrc, name) {
  const re = /for\s*\(([^)]*)\)\s*\{/g;
  let m = re.exec(fnSrc);
  while (m) {
    const head = m[1];
    const letM = /(?:let|var)\s+([A-Za-z_][\w]*)/.exec(head);
    const index = letM ? letM[1] : null;
    const body = braceBody(fnSrc, m.index + m[0].length - 1);
    assert.doesNotMatch(body, /\.slice\(\s*0\s*,\s*i\s*(?:\+\s*\d+)?\s*\)/, `${name} slice i`);
    assert.doesNotMatch(body, /\.slice\(\s*0\s*,\s*hi\s*(?:\+\s*\d+)?\s*\)/, `${name} slice hi`);
    assert.doesNotMatch(
      body,
      /accepted(?:Series)?\.slice\(\s*0\s*,\s*i\s*(?:\+\s*\d+)?\s*\)/,
      `${name} accepted.slice i`,
    );
    if (index) {
      const sliced = new RegExp(`\\.slice\\(\\s*0\\s*,\\s*${index}\\s*(?:\\+\\s*\\d+)?\\s*\\)`);
      assert.doesNotMatch(body, sliced, `${name} slice ${index}`);
    }
    m = re.exec(fnSrc);
  }
}

function tipOnlySnap(dir) {
  const key = fs.readFileSync(bookSealKeyPath(dir));
  const snapPath = path.join(dir, 'book.snap');
  const state = decodeBookSnap(fs.readFileSync(snapPath), key);
  assert.ok(state && Array.isArray(state.owedCheckpoints) && state.owedCheckpoints.length > 1);
  const tip = state.owedCheckpoints[state.owedCheckpoints.length - 1];
  assert.equal(tip.at, state.height - 1);
  assert.equal(tip.seriesEnd, state.height);
  state.owedCheckpoints = [tip];
  writeBookSnap(snapPath, key, state);
}

function assertCheckpoints(store) {
  const cps = store.owedView().checkpoints;
  assert.ok(cps.length >= 2);
  assert.equal(cps[0].at, 0);
  assert.equal(cps[cps.length - 1].at, store.blocks.length - 1);
  let prev = -1;
  for (const c of cps) {
    assert.ok(c.at > prev);
    assert.ok(c.at - prev <= OWED_CHECKPOINT_SPACING, `gap ${c.at - prev}`);
    prev = c.at;
  }
}

describe('v12 070 acceptance spread', { concurrency: false }, () => {
  it('R4 seed and reorg loops do not slice the prefix per height', () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const names = [
      'seedHistory',
      'verifySuffix',
      'verifySuffixBody',
      'stageOrAdopt',
      'finishAdopt',
      'stageAdoptVault',
      'vaultAfter',
      'vaultThrough',
    ];
    for (const name of names) assertNoPerHeightSlice(functionBody(src, name), name);
    const seed = functionBody(src, 'seedHistory');
    assert.equal((seed.match(/owedSeriesAll\.slice/g) || []).length, 1);
    assert.doesNotMatch(seed, /replayHashOwed/);
    const suffix = functionBody(src, 'verifySuffix');
    assert.match(suffix, /gateForkHeaders/);
    assert.doesNotMatch(suffix, /seedHistory/);
    const gate = functionBody(src, 'gateOneHeader');
    assert.match(gate, /assessHeader/);
    const body = functionBody(src, 'verifySuffixBody');
    assert.match(body, /seedHistory/);
    assert.match(body, /vaultThrough/);
    assert.doesNotMatch(body, /replayHashOwed/);
  });

  it('P3 invalid-PoW tip-extend hits the header target before any hash compare', { timeout: 180_000 }, async () => {
    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    const gateAt = src.indexOf('const extendsTip = fork.length === 1 && blockExtendsTip(store, fork[0])');
    assert.ok(gateAt >= 0, 'extendsTip gate');
    const ifAt = src.indexOf('if (!extendsTip)', gateAt);
    const haveAt = src.indexOf('const haveNow = new Set', gateAt);
    assert.ok(ifAt > gateAt && haveAt > ifAt, 'haveNow follows the tip-extend gate');
    const gated = braceBody(src, src.indexOf('{', ifAt));
    assert.match(gated, /haveNow/);
    assert.doesNotMatch(gated, /rejectUnprovenTipExtend/);
    const jobAt = src.indexOf('const job = scheduleP2pVerify', haveAt);
    const jobEnd = src.indexOf('job.then', jobAt);
    const job = src.slice(jobAt, jobEnd);
    assert.match(job, /store\.ingest\(fork,\s*\{\s*offLoopPow: true/);
    // The header target runs inside store.append, so every off-loop caller
    // is gated before the claimed hash meets the book, not only this job.
    const storeSrc = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const appendKey = 'function append(block, verifyOpts = {}) {';
    const appendAt = storeSrc.indexOf(appendKey);
    assert.ok(appendAt >= 0, 'store append');
    const appendSrc = braceBody(storeSrc, appendAt + appendKey.length - 1);
    const gateCall = appendSrc.indexOf('tipExtendPowReason(block)');
    const reasonAt = appendSrc.indexOf('if (gate.reason)', gateCall);
    const provenAt = appendSrc.indexOf('appendProven(block, verifyOpts)', reasonAt);
    assert.ok(gateCall >= 0 && reasonAt > gateCall && provenAt > reasonAt);
    assert.doesNotMatch(appendSrc, /not_heavier/);
    const provenKey = 'function appendProven(block, verifyOpts) {';
    const provenFnAt = storeSrc.indexOf(provenKey);
    assert.ok(provenFnAt > appendAt, 'appendProven');
    assert.match(braceBody(storeSrc, provenFnAt + provenKey.length - 1), /not_heavier/);

    const dest = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-070-p3-'));
    try {
      const store = createStore(dir, { pruneAfter: 1_000_000, reorgHaltDepth: 8 });
      const grew = grow(store, dest, 4, 70_000);
      assert.equal(grew.ok, true, grew.reason);
      const tipHex = Buffer.from(store.tip().hash).toString('hex');
      const sibling = flipPrev(tipTemplate(store, dest), Buffer.alloc(32, 0x22));
      let scans = 0;
      const rawBlocks = store.blocks;
      store.blocks = new Proxy(rawBlocks, {
        get(target, prop, receiver) {
          if (
            prop === 'map'
            || prop === 'forEach'
            || prop === 'filter'
            || prop === 'slice'
            || prop === 'find'
            || prop === 'some'
            || prop === Symbol.iterator
          ) scans += 1;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const side = await rejectUnprovenTipExtend(store, sibling);
      assert.equal(side.applies, false);
      assert.equal(scans, 0);
      const before = snapStats(store);
      const collide = tipTemplate(store, dest);
      collide.hash = Buffer.from(store.tip().hash);
      const got = await rejectUnprovenTipExtend(store, collide);
      assert.equal(got.applies, true);
      assert.equal(got.reason, 'pow', got.reason);
      assert.notEqual(got.reason, 'not_heavier');
      assert.equal(scans, 0, `book scan ${scans}`);
      assertOwedStill(before, snapStats(store), 'tip-extend pow');
      assert.equal(Buffer.from(store.tip().hash).toString('hex'), tipHex);
      const viaIngest = await store.ingest([collide], { offLoopPow: true });
      assert.equal(viaIngest.ok, false);
      assert.equal(viaIngest.reason, 'pow', viaIngest.reason);
      assert.equal(scans, 0, `book scan via ingest ${scans}`);
      assertOwedStill(before, snapStats(store), 'tip-extend pow via ingest');
      assert.equal(Buffer.from(store.tip().hash).toString('hex'), tipHex);
      // samplesPruned is a wire field. It does not skip the header target.
      const prunedCollide = { ...tipTemplate(store, dest), samplesPruned: true };
      prunedCollide.hash = Buffer.from(store.tip().hash);
      const viaPruned = await store.ingest([prunedCollide], { offLoopPow: true });
      assert.equal(viaPruned.ok, false);
      assert.equal(viaPruned.reason, 'pow', viaPruned.reason);
      assert.notEqual(viaPruned.reason, 'not_heavier');
      assert.equal(isFinalIngestFail(viaPruned.reason), true);
      assert.equal(scans, 0, `book scan via pruned ingest ${scans}`);
      assertOwedStill(before, snapStats(store), 'tip-extend pruned pow');
      assert.equal(Buffer.from(store.tip().hash).toString('hex'), tipHex);
      const flipped = flipVersion(tipTemplate(store, dest));
      flipped.hash = Buffer.from(store.tip().hash);
      const ver = await rejectUnprovenTipExtend(store, flipped);
      assert.equal(ver.applies, true);
      assert.equal(ver.reason, 'version', ver.reason);
      assert.equal(scans, 0, `book scan after version ${scans}`);
      assertOwedStill(before, snapStats(store), 'tip-extend version');
      assert.equal(Buffer.from(store.tip().hash).toString('hex'), tipHex);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R5 spread proves R1-R3 and full-replay parity', { timeout: 28_800_000 }, async () => {
    const executed = {
      lengths: new Set(),
      prunes: new Set(),
      backends: new Set(),
      forks: new Set(),
      batches: new Set(),
      dests: new Set(),
      batchCells: 0,
      powRejects: { ipc: 0, tcp: 0, suffix: 0 },
      cheapRules: 0,
      r3: [],
    };
    const r1 = [];
    const r2 = [];
    const pruneCounts = new Map();
    try {
      for (const n of LENGTHS) {
        phase('build_start', { n });
        const dest = minerDest();
        const destPool = Array.from({ length: 17 }, () => minerDest());
        const builtDir = scratchDir(`shear-070-build-${n}-`);
        const built = createStore(builtDir, { pruneAfter: 1_000_000 });
        const tBuild = performance.now();
        const grew = grow(built, dest, n, 10_000 + n);
        assert.equal(grew.ok, true, grew.reason);
        built.flushBookSnap();
        phase('build_done', { n, ms: Math.round(performance.now() - tBuild), height: built.tip().height });
        const builtLoad = openStore(builtDir, 1_000_000);
        assert.equal(builtLoad.loadMode, 'snap');
        assert.equal(builtLoad.owedSeedStats().forkGenesis, 0);
        assert.equal(builtLoad.owedSeedStats().loadBlocks, 0);
        assertCheckpoints(builtLoad);

        const r3Dir = cloneBook(builtDir);
        const r3Result = await assertTipOnly(r3Dir, dest, 1_000_000, `r3 ${n}`);
        executed.r3.push({ n, backend: 'segments', ...r3Result });
        phase('r3', executed.r3[executed.r3.length - 1]);

        const counts = {};
        for (const prune of PRUNES) {
          const nextLen = n + 1;
          const depth = pruneDepthFor(prune, nextLen);
          const prunedDir = cloneBook(builtDir);
          const pruning = openStore(prunedDir, depth);
          assert.equal(pruning.loadMode, 'snap');
          const sealed = sealNext(pruning, dest, powTag(800_000 + n + PRUNES.indexOf(prune)));
          assert.equal(sealed.ok, true, sealed.reason);
          pruning.flushBookSnap();
          const tipH = Number(pruning.tip().height);
          let want = 0;
          for (const block of pruning.blocks) {
            if (shouldPruneSamples(block.height, tipH, depth)) want += 1;
          }
          const pruned = pruning.blocks.filter((block) => block.samplesPruned === true).length;
          assert.equal(pruned, want, `${prune} @ ${n} depth ${depth}`);
          counts[prune] = { pruned, depth, tipH };
          phase('pruned', { n, prune, ...counts[prune] });

          const backendDir = { segments: prunedDir };
          for (const backend of BACKENDS) {
            if (backend !== 'segments') {
              backendDir[backend] = cloneBook(prunedDir);
              toBackend(backendDir[backend], backend, depth);
            }
            assertBackendFiles(backendDir[backend], backend);
          }

          const canons = {};
          for (const backend of BACKENDS) {
            const dir = backendDir[backend];
            const store = openStore(dir, depth);
            assert.equal(store.loadMode, 'snap', `${backend} ${prune} ${n}`);
            assert.equal(store.owedSeedStats().forkGenesis, 0);
            assert.equal(store.owedSeedStats().loadBlocks, 0);
            assertCheckpoints(store);
            // The previous backend's near-cap side holds are garbage now.
            // Collect them outside the fork timer so a pause is not R1 or R2.
            await settleHeap();
            executed.lengths.add(n);
            executed.prunes.add(prune);
            executed.backends.add(backend);

            const tipHash = Buffer.from(store.tip().hash);
            for (const forkDepth of FORK_DEPTHS) {
              const timedParent = store.blocks.length - 1 - forkDepth;
              assert.equal(store.blocks.length - 1 - timedParent, forkDepth);
              const timedProbe = forkBlock(store, dest, timedParent, Buffer.alloc(32));
              const losePow = greaterHash(tipHash, timedProbe.bits);
              const loseBlock = forkBlock(store, dest, timedParent, losePow);
              // forkBlock and any deferred collection are outside the R1 clock.
              await settleHeap();
              const beforeLose = snapStats(store);
              const lose = await timed(() => store.ingest(
                [loseBlock],
                { trustBlockHash: true, skipSharePow: true },
              ));
              assert.equal(lose.result.reason, 'side_hold', lose.result.reason);
              assert.equal(Buffer.from(store.tip().hash).toString('hex'), tipHash.toString('hex'));
              const afterLose = snapStats(store);
              const adv = afterLose.forkAdvances - beforeLose.forkAdvances;
              assert.equal(afterLose.forkGenesis, 0);
              assert.equal(adv, gapAdvances(store.blocks.length, forkDepth));
              assert.ok(adv <= OWED_CHECKPOINT_SPACING);
              assert.ok(adv < store.blocks.length / 2);
              assert.ok(lose.wall < R1_WALL_MS, `R1 wall ${lose.wall} ${n} ${prune} ${backend} d${forkDepth}`);
              assert.ok(lose.maxLag < R1_LAG_MS, `R1 lag ${lose.maxLag} ${n} ${prune} ${backend} d${forkDepth}`);
              r1.push({
                n,
                prune,
                backend,
                depth: forkDepth,
                wall: Math.round(lose.wall),
                lag: Math.round(lose.maxLag),
                advances: adv,
              });
              executed.forks.add('side_hold');
              phase('r1_cell', r1[r1.length - 1]);
            }

            const parent = store.blocks.length - 2;
            const probe = forkBlock(store, dest, parent, Buffer.alloc(32));
            let loseCursor = greaterHash(tipHash, probe.bits);
            // A deferred collection of the previous backend's near-cap side
            // hold is not an R2 cost. The 2000 ms cap stays.
            await settleHeap();
            const ipcBase = tipTemplate(store, dest);
            const ipcBefore = snapStats(store);
            const ipcPow = await timed(() => applyVerifiedIpcBlock(store, ipcMsg(ipcBase)));
            assert.equal(ipcPow.result.reason, 'pow', ipcPow.result.reason);
            assertOwedStill(ipcBefore, snapStats(store), 'ipc pow');
            assert.ok(ipcPow.wall < R2_WALL_MS, `ipc pow wall ${ipcPow.wall}`);
            assert.ok(ipcPow.maxLag < R2_LAG_MS, `ipc pow lag ${ipcPow.maxLag}`);
            executed.powRejects.ipc += 1;

            const ipcVerBefore = snapStats(store);
            const ipcVer = await timed(() => applyVerifiedIpcBlock(store, ipcMsg(flipVersion(tipTemplate(store, dest)))));
            assert.equal(ipcVer.result.reason, 'version', ipcVer.result.reason);
            assertOwedStill(ipcVerBefore, snapStats(store), 'ipc version');
            assert.ok(ipcVer.wall < R2_WALL_MS);
            executed.cheapRules += 1;

            const ipcPrevBefore = snapStats(store);
            const ipcPrev = await timed(() => applyVerifiedIpcBlock(
              store,
              ipcMsg(flipPrev(tipTemplate(store, dest), store.blocks[0].hash)),
            ));
            assert.equal(ipcPrev.result.reason, 'prev', ipcPrev.result.reason);
            assertOwedStill(ipcPrevBefore, snapStats(store), 'ipc prev');
            assert.ok(ipcPrev.wall < R2_WALL_MS);
            executed.cheapRules += 1;

            await settleHeap();
            const side = forkBlock(store, dest, parent, Buffer.alloc(32));
            const tcpBefore = snapStats(store);
            const tcpPow = await timed(() => store.ingest(
              [decodeWireBlock(encodeWireBlock(side))],
              { offLoopPow: true },
            ));
            assert.equal(tcpPow.result.reason, 'pow', tcpPow.result.reason);
            assertOwedStill(tcpBefore, snapStats(store), 'tcp pow');
            assert.ok(tcpPow.wall < R2_WALL_MS, `tcp pow wall ${tcpPow.wall}`);
            assert.ok(tcpPow.maxLag < R2_LAG_MS, `tcp pow lag ${tcpPow.maxLag}`);
            executed.powRejects.tcp += 1;

            const tcpVerBefore = snapStats(store);
            const tcpVer = await timed(() => store.ingest(
              [decodeWireBlock(encodeWireBlock(flipVersion(side)))],
              { offLoopPow: true },
            ));
            assert.equal(tcpVer.result.reason, 'version', tcpVer.result.reason);
            assertOwedStill(tcpVerBefore, snapStats(store), 'tcp version');
            assert.ok(tcpVer.wall < R2_WALL_MS);
            executed.cheapRules += 1;

            await settleHeap();
            const suffixBefore = snapStats(store);
            const suffixPow = await timed(() => store.ingest([side]));
            assert.equal(suffixPow.result.reason, 'pow', suffixPow.result.reason);
            assertOwedStill(suffixBefore, snapStats(store), 'suffix pow');
            assert.ok(suffixPow.wall < R2_WALL_MS, `suffix pow wall ${suffixPow.wall}`);
            assert.ok(suffixPow.maxLag < R2_LAG_MS, `suffix pow lag ${suffixPow.maxLag}`);
            executed.powRejects.suffix += 1;
            r2.push({
              n,
              prune,
              backend,
              wall: Math.round(suffixPow.wall),
              lag: Math.round(suffixPow.maxLag),
              ipcWall: Math.round(ipcPow.wall),
              tcpWall: Math.round(tcpPow.wall),
            });

            const suffixVerBefore = snapStats(store);
            const badHeight = { ...side, height: 1 };
            const suffixVer = await timed(() => store.ingest([badHeight]));
            assert.equal(suffixVer.result.reason, 'height', suffixVer.result.reason);
            assertOwedStill(suffixVerBefore, snapStats(store), 'suffix height');
            assert.ok(suffixVer.wall < R2_WALL_MS);
            executed.cheapRules += 1;
            phase('r2_cell', r2[r2.length - 1]);

            for (const shares of BATCHES) {
              for (const destCount of DEST_COUNTS) {
                if (shares > 1000) phase('near_cap_start', { n, prune, backend, destCount, shares });
                clearLiveSharePow();
                const batchDests = destPool.slice(0, destCount);
                const parentHeader = Buffer.from(store.blocks[parent].header);
                const batch = [];
                for (let i = 0; i < shares; i += 1) {
                  batch.push(shareRow(batchDests[i % destCount], BigInt(i + 1 + shares), parentHeader));
                }
                loseCursor = greaterHash(loseCursor, probe.bits);
                const shareBlock = forkBlock(store, dest, parent, loseCursor, batch);
                assert.ok(shareBlock.shareBatch.length > shares / 2, `batch ${shareBlock.shareBatch.length} of ${shares}`);
                if (shares > 1000) assert.ok(shareBlock.shareBatch.length > 1000);
                assert.ok((store.tip().shareBatch || []).length < 8);
                const batchBefore = snapStats(store);
                const got = await Promise.resolve(store.ingest([shareBlock], {
                  trustBlockHash: true,
                  skipSharePow: true,
                }));
                assert.equal(got.reason, 'side_hold', got.reason);
                const batchAfter = snapStats(store);
                assert.equal(batchAfter.forkGenesis, 0);
                assert.ok(batchAfter.forkAdvances - batchBefore.forkAdvances <= OWED_CHECKPOINT_SPACING);
                assert.equal(Buffer.from(store.tip().hash).toString('hex'), tipHash.toString('hex'));
                executed.batches.add(shares);
                executed.dests.add(destCount);
                executed.batchCells += 1;
                clearLiveSharePow();
              }
            }
            phase('batches_done', { n, prune, backend, cells: executed.batchCells });

            const winParent = store.blocks.length - 2;
            const winProbe = forkBlock(store, dest, winParent, Buffer.alloc(32));
            const winPow = lesserHash(Buffer.from(store.tip().hash), winProbe.bits);
            const winBlock = forkBlock(store, dest, winParent, winPow);
            const win = await Promise.resolve(store.ingest([winBlock], { trustBlockHash: true, skipSharePow: true }));
            assert.equal(win.ok, true, win.reason);
            assert.equal(store.owedSeedStats().forkGenesis, 0);
            executed.forks.add('winning_side');

            const shallowParent = store.blocks.length - 1 - 3;
            const shallow = heavier(store, dest, shallowParent, 4, 1_100_000 + n * 10 + PRUNES.indexOf(prune));
            const shallowGot = await Promise.resolve(store.ingest(shallow, { trustBlockHash: true, skipSharePow: true }));
            assert.equal(shallowGot.ok, true, shallowGot.reason);
            assert.notEqual(shallowGot.reason, 'reorg_checkpoint');
            assert.equal(store.owedSeedStats().forkGenesis, 0);
            executed.forks.add('shallow');

            const haltParent = store.blocks.length - 1 - 7;
            const near = heavier(store, dest, haltParent, 8, 1_300_000 + n * 10 + PRUNES.indexOf(prune));
            const nearGot = await Promise.resolve(store.ingest(near, { trustBlockHash: true, skipSharePow: true }));
            assert.equal(nearGot.ok, true, nearGot.reason);
            assert.notEqual(nearGot.reason, 'reorg_halt');
            assert.notEqual(nearGot.reason, 'reorg_checkpoint');
            assert.equal(store.owedSeedStats().forkGenesis, 0);
            executed.forks.add('near_halt');
            canons[backend] = canonOf(store);
            phase('reorg_done', { n, prune, backend, height: store.blocks.length });
          }

          assert.equal(canons['chain.bin'], canons.segments, `bin canon ${n} ${prune}`);
          assert.equal(canons['chain.jsonl'], canons.segments, `jsonl canon ${n} ${prune}`);
          phase('full_replay_start', { n, prune });
          fs.rmSync(path.join(prunedDir, 'book.snap'), { force: true });
          const full = openStore(prunedDir, depth);
          assert.equal(full.loadMode, 'full');
          assert.equal(full.owedSeedStats().forkGenesis, 0);
          assert.equal(canonOf(full), canons.segments);
          phase('full_replay_done', { n, prune, height: full.blocks.length });
          for (const backend of BACKENDS) {
            if (backend === 'segments') continue;
            fs.rmSync(backendDir[backend], { recursive: true, force: true });
          }
          fs.rmSync(prunedDir, { recursive: true, force: true });
        }
        if (counts.full.tipH > 2000) {
          assert.ok(counts.short.pruned < counts.half.pruned, `short ${counts.short.pruned} half ${counts.half.pruned}`);
          assert.ok(counts.half.pruned < counts.full.pruned, `half ${counts.half.pruned} full ${counts.full.pruned}`);
        } else {
          assert.ok(counts.short.pruned <= counts.half.pruned);
          assert.ok(counts.half.pruned <= counts.full.pruned);
        }
        pruneCounts.set(n, counts);
        if (n === LENGTHS[LENGTHS.length - 1]) {
          const jsonDir = cloneBook(builtDir);
          toBackend(jsonDir, 'chain.jsonl', 1_000_000);
          const jsonR3 = await assertTipOnly(jsonDir, dest, 1_000_000, `r3 jsonl ${n}`);
          executed.r3.push({ n, backend: 'chain.jsonl', ...jsonR3 });
          phase('r3', executed.r3[executed.r3.length - 1]);
        }
        fs.rmSync(builtDir, { recursive: true, force: true });
        phase('length_done', { n, counts });
      }
    } finally {
      for (const dir of dirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already removed */ }
      }
    }

    const stores = LENGTHS.length * PRUNES.length * BACKENDS.length;
    assert.equal(executed.batchCells, stores * BATCHES.length * DEST_COUNTS.length);
    assert.equal(executed.powRejects.ipc, stores);
    assert.equal(executed.powRejects.tcp, stores);
    assert.equal(executed.powRejects.suffix, stores);
    assert.ok(executed.cheapRules >= stores * 3);
    assert.equal(executed.r3.length, LENGTHS.length + 1);
    for (const n of LENGTHS) assert.ok(executed.lengths.has(n));
    for (const prune of PRUNES) assert.ok(executed.prunes.has(prune));
    for (const backend of BACKENDS) assert.ok(executed.backends.has(backend));
    for (const fork of ['side_hold', 'winning_side', 'shallow', 'near_halt']) assert.ok(executed.forks.has(fork));
    for (const shares of BATCHES) assert.ok(executed.batches.has(shares));
    for (const destCount of DEST_COUNTS) assert.ok(executed.dests.has(destCount));
    assert.ok(LENGTHS.some((n) => n < 200));
    assert.ok(LENGTHS.some((n) => n >= 1000 && n < 2000));
    assert.ok(LENGTHS.some((n) => n >= 2800 && n <= 2920));
    assert.ok(LENGTHS.some((n) => n > 2920));

    for (const prune of PRUNES) {
      for (const backend of BACKENDS) {
        for (const depth of FORK_DEPTHS) {
          const series = r1
            .filter((row) => row.prune === prune && row.backend === backend && row.depth === depth)
            .sort((a, b) => a.n - b.n);
          assertFlat(series, `R1 d${depth} ${prune} ${backend}`, R1_WALL_MS, R1_LAG_MS, true);
        }
        assertDepthFlat(
          r1.filter((row) => row.prune === prune && row.backend === backend),
          `R1 ${prune} ${backend}`,
        );
        const pow = r2.filter((row) => row.prune === prune && row.backend === backend);
        assertFlat(pow, `R2 ${prune} ${backend}`, R2_WALL_MS, R2_LAG_MS, false);
      }
    }
    const table = r1.filter((row) => row.prune === 'full' && row.backend === 'segments');
    console.log(JSON.stringify({
      event: 'r1_timing_table',
      forkDepths: FORK_DEPTHS,
      bound: {
        wallMs: R1_WALL_MS,
        lagMs: R1_LAG_MS,
        factor: FLAT_FACTOR,
        slackMs: FLAT_SLACK_MS,
        heightProportional: HEIGHT_PROPORTIONAL,
        forkDepths: FORK_DEPTHS,
      },
      rows: table,
      all: r1,
      r2: r2.filter((row) => row.prune === 'full' && row.backend === 'segments'),
      r2Bound: { wallMs: R2_WALL_MS, lagMs: R2_LAG_MS, factor: FLAT_FACTOR, slackMs: FLAT_SLACK_MS },
      pruneCounts: Object.fromEntries([...pruneCounts].map(([n, counts]) => [n, counts])),
      r3: executed.r3,
      batchCells: executed.batchCells,
    }));
  });
});
