/**
 * PSA-pr74-2 and the 052 gaps.
 *
 * A pruned block stays buried under the proven-work header chain that buried
 * it. Its sealed credit root stands for the share batch. Archive, fast-sync,
 * bootstrap, and restarted nodes therefore adopt the same depth-1000 +/- k
 * reorg. The archive hold only restores the body on commit.
 *
 * A peer serves a pruned block only when its own tip buries it, or whole from
 * its hold. A node that is behind proves that burial from the headers page
 * (P2P) or the ipc_headers run (IPC) before the block's credits count. A
 * short run, a bad link, or a header whose hash is not its ShearHash leaves
 * the block samples_pruned: a missing batch never mints.
 *
 * Chain: archive A grows to 1448. Credited blocks at 17, 384, 415, 416, 417,
 * and 448. 1401..1448 are emergency-eased late blocks. A 16-block on-time
 * fork from 1400 (the reorg floor) wins, so the new tip is 1416 and those
 * credited blocks sit at depth 1399, 1032, 1001, 1000, 999, and 968:
 * k = 399, 32, 1 above 1000, k = 0, and k = 1, 32 below it.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { applyBlockToFluxset } from '../../crypto/admit.js';
import {
  ASERT_EMERGENCY_GAP_FACTOR,
  SAMPLE_PRUNE_CONFIRMATIONS,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
} from '../../crypto/asert.js';
import { readChainBin, writeChainBin } from '../../crypto/chainbin.js';
import { shouldPruneSamples } from '../../crypto/chronoflux.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { shearHash } from '../../crypto/shear_hash.js';
import {
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  clearLiveSharePow,
} from '../../crypto/share_batch.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import { latestPaths, reorgBreaksCheckpoint } from '../src/bootstrap.js';
import { settledHeight } from '../src/burial_hold.js';
import { buildTemplate, chainLoadSeal, chainWorkOf, retarget, retargetQuote } from '../src/chain.js';
import { decodeWireBlock, encodeWireBlock, selectHeadersAfterLocator } from '../src/p2p.js';
import { applyVerifiedIpcBlock, ipcBlockFrames } from '../src/p2p_ipc.js';
import { createStore } from '../src/store.js';

const PRUNE = SAMPLE_PRUNE_CONFIRMATIONS;
const STEP = TARGET_BLOCK_INTERVAL_MS;
// The 11-block median lags the tip by six gaps, and six must fit inside MTP_FUTURE_MS.
const LATE = Math.floor(ASERT_EMERGENCY_GAP_FACTOR * STEP * 1.5);
const FLOOR = 1400;
const OLD_TIP = 1448;
const FORK = 16;
const NEW_TIP = FLOOR + FORK;
const CREDITED = [17, 384, 415, 416, 417, 448];

let powTag = 1;
function easyPow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag >>> 0, 4);
  powTag += 1;
  return h;
}

function hex(b) {
  return Buffer.from(b).toString('hex');
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function shareAt(dest, low) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, SHARE_FLOOR_BITS),
    lz: SHARE_FLOOR_BITS,
    shareBits: SHARE_FLOOR_BITS,
    creditedShareBits: SHARE_FLOOR_BITS,
  };
}

function bodyOf(tpl, dest, extra = {}) {
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
    ...extra,
  };
}

function sealNext(store, dest, share = null) {
  const tip = store.tip();
  const now = tip ? headerTime(tip) + STEP : 1_700_000_000_000;
  if (share && tip?.header) {
    share.verifiedHeader = tip.header;
    rememberLiveSharePow(tip.header, share.nonce, {
      noteCommit: noteCommitOfShare(share),
      shareBits: share.shareBits,
      lz: share.lz,
    });
  }
  const { tpl } = store.template({
    miner: dest,
    now,
    shareBits: SHARE_FLOOR_BITS,
    shareBatch: share ? [share] : [],
  });
  return store.append(bodyOf(tpl, dest), { trustedPowHash: easyPow(), skipSharePow: true });
}

function sealLate(store, dest) {
  const tip = store.tip();
  const now = headerTime(tip) + LATE;
  const quote = retargetQuote(store.blocks, now);
  assert.equal(quote.ok, true, quote.reason);
  assert.ok(quote.easeBits > 0, 'late tail did not ease');
  const tpl = buildTemplate({
    prev: tip.hash,
    prevHeader: tip.header,
    prevBlock: tip,
    height: tip.height + 1,
    miner: dest,
    now,
    bits: quote.eased,
    parentBlocks: store.blocks,
    parentFluxset: store.fluxset(),
  });
  return store.append(bodyOf(tpl, dest), { trustedPowHash: easyPow(), skipSharePow: true });
}

function forkBlocks(store, dest, parentIndex, count) {
  const prefix = store.blocks.slice(0, parentIndex + 1);
  let flux = store.fluxThrough(parentIndex);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const chain = prefix.concat(out);
    const prev = chain[chain.length - 1];
    const now = headerTime(prev) + STEP;
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits: retarget(chain, now),
      parentBlocks: chain,
      parentFluxset: flux,
    });
    const block = bodyOf(tpl, dest, { hash: easyPow(), height: Number(prev.height) + 1, bSpendIds: [] });
    out.push(block);
    flux = applyBlockToFluxset(flux, block);
  }
  return out;
}

function wire(block) {
  return decodeWireBlock(JSON.parse(JSON.stringify(encodeWireBlock(block))));
}

function ingest(store, block, opts = {}) {
  return Promise.resolve(store.ingest([block], {
    trustBlockHash: true,
    skipSharePow: true,
    nowMs: Date.now(),
    ...opts,
  }));
}

function canonJson(value) {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data).toString('hex');
    if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
    return v;
  });
}

function owedCanon(view) {
  return JSON.stringify({
    rows: view.rows.map((r) => ({
      nc: hex(r.noteCommit),
      d: hex(r.dest20),
      b: hex(r.admitBase),
      n: String(r.nanos),
      s: r.sinceHeight,
    })).sort((a, b) => (a.nc + a.s).localeCompare(b.nc + b.s)),
    series: view.series.map(String),
  });
}

function stateOf(store) {
  const t = store.tip();
  return {
    height: t.height,
    hash: hex(t.hash),
    supply: canonJson(store.supplyState()),
    owed: owedCanon(store.owedView()),
  };
}

function installBootstrap(fromDir, destDir) {
  const image = readChainBin(latestPaths(fromDir).bin);
  fs.mkdirSync(destDir, { recursive: true });
  writeChainBin(path.join(destDir, 'chain.bin'), image);
  fs.writeFileSync(path.join(destDir, 'book.seal'), `${chainLoadSeal(image, bookSealKeyFor(destDir))}\n`);
  return image;
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `shear-proof-${tag}-`));
}

const net = {};

describe('v12 proven burial', () => {
  before(async () => {
    clearLiveSharePow();
    net.dest = minerDest();
    net.dirs = { A: tmp('archive'), B: tmp('fast'), D: tmp('restart'), C: tmp('boot') };
    net.A = createStore(net.dirs.A);
    net.B = createStore(net.dirs.B, { fastSync: true });
    let D = createStore(net.dirs.D, { fastSync: true });
    let low = 11n;
    for (let height = 1; height <= OLD_TIP; height += 1) {
      const late = height > FLOOR;
      const share = CREDITED.includes(height) ? shareAt(net.dest, low) : null;
      if (share) low += 1n;
      const got = late ? sealLate(net.A, net.dest) : sealNext(net.A, net.dest, share);
      assert.equal(got.ok, true, `${got.reason} at ${height}`);
      if (share) assert.equal(net.A.tip().shareBatch.length, 1, `credited ${height}`);
      const sent = wire(net.A.tip());
      for (const follower of [net.B, D]) {
        const took = await ingest(follower, sent);
        assert.equal(took.ok, true, `${took.reason} following ${height}`);
      }
      if (height % 200 === 0) process.stderr.write(`proof-grow ${height}\n`);
    }
    // D restarts before the reorg. The others stay live.
    net.D = createStore(net.dirs.D, { fastSync: true });
    D = null;
    net.image = installBootstrap(net.dirs.A, net.dirs.C);
    net.C = createStore(net.dirs.C, { fastSync: true });
    net.preReorg = net.A.blocks.slice();
    net.fork = forkBlocks(net.A, net.dest, FLOOR - 1, FORK);
  });

  it('builds a reorg that only proven burial can adopt', () => {
    const { A, B, C, D } = net;
    for (const s of [A, B, C, D]) {
      assert.equal(s.tip().height, OLD_TIP);
      assert.equal(hex(s.tip().hash), hex(A.tip().hash));
    }
    assert.equal(net.image.length, OLD_TIP);
    assert.equal(C.loadMode, 'full');
    const newChain = net.preReorg.slice(0, FLOOR).concat(net.fork);
    const oldWork = chainWorkOf(net.preReorg);
    assert.ok(chainWorkOf(newChain) > oldWork, 'the fork must win on work');
    net.adoptAt = net.fork.findIndex((_b, i) => chainWorkOf(newChain.slice(0, FLOOR + i + 1)) > oldWork);
    assert.ok(net.adoptAt >= 0);
    for (const h of CREDITED) {
      for (const s of [A, B, C, D]) {
        const b = s.blocks[h - 1];
        assert.equal(b.samplesPruned, true, `pruned at ${h}`);
        assert.ok(shouldPruneSamples(h, s.provenBurialTip(b) ?? OLD_TIP));
      }
    }
    const depths = CREDITED.map((h) => NEW_TIP - h);
    assert.deepEqual(depths, [1399, 1032, 1001, 1000, 999, 968]);
    // Bounded hold on the archive: every block at or below 400 is settled.
    const view = A.burialView();
    assert.equal(view.settled, settledHeight(OLD_TIP));
    assert.equal(view.settled, 400);
    assert.deepEqual(view.heldHeights, Array.from({ length: 48 }, (_, i) => 401 + i));
    assert.deepEqual(view.provenHeights, view.heldHeights);
    assert.equal(fs.readdirSync(path.join(net.dirs.A, 'burial-hold')).length, 48);
    for (const s of [B, C, D]) {
      assert.equal(s.burialView().held, 0, 'fast-sync and bootstrap hold no body');
      assert.equal(fs.existsSync(path.join(s === B ? net.dirs.B : (s === C ? net.dirs.C : net.dirs.D), 'burial-hold')), false);
      assert.deepEqual(s.burialView().provenHeights, view.provenHeights);
    }
  });

  it('archive, fast-sync, bootstrap, and restarted nodes adopt the same depth 1000 +/- k reorg', async () => {
    const nodes = { A: net.A, B: net.B, C: net.C, D: net.D };
    for (let i = 0; i < net.fork.length; i += 1) {
      const answers = {};
      for (const [name, s] of Object.entries(nodes)) {
        const got = await ingest(s, wire(net.fork[i]));
        answers[name] = got.ok ? 'ok' : got.reason;
      }
      const want = i >= net.adoptAt ? 'ok' : 'side_hold';
      assert.deepEqual(answers, { A: want, B: want, C: want, D: want }, `fork block ${i + 1}`);
    }
    const want = stateOf(net.A);
    assert.equal(want.height, NEW_TIP);
    assert.equal(want.hash, hex(net.fork[net.fork.length - 1].hash));
    for (const [name, s] of Object.entries(nodes)) {
      assert.deepEqual(stateOf(s), want, `node ${name}`);
      for (const h of CREDITED) {
        const b = s.blocks[h - 1];
        const buried = shouldPruneSamples(h, NEW_TIP);
        if (name === 'A' && !buried) {
          assert.notEqual(b.samplesPruned, true, `archive lifts ${h}`);
          assert.equal(b.shareBatch.length, 1, `archive batch at ${h}`);
        } else {
          assert.equal(b.samplesPruned, true, `${name} keeps ${h} pruned`);
          assert.equal((b.shareBatch || []).length, 0);
          assert.ok(buried || s.provenBurialTip(b) >= h + PRUNE, `${name} proven ${h}`);
        }
      }
    }
    // k = 0, 1, 32 under 1000 and 1, 32 over it are in this reorg. k = 399:
    // block 17 stays buried, and its hold and proof are settled away.
    assert.equal(net.A.burialView().heldHeights.includes(17), false);
    assert.equal(net.A.provenBurialTip(net.A.blocks[16]), null);
    assert.equal(shouldPruneSamples(17, NEW_TIP), true);
    // Un-burying a block 399 below the line needs a fork 400 below the old
    // tip. The reorg floor refuses that before any burial is read.
    const deep = net.preReorg.slice(0, OLD_TIP - 400).concat(net.fork.slice(0, 1));
    const broken = reorgBreaksCheckpoint(net.preReorg, deep, { first: 1000, every: 400 });
    assert.deepEqual(broken, { height: FLOOR, hash: hex(net.preReorg[FLOOR - 1].hash) });
    net.postReorg = want;
  });

  it('restarted nodes keep the reorg, from the snap and from a full replay', () => {
    const want = net.postReorg;
    const opts = { A: {}, B: { fastSync: true }, C: { fastSync: true }, D: { fastSync: true } };
    for (const name of Object.keys(opts)) {
      const again = createStore(net.dirs[name], opts[name]);
      assert.deepEqual(stateOf(again), want, `reload ${name}`);
      fs.rmSync(path.join(net.dirs[name], 'book.snap'), { force: true });
      const replay = createStore(net.dirs[name], opts[name]);
      assert.equal(replay.loadMode, 'full');
      assert.deepEqual(stateOf(replay), want, `full replay ${name}`);
      net[name] = replay;
    }
  });

  it('a node behind syncs every gap, proving each pruned block from the headers page', async () => {
    const { A, B } = net;
    const target = A.tip().height;
    let dirE = tmp('gap');
    let E = createStore(dirE, { fastSync: true });
    const gaps = new Set();
    const tally = { pruned: 0, full: 0, nak: 0, restarted: false };
    for (let t = 0; t < target; t = E.tip().height) {
      let served = null;
      let from = null;
      for (const server of [B, A]) {
        const b = server.servableBlock(server.blocks[t]);
        if (b) {
          served = b;
          from = server;
          break;
        }
        tally.nak += 1;
        assert.equal(server, B, 'only the fast-sync peer misses');
        assert.equal(shouldPruneSamples(t + 1, B.tip().height), false);
      }
      assert.ok(served, `no peer serves ${t + 1}`);
      const gap = from.tip().height - t;
      gaps.add(gap);
      if (served.samplesPruned === true) {
        assert.ok(gap >= PRUNE + 1, `pruned at gap ${gap}`);
        tally.pruned += 1;
      } else {
        tally.full += 1;
      }
      const page = selectHeadersAfterLocator(from.blocks, { locator: t ? [hex(E.tip().hash)] : [] });
      E.offerHeaders(page);
      const got = await ingest(E, wire(served));
      assert.equal(got.ok, true, `${got.reason} at ${t + 1}, gap ${gap}`);
      if (t + 1 === 300) {
        // Every block so far is pruned and none is buried by this tip.
        E = createStore(dirE, { fastSync: true });
        assert.equal(E.tip().height, 300);
        fs.rmSync(path.join(dirE, 'book.snap'), { force: true });
        E = createStore(dirE, { fastSync: true });
        assert.equal(E.loadMode, 'full');
        tally.restarted = true;
      }
    }
    for (let g = 1; g <= target; g += 1) assert.ok(gaps.has(g), `gap ${g}`);
    assert.equal(tally.pruned, 416);
    assert.equal(tally.nak, 32);
    assert.equal(tally.restarted, true);
    assert.deepEqual(stateOf(E), net.postReorg);
    assert.ok(E.burialView().offered <= 6000);
    process.stderr.write(`${JSON.stringify({ gapSync: tally, gaps: gaps.size })}\n`);
    net.dirE = dirE;
  });

  it('a pruned block without a full proven run is samples_pruned and mints nothing', async () => {
    const { B } = net;
    const first = wire(B.servableBlock(B.blocks[0]));
    assert.equal(first.samplesPruned, true);
    const page = selectHeadersAfterLocator(B.blocks, { locator: [] });

    const bare = createStore(tmp('bare'), { fastSync: true });
    const none = await ingest(bare, first);
    assert.equal(none.reason, 'samples_pruned');

    const short = createStore(tmp('short'), { fastSync: true });
    short.offerHeaders(page.filter((r) => r.height <= PRUNE));
    const shortGot = await ingest(short, first);
    assert.equal(shortGot.reason, 'samples_pruned', 'h + 999 headers');
    short.offerHeaders(page);
    const longGot = await ingest(short, first);
    assert.equal(longGot.ok, true, longGot.reason || 'h + 1000 headers');

    const rewound = createStore(tmp('rewound'), { fastSync: true });
    const bent = page.map((r) => {
      if (r.height !== 501) return r;
      const d = decodeHeader(Buffer.from(r.header, 'hex'));
      const parent = decodeHeader(Buffer.from(page.find((p) => p.height === 500).header, 'hex'));
      return { ...r, header: encodeHeader({ ...d, timestamp: parent.timestamp }).toString('hex') };
    });
    assert.equal(rewound.offerHeaders(bent).dropped, true, 'a rewound link drops the peer at offer time');
    const bentGot = await ingest(rewound, first);
    assert.equal(bentGot.reason, 'samples_pruned', 'a rewound header breaks the run');

    // No trusted hash: each header is ShearHashed, and these stand-ins are not.
    const unhashed = createStore(tmp('pow'), { fastSync: true });
    unhashed.offerHeaders(page);
    const powGot = await ingest(unhashed, first, { trustBlockHash: false, trustedPowHash: first.hash });
    assert.equal(powGot.reason, 'samples_pruned', 'bad header proof-of-work');

    for (const s of [bare, rewound, unhashed]) assert.equal(s.tip(), null, 'nothing minted');
    assert.equal(short.tip().height, 1);
  });

  it('IPC sends the burial headers before a pruned block and the store decides', async () => {
    const { A, B } = net;
    const frames = ipcBlockFrames(B, [B.blocks[0], B.blocks[1]]);
    assert.deepEqual(frames.map((f) => f.type), ['ipc_headers', 'ipc_block', 'ipc_headers', 'ipc_block']);
    assert.equal(frames[0].headers.length, PRUNE + 1, 'the run starts at the pruned block itself');
    assert.equal(frames[0].headers[0].height, 1);
    assert.equal(frames[0].headers[PRUNE].height, PRUNE + 1);
    assert.equal(frames[2].headers.length, 1, 'the next run only adds what is missing');
    assert.equal(frames[2].headers[0].height, PRUNE + 2);
    assert.deepEqual(ipcBlockFrames(B, [B.blocks[416]]), [], 'fast-sync does not send an unburied pruned block');
    const whole = ipcBlockFrames(A, [A.blocks[416]]);
    assert.deepEqual(whole.map((f) => f.type), ['ipc_block']);
    assert.equal(whole[0].block.samplesPruned, false);

    // Each case offers the run, then sends the pruned block, on its own store.
    async function sendRun(name, headers, block) {
      const pool = createStore(tmp(name), { fastSync: true });
      assert.equal(pool.offerHeaders(headers, { peer: 'ipc' }).accepted, PRUNE + 1);
      assert.equal(pool.burialView().offered, PRUNE + 1);
      return { pool, got: await applyVerifiedIpcBlock(pool, block) };
    }
    const [runFrame, blockFrame] = frames.slice(0, 2).map((f) => JSON.parse(JSON.stringify(f)));

    // As sent: the block's id is the run's first id, a stand-in that is not its
    // ShearHash. PR 130's claim check refuses it before any burial work.
    const sent = await sendRun('ipc-sent', runFrame.headers, blockFrame);
    assert.equal(sent.got.ok, false);
    assert.equal(sent.got.reason, 'hash_claim');
    assert.equal(sent.pool.tip(), null);

    // An honest-looking run: every header links to the one before by its real
    // ShearHash and claims its own ShearHash, so nothing is refused at offer or
    // as hash_claim. None of these headers is mined, so none meets its target.
    // The store has to hash the run to judge the burial: it refuses it, clears
    // the run, and drops the peer that sent it. IPC never trusts a hash.
    const headers = [];
    let prev = null;
    for (const row of runFrame.headers) {
      const decoded = decodeHeader(Buffer.from(row.header, 'hex'));
      const header = prev ? encodeHeader({ ...decoded, prevBlockHash: prev }) : Buffer.from(row.header, 'hex');
      const hash = shearHash(header);
      headers.push({ ...row, header: header.toString('hex'), hash: hash.toString('hex') });
      prev = hash;
    }
    const real = headers[0].hash;
    assert.equal(blockFrame.block.header, headers[0].header, 'the run starts at the pruned block');
    const block = { ...blockFrame, powHash: real, block: { ...blockFrame.block, hash: real } };
    const judged = await sendRun('ipc-judged', headers, block);
    assert.equal(judged.got.ok, false);
    assert.equal(judged.got.reason, 'samples_pruned');
    assert.equal(judged.pool.tip(), null);
    assert.equal(judged.pool.burialView().offered, 0);
    assert.equal(judged.pool.offerPeerDropped('ipc'), true);

    const src = fs.readFileSync(new URL('../src/p2p_ipc.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /shouldPruneSamples\(structuralH/);
    const p2pSrc = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    assert.match(p2pSrc, /store\.offerHeaders\(page, \{\s*peer: /);
    assert.match(p2pSrc, /store\.servableBlock\(job\.block\)/);
  });
});
