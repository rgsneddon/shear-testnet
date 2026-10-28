// Two-node pruned sync over the real P2P transport.
// Headers and shares are ShearHash. Regtest bits keep the header target small.
// Floor shares stay at 8 bits: that search is the slow part. jit-full is about
// 2.5ms per hash here, so a floor share is well under a second. Two lanes
// each pin a 2GiB dataset and this VM does not have that free, so one lane
// runs the search. R39 (28 Oct): a block carries at most MAX_SHARES_PER_BLOCK
// = 256 shares, so the near count is a full block at the cap, far above the
// mid count, and every
// hash is findShare / mineHeaderParallel. No claimed digest is passed through.
// Share search is a child process. jit-full is process-global, and a worker
// left in this process makes the header lanes about 5x slower.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeDest } from '../../crypto/address.js';
import { decodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import {
  MAGIC_TESTNET,
  MAX_SHARES_PER_BLOCK,
  SAMPLE_PRUNE_CONFIRMATIONS,
} from '../../crypto/asert.js';
import { createP2p, encodeWireBlock, decodeWireBlock, fingerprintHelloHash } from '../src/p2p.js';
import { applyVerifiedIpcBlock, attachPoolIpc } from '../src/p2p_ipc.js';
import { pullNextHttpBlock } from '../src/http_follow.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { createRpc } from '../src/rpc.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

try { setHashBackend('jit'); } catch { /* interpreter still hashes */ }

const PRUNE = SAMPLE_PRUNE_CONFIRMATIONS;
const TIP_H = PRUNE * 3 + 16;
const GAPS = [1, 999, 1000, 1001, PRUNE * 3];
const SHARE_ONE = 1;
const SHARE_MID = 64;
const SHARE_NEAR = MAX_SHARES_PER_BLOCK;
const DEST_ONE = 1;
const DEST_MID = 3;
const DEST_NEAR = 17;
const T0 = 1_700_000_000_000;
const FORBIDDEN = new Set([30303, 18332, 30313, 1111]);
const LANE_N = 1;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-052-'));
const threads = Math.max(1, os.cpus().length);

const world = {
  miner: null,
  p2p: null,
  rpc: null,
  snaps: new Map(),
  tipHex: '',
  supply: '',
  audit: '',
  lanes: [],
};

function destAt(n) {
  const raw = Buffer.alloc(20, 0);
  raw.writeUInt32BE(n + 1, 0);
  return encodeDest(raw);
}

function tipHexOf(store) {
  const tip = store.tip();
  return tip?.hash ? Buffer.from(tip.hash).toString('hex') : '';
}

function blockAt(store, height) {
  return (store.blocks || []).find((b) => Number(b.height) === height) || null;
}

function headersFrom(store, from, to) {
  const out = [];
  for (const b of store.blocks || []) {
    const h = Number(b.height) || 0;
    if (h < from || h > to || !b.header || !b.hash) continue;
    out.push({
      header: Buffer.from(b.header).toString('hex'),
      hash: Buffer.from(b.hash).toString('hex'),
      height: h,
    });
  }
  return out;
}

function canon(value) {
  return JSON.stringify(value, (_, v) => {
    if (typeof v === 'bigint') return `n:${v.toString()}`;
    if (Buffer.isBuffer(v)) return `b:${v.toString('hex')}`;
    if (v instanceof Uint8Array) return `b:${Buffer.from(v).toString('hex')}`;
    return v;
  });
}

function supplyText(store) {
  return canon(store.supplyState());
}

function auditText(store) {
  return canon(auditCirculatingSupply(store.blocks, { magic: store.magic }));
}

function assertEphemeral(port) {
  assert.equal(FORBIDDEN.has(Number(port)), false, `bound reserved port ${port}`);
  assert.ok(Number(port) > 0);
}

function freshDir(label) {
  return fs.mkdtempSync(path.join(root, `${label}-`));
}

// book.seal is MAC'd with a key outside the datadir. A copy that mints its
// own key fails the snap and replays the whole chain.
function shareSealKey(src, dest) {
  const key = fs.readFileSync(bookSealKeyPath(src));
  if (key.length !== 32) throw new Error('seal_key');
  const file = bookSealKeyPath(dest);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
}

function copyStoreDir(src) {
  const dir = freshDir('copy');
  fs.cpSync(src, dir, { recursive: true });
  shareSealKey(src, dir);
  return dir;
}

function openCopy(src) {
  return createRegtestStore(copyStoreDir(src));
}

async function mineEmpty(store, dest) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : T0;
  const { tpl } = store.template({ miner: dest, now });
  const found = await mineHeaderParallel(tpl.header, tpl.bits, 16_384, threads);
  assert.ok(found && found.block, `header at ${store.tip()?.height || 0}`);
  const got = await Promise.resolve(store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }));
  assert.equal(got.ok, true, `${got.reason || 'append'} at ${store.tip()?.height || 0}`);
}

function startLanes() {
  const lanes = [];
  const script = fileURLToPath(new URL('./share_lane.mjs', import.meta.url));
  for (let i = 0; i < LANE_N; i += 1) {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
    const pending = new Map();
    let buf = '';
    const failAll = (err) => {
      for (const job of pending.values()) job.reject(err);
      pending.clear();
    };
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'progress') {
          console.log(`e2e share-progress id=${msg.id} ${msg.n}/${msg.count}`);
          continue;
        }
        const job = pending.get(msg.id);
        if (!job) continue;
        pending.delete(msg.id);
        if (msg.type === 'done') job.resolve(msg.shares || []);
        else job.reject(new Error(msg.reason || 'share_search'));
      }
    });
    child.on('error', failAll);
    child.on('exit', (code) => {
      if (pending.size) failAll(new Error(`share lane exit ${code}`));
    });
    const lane = {
      child,
      pending,
      queue: Promise.resolve(),
      run(job) {
        const task = this.queue.then(() => new Promise((resolve, reject) => {
          this.pending.set(job.id, { resolve, reject });
          this.child.stdin.write(`${JSON.stringify(job)}\n`);
        }));
        this.queue = task.then(() => {}, () => {});
        return task;
      },
    };
    lanes.push(lane);
  }
  return lanes;
}

let shareJobSeq = 1;

async function collectShares(lanes, header, specs) {
  const jobs = [];
  specs.forEach((spec, destIndex) => {
    const parts = Array(lanes.length).fill(0);
    for (let i = 0; i < spec.count; i += 1) parts[i % lanes.length] += 1;
    parts.forEach((count, lane) => {
      if (!count) return;
      jobs.push({
        type: 'find',
        id: shareJobSeq,
        lane,
        dest: spec.dest,
        count,
        startNonce: ((BigInt(destIndex + 1) << 36n) + (BigInt(lane) << 28n)).toString(),
        header: Buffer.from(header).toString('hex'),
      });
      shareJobSeq += 1;
    });
  });
  const batches = await Promise.all(jobs.map((job) => lanes[job.lane].run(job)));
  return batches.flat();
}

async function mineShareBlock(store, specs, lanes) {
  const parent = store.tip();
  assert.ok(parent, 'share block needs a parent');
  const now = Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000;
  const foundShares = await collectShares(lanes, parent.header, specs);
  const want = specs.reduce((n, spec) => n + spec.count, 0);
  assert.equal(foundShares.length, want);
  const rows = foundShares.map((s) => ({
    dest: s.dest,
    dest20: Buffer.from(s.dest20, 'hex'),
    nonce: BigInt(s.nonce),
    lz: s.lz,
    verifiedHeader: Buffer.from(parent.header),
  }));
  const miner = specs[0].dest;
  const { tpl } = store.template({ miner, shareBatch: rows, now });
  assert.equal((tpl.shareBatch || []).length, want);
  const found = await mineHeaderParallel(tpl.header, tpl.bits, 16_384, threads);
  assert.ok(found && found.block, 'share block header');
  const got = await Promise.resolve(store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }));
  assert.equal(got.ok, true, got.reason || 'share append');
  return want;
}

function snapAt(store, height) {
  if (!GAPS.some((gap) => TIP_H - gap === height)) return;
  const dir = freshDir(`h${height}`);
  fs.cpSync(store.dir, dir, { recursive: true });
  shareSealKey(store.dir, dir);
  world.snaps.set(height, dir);
  console.log(`e2e snapshot height=${height}`);
}

function sameBook(store) {
  assert.equal(store.blocks.length, world.miner.blocks.length);
  assert.equal(tipHexOf(store), world.tipHex);
  assert.equal(supplyText(store), world.supply);
  assert.equal(auditText(store), world.audit);
  const buried = blockAt(store, TIP_H - (PRUNE * 3) + 1);
  assert.equal(buried?.samplesPruned, true);
  assert.equal((buried?.shareBatch || []).length, 0);
}

async function syncStore(store, label, gap) {
  const p2p = createP2p({
    store,
    port: 0,
    host: '127.0.0.1',
    magic: store.magic,
  });
  const bound = await p2p.listen();
  assertEphemeral(bound.port);
  await p2p.connect('127.0.0.1', world.p2p.port, { pinned: true });
  let lastH = store.tip()?.height || 0;
  let lastMove = Date.now();
  const deadline = Date.now() + 90 * 60 * 1000;
  let matched = false;
  while (Date.now() < deadline) {
    const h = store.tip()?.height || 0;
    if (h !== lastH) {
      lastH = h;
      lastMove = Date.now();
      if (h % 200 === 0 || h === TIP_H) console.log(`e2e sync ${label} height=${h}/${TIP_H}`);
    }
    if (h === TIP_H && tipHexOf(store) === world.tipHex) {
      matched = true;
      break;
    }
    if (Date.now() - lastMove > 300_000) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  p2p.close();
  assert.equal(matched, true, `${label} stopped at ${store.tip()?.height || 0}`);
  sameBook(store);
  console.log(`e2e gap=${gap} label=${label} tip=${tipHexOf(store)} height=${TIP_H} supply=match`);
  return store;
}

function wireClone(block) {
  return decodeWireBlock(encodeWireBlock(block));
}

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function collectSock(sock) {
  const queue = [];
  const waiters = [];
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (waiters.length) waiters.shift()(msg);
      else queue.push(msg);
    }
  });
  return {
    next(ms) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('line_timeout')), ms);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    async until(pred, ms) {
      const seen = [];
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try {
          const msg = await this.next(end - Date.now());
          seen.push(msg);
          if (pred(msg)) return seen;
        } catch {
          break;
        }
      }
      return seen;
    },
  };
}

describe('pruned p2p e2e', { timeout: 21_600_000 }, () => {
  after(async () => {
    try { world.p2p?.close(); } catch { /* ignore */ }
    try { await world.rpc?.close(); } catch { /* ignore */ }
    for (const lane of world.lanes) {
      try { lane.child.kill(); } catch { /* ignore */ }
    }
    world.lanes = [];
    await closeMineWorkers();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('mines a real ShearHash chain past three prune depths', async () => {
    assert.equal(SHARE_ONE, 1);
    assert.ok(SHARE_MID > 1 && SHARE_MID < MAX_SHARES_PER_BLOCK);
    assert.ok(SHARE_NEAR > SHARE_MID && SHARE_NEAR === MAX_SHARES_PER_BLOCK);
    assert.equal(MAX_SHARES_PER_BLOCK, 256);
    assert.deepEqual(GAPS, [1, 999, 1000, 1001, 3000]);
    const dest = destAt(0);
    const dir = freshDir('miner');
    const store = createRegtestStore(dir, { bits: 4 });
    world.miner = store;
    const t0 = Date.now();
    while ((store.tip()?.height || 0) < TIP_H - (PRUNE * 3)) {
      await mineEmpty(store, dest);
      const h = store.tip().height;
      if (h % 4 === 0) snapAt(store, h);
    }
    assert.equal(store.tip().height, 16);
    snapAt(store, 16);
    world.lanes = startLanes();
    const plans = [
      { count: SHARE_ONE, dests: DEST_ONE },
      { count: SHARE_MID, dests: DEST_MID },
      { count: SHARE_NEAR, dests: DEST_NEAR },
    ];
    for (const plan of plans) {
      console.log(`e2e share-search start count=${plan.count} dests=${plan.dests}`);
      const specs = [];
      const base = plan.count % plan.dests;
      for (let d = 0; d < plan.dests; d += 1) {
        const count = Math.floor(plan.count / plan.dests) + (d < base ? 1 : 0);
        specs.push({ dest: destAt(100 + d + plan.dests), count });
      }
      const n = await mineShareBlock(store, specs, world.lanes);
      const h = store.tip().height;
      console.log(`e2e shares=${n} dests=${plan.dests} height=${h}`);
      snapAt(store, h);
    }
    for (const lane of world.lanes) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => lane.child.kill('SIGKILL'), 3000);
        lane.child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        lane.child.stdin.end();
      });
    }
    world.lanes = [];
    while ((store.tip()?.height || 0) < TIP_H) {
      await mineEmpty(store, dest);
      const h = store.tip().height;
      if (h % 100 === 0) {
        console.log(`e2e mine height=${h}/${TIP_H} elapsed_s=${Math.round((Date.now() - t0) / 1000)}`);
      }
      snapAt(store, h);
    }
    assert.equal(store.tip().height, TIP_H);
    for (const gap of GAPS) assert.ok(world.snaps.has(TIP_H - gap), `snapshot ${TIP_H - gap}`);
    const early = [17, 18, 19];
    for (const h of early) {
      const row = blockAt(store, h);
      assert.equal(row.samplesPruned, true, `height ${h} pruned`);
      assert.equal((row.shareBatch || []).length, 0);
    }
    world.tipHex = tipHexOf(store);
    world.supply = supplyText(store);
    world.audit = auditText(store);
    assert.ok(world.supply && world.supply !== 'null');
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: store.magic,
    });
    const bound = await p2p.listen();
    assertEphemeral(bound.port);
    world.p2p = p2p;
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const rpcBound = await rpc.listen();
    assertEphemeral(rpcBound.port);
    world.rpc = rpc;
    console.log(`e2e tip=${world.tipHex} height=${TIP_H} shares=1 dests=1 shares=${SHARE_MID} dests=${DEST_MID} shares=${SHARE_NEAR} dests=${DEST_NEAR} gaps=1,999,1000,1001,3000`);
    console.log(`e2e mine elapsed_s=${Math.round((Date.now() - t0) / 1000)}`);
  });

  for (const gap of GAPS) {
    it(`syncs gap ${gap} onto the miner tip`, async () => {
      const src = world.snaps.get(TIP_H - gap);
      assert.ok(src, `missing snapshot for gap ${gap}`);
      const store = openCopy(src);
      assert.equal(store.tip()?.height || 0, TIP_H - gap);
      await syncStore(store, `gap-${gap}`, gap);
    });
  }

  it('a restarted long-gap node reaches the same tip and supply', async () => {
    const src = world.snaps.get(TIP_H - 3000);
    const dir = copyStoreDir(src);
    const first = createRegtestStore(dir);
    assert.equal(first.tip().height, TIP_H - 3000);
    const restarted = createRegtestStore(dir);
    assert.equal(restarted.tip().height, TIP_H - 3000);
    await syncStore(restarted, 'restart-3000', 3000);
    console.log('e2e restart gap=3000 supply=match');
  });

  it('a fresh IBD node reaches the same tip and supply', async () => {
    const dir = freshDir('ibd');
    const empty = createRegtestStore(dir);
    assert.equal(empty.tip(), null);
    await syncStore(empty, 'ibd', TIP_H);
    console.log('e2e ibd gap=3016 supply=match');
  });

  it('a forged tip height does not bury a pruned body on the wire', async () => {
    const store = openCopy(world.snaps.get(16));
    assert.equal(store.tip().height, 16);
    const block = blockAt(world.miner, 17);
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: store.magic,
    });
    const bound = await p2p.listen();
    assertEphemeral(bound.port);
    const errors = [];
    const orig = console.error;
    console.error = (...args) => {
      errors.push(args.map((x) => String(x)).join(' '));
      orig(...args);
    };
    const sock = net.connect(bound.port, '127.0.0.1');
    const lines = collectSock(sock);
    try {
      await lines.until((m) => m.type === 'tip', 4000);
      sock.write(line({ type: 'hello', magic: store.magic, fingerprint: fingerprintHelloHash(store.magic) }));
      sock.write(line({
        type: 'tip',
        magic: store.magic,
        height: 9_000_000,
        hash: Buffer.from(block.hash).toString('hex'),
        work: '0x1',
      }));
      sock.write(line({
        type: 'block',
        magic: store.magic,
        tipHeight: 9_000_000,
        block: encodeWireBlock(block),
      }));
      const first = await lines.until((m) => m.type === 'getheaders', 8000);
      assert.ok(first.some((m) => m.type === 'getheaders'));
      const saw = await waitReason(errors, 'samples_pruned', 8000);
      assert.equal(saw, true);
      assert.equal(store.tip().height, 16);
      sock.write(line({
        type: 'headers',
        magic: store.magic,
        headers: headersFrom(world.miner, 17, 26),
      }));
      sock.write(line({
        type: 'block',
        magic: store.magic,
        tipHeight: 9_000_000,
        block: encodeWireBlock(block),
      }));
      const shortAgain = await waitReason(errors, 'samples_pruned', 8000, errors.length);
      assert.equal(shortAgain, true);
      assert.equal(store.tip().height, 16);
      sock.write(line({
        type: 'headers',
        magic: store.magic,
        headers: headersFrom(world.miner, 17, 17 + PRUNE),
      }));
      sock.write(line({
        type: 'block',
        magic: store.magic,
        tipHeight: 1,
        block: encodeWireBlock(block),
      }));
      const ok = await waitUntil(() => store.tip()?.height === 17, 180_000);
      assert.equal(ok, true);
      assert.equal(tipHexOf(store), Buffer.from(block.hash).toString('hex'));
      console.log('e2e wire samples_pruned then buried height=17');
    } finally {
      console.error = orig;
      sock.destroy();
      p2p.close();
    }
  });

  it('a forged tip height does not bury a pruned body on IPC', async () => {
    const store = openCopy(world.snaps.get(16));
    const block = blockAt(world.miner, 17);
    const frame = {
      type: 'ipc_block',
      magic: MAGIC_TESTNET,
      block: encodeWireBlock(block),
      powHash: Buffer.from(block.hash).toString('hex'),
      tipHeight: 9_000_000,
    };
    const direct = await Promise.resolve(applyVerifiedIpcBlock(store, frame));
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, 'samples_pruned');
    assert.equal(store.tip().height, 16);
    const pool = await attachPoolIpc({ store, port: 0 });
    assertEphemeral(pool.port);
    const errors = [];
    const orig = console.error;
    console.error = (...args) => {
      errors.push(args.map((x) => String(x)).join(' '));
      orig(...args);
    };
    const sock = net.connect(pool.port, '127.0.0.1');
    const lines = collectSock(sock);
    try {
      await lines.until((m) => m.type === 'ipc_hello', 4000);
      sock.write(line(frame));
      const asked = await lines.until((m) => m.type === 'ipc_getheaders', 8000);
      assert.ok(asked.some((m) => m.type === 'ipc_getheaders'));
      assert.equal(store.tip().height, 16);
      const beforeShort = errors.length;
      sock.write(line({
        type: 'ipc_headers',
        magic: MAGIC_TESTNET,
        headers: headersFrom(world.miner, 17, 26),
      }));
      const shortFail = await waitReason(errors, 'samples_pruned', 8000, beforeShort);
      assert.equal(shortFail, true);
      assert.equal(store.tip().height, 16);
      sock.write(line({
        type: 'ipc_headers',
        magic: MAGIC_TESTNET,
        headers: headersFrom(world.miner, 17, 17 + PRUNE),
      }));
      const ok = await waitUntil(() => store.tip()?.height === 17, 180_000);
      assert.equal(ok, true);
      assert.equal(tipHexOf(store), Buffer.from(block.hash).toString('hex'));
      console.log('e2e ipc samples_pruned then buried height=17');
    } finally {
      console.error = orig;
      sock.destroy();
      pool.close();
    }
  });

  it('append refuses a missing or short run and ignores tipHeight', async () => {
    const store = openCopy(world.snaps.get(16));
    const block = wireClone(blockAt(world.miner, 17));
    const none = await Promise.resolve(store.append(wireClone(blockAt(world.miner, 17)), {
      offLoopPow: true,
      tipHeight: 9_000_000,
    }));
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'samples_pruned');
    const noneAgain = await Promise.resolve(store.append(wireClone(blockAt(world.miner, 17)), {
      offLoopPow: true,
    }));
    assert.equal(noneAgain.reason, 'samples_pruned');
    assert.equal(store.tip().height, 16);
    const offeredShort = store.offerHeaders(headersFrom(world.miner, 17, 26), {
      peer: 'local',
      tier: 'pinned',
    });
    assert.ok(offeredShort.accepted > 0);
    const short = await Promise.resolve(store.append(wireClone(blockAt(world.miner, 17)), {
      offLoopPow: true,
      tipHeight: 9_000_000,
    }));
    assert.equal(short.ok, false);
    assert.equal(short.reason, 'samples_pruned');
    assert.equal(store.tip().height, 16);
    const page = headersFrom(world.miner, 17, 17 + PRUNE);
    assert.ok(page.filter((h) => h.height > 17).length >= PRUNE);
    const offered = store.offerHeaders(page, { peer: 'local', tier: 'pinned' });
    assert.ok(offered.accepted > 0);
    const buried = await Promise.resolve(store.append(block, {
      offLoopPow: true,
      tipHeight: 1,
    }));
    assert.equal(buried.ok, true, buried.reason);
    assert.equal(store.tip().height, 17);
    assert.equal(tipHexOf(store), Buffer.from(blockAt(world.miner, 17).hash).toString('hex'));
    console.log('e2e append samples_pruned then buried height=17');
  });

  it('HTTP follow fetches headers before a pruned body and ignores a forged tip', async () => {
    const store = openCopy(world.snaps.get(16));
    const block = blockAt(world.miner, 17);
    const wire = encodeWireBlock(block);
    const seen = [];
    const fetchImpl = async (url) => {
      const u = String(url);
      seen.push(u);
      const json = (body) => ({ ok: true, async text() { return JSON.stringify(body); } });
      if (u.endsWith('/stats')) return json({ magic: store.magic, height: 9_000_000 });
      if (u.includes('/block?')) return json({ ok: true, ...wire });
      if (u.includes('/headers') || u.includes('explorer/headers')) {
        return json({ ok: true, headers: headersFrom(world.miner, 17, 19) });
      }
      return { ok: false, async text() { return ''; } };
    };
    const first = await pullNextHttpBlock({
      store,
      magic: store.magic,
      seeds: ['http://127.0.0.1:9'],
      fetchImpl,
    });
    assert.equal(first, false);
    assert.equal(store.tip().height, 16);
    assert.ok(seen.some((u) => u.includes('/headers') || u.includes('explorer/headers')));
    const again = await pullNextHttpBlock({
      store,
      magic: store.magic,
      seeds: ['http://127.0.0.1:9'],
      fetchImpl,
    });
    assert.equal(again, false);
    assert.equal(store.tip().height, 16);
    const advanced = await pullNextHttpBlock({
      store,
      magic: store.magic,
      seeds: [`http://127.0.0.1:${world.rpc.port}`],
    });
    assert.equal(advanced, true);
    assert.equal(store.tip().height, 17);
    assert.equal(tipHexOf(store), Buffer.from(block.hash).toString('hex'));
    console.log('e2e http samples_pruned then buried height=17');
  });
});

async function waitUntil(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function waitReason(errors, reason, ms, from = 0) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (errors.slice(from).some((line) => line.includes(reason))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
