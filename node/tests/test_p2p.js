import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { encodeDest, newIdentity, freshStealthDest } from '../../crypto/address.js';
import { spendBox, admitSend } from '../../tests/spend_box.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { signSpendTx } from '../../crypto/spend.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  P2P_PORT,
  pickStemSocket,
  fluffDelayMs,
  FLUFF_MIN_MS,
  FLUFF_MAX_MS,
  STEM_MAX_HOPS,
  lineHasIpBesideIdentity,
  peerEventFields,
  isRoutablePeerAddr,
  createP2p,
  HEADERS_PAGE,
  GETBLOCK_BATCH,
  selectHeadersAfterLocator,
  locatorHashes,
} from '../src/p2p.js';
import { DEFAULT_SEEDS } from '../src/node.js';
import { mineTemplate } from '../src/chain.js';
import { printConfig, startNode } from '../src/node.js';
import { countSyncedOnline } from '../src/p2p.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 5));
}

function mineOne(store, dest, bits = 8) {
  const { tpl } = store.template({ miner: dest, bits, shareBits: bits });
  const found = mineTemplate({ ...tpl, bits }, { maxTries: 3_000_000, shareBits: bits });
  assert.ok(found && found.block, 'need pow');
  return store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
  });
}

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('p2p gossip', () => {
  it('two loopback nodes converge on the same most-work tip', async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      const mined = mineOne(a.store, dest);
      assert.equal(mined.ok, true, mined.reason);
      a.p2p.announce();
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const synced = await waitFor(() => {
        const ta = a.store.tip();
        const tb = b.store.tip();
        if (!ta || !tb) return false;
        return ta.height === tb.height
          && Buffer.from(ta.hash).equals(Buffer.from(tb.hash));
      });
      assert.equal(synced, true);
      assert.equal(a.store.tip().height, 1);
      assert.equal(b.store.tip().height, 1);
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
  });

  it('counts currently seen synced remotes, not historical uniques', () => {
    const local = 'abc';
    const live = [
      { remote: '1.1.1.1', hash: 'abc', id: 1 },
      { remote: '2.2.2.2', hash: 'abc', id: 2 },
      { remote: '3.3.3.3', hash: 'old', id: 3 },
    ];
    assert.equal(countSyncedOnline({ localHash: local, peers: live }), 3);
    assert.equal(countSyncedOnline({
      localHash: local,
      peers: live.filter((p) => p.remote !== '2.2.2.2'),
    }), 2);
    assert.equal(countSyncedOnline({
      localHash: local,
      peers: [
        { remote: '1.1.1.1', hash: 'abc', id: 1 },
        { remote: '1.1.1.1', hash: 'abc', id: 9 },
      ],
    }), 2);
    assert.equal(countSyncedOnline({ localHash: local, peers: [] }), 1);
  });

  it('two connected empty nodes each see the other as online, then drop on close', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-on-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-on-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      assert.equal(a.p2p.syncedOnline(), 1);
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const both = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2);
      assert.equal(both, true);
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
    assert.equal(a.p2p.syncedOnline(), 1);
  });

  it('gossips pending sends and open-round miner rows onto a peer lattice', async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-mem-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-mem-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 0 });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 0 });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const linked = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2);
      assert.equal(linked, true);
      const { levyNanos } = await import('../../crypto/levy.js');
      const { attachDummyOuts } = await import('../../crypto/dummy.js');
      const id = newIdentity();
      const box = spendBox(id);
      const payDest = box.dest;
      assert.equal((await Promise.resolve(mineOne(a.store, payDest, 4))).ok, true);
      const synced = await waitFor(() => Number(b.store.tip()?.height || 0) >= 1, 15000);
      assert.equal(synced, true, 'peer did not sync mined block');
      const tip = a.store.tip();
      const spent = (tip.txs[0].vout || []).find((o) => o.kind === 'pot');
      const sendNanos = 2;
      const fee = levyNanos(sendNanos);
      const tx = attachDummyOuts({
        id: 'net-send-1',
        kind: 'send',
        from: payDest,
        to: payDest,
        nanos: sendNanos,
        fee,
        vin: [{ prev: tip.hash, index: tip.txs[0].vout.indexOf(spent), commit: spent.commit, noteCommit: spent.noteCommit, address: payDest }],
        vout: [{ address: payDest, nanos: sendNanos, kind: 'send' }],
      }, { spent });
      admitSend(tx, { id, spent, blocks: a.store.blocks });
      signSpendTx(tx, box.key);
      const queued = a.store.queueTx(tx);
      assert.equal(queued.ok, true, queued.reason);
      const tag = 'mcafef00d';
      let lastPub = 0;
      const saw = await waitFor(() => {
        if (Date.now() - lastPub > 200) {
          a.p2p.publishWork([{ tag, count: 42 }]);
          lastPub = Date.now();
        }
        const tx = (b.store.mempool || []).some((t) => String(t.id) === 'net-send-1');
        const work = typeof b.store.openRoundRows === 'function'
          && b.store.openRoundRows().some((r) => r.tag === tag && Number(r.count) === 42);
        return tx && work;
      }, 15000);
      assert.equal(saw, true, 'peer book never received send or miner row');
      const { mempoolLattice } = await import('../../pool/src/wallet_api.js');
      const out = mempoolLattice(b.store, {
        miners: new Map(),
        lastJob: { height: 1, jobId: 'peer' },
        nodesOnline: b.p2p.syncedOnline(),
      });
      assert.equal(out.scope, 'network');
      assert.equal(out.pending.some((t) => t.id === 'net-send-1'), true);
      const row = out.pendingBlock.txs.find((t) => t.tag === tag);
      assert.ok(row, 'lattice payload missing peer miner row');
      assert.equal(row.count, 42);
      assert.equal(row.kind, 'hash');
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
  });

  it('printConfig pins p2p 30303, testnet magic, not mainnet', () => {
    const cfg = printConfig();
    assert.equal(cfg.p2p, P2P_PORT);
    assert.equal(cfg.p2p, 30303);
    assert.equal(cfg.magic, MAGIC_TESTNET);
    assert.equal(cfg.magic, 'shear-testnet-v3');
    assert.equal(cfg.mainnet, false);
    assert.equal(cfg.phaseBGate, true);
    assert.equal(cfg.rpc, 18332);
  });

  it('pickStemSocket returns one peer; fluff delay is 1–3 s; no IP beside dest in logs', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    const picked = pickStemSocket(new Set([a, b, c]), a, () => 0);
    assert.equal(picked === b || picked === c, true);
    assert.notEqual(picked, a);
    assert.equal(pickStemSocket(new Set([a]), a), null);
    const d = fluffDelayMs(() => 0);
    const e = fluffDelayMs(() => 0.999);
    assert.ok(d >= FLUFF_MIN_MS && d <= FLUFF_MAX_MS);
    assert.ok(e >= FLUFF_MIN_MS && e <= FLUFF_MAX_MS);
    assert.equal(STEM_MAX_HOPS, 3);
    assert.equal(lineHasIpBesideIdentity('remoteAddress 1.2.3.4 dest ssa1abc'), true);
    assert.equal(lineHasIpBesideIdentity('tx net-send-1 queued'), false);
    const note = peerEventFields({ event: 'stem', remote: '1.2.3.4' });
    assert.equal(note.remote, 'peer');
    assert.equal(JSON.stringify(note).includes('1.2.3.4'), false);
    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    for (const line of src.split('\n')) {
      if (!/console\.(log|info|warn|error)/.test(line)) continue;
      assert.equal(lineHasIpBesideIdentity(line), false, line);
    }
  });

  it('originator first inv set size is 1, then fluff reaches a 3-node graph', async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stem-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stem-b-'));
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stem-c-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
    const c = await startNode({ dataDir: dirC, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      await a.p2p.connect('127.0.0.1', c.bound.port);
      const linked = await waitFor(() => a.p2p.syncedOnline() >= 2);
      assert.equal(linked, true);
      const { levyNanos } = await import('../../crypto/levy.js');
      const { attachDummyOuts } = await import('../../crypto/dummy.js');
      const id = newIdentity();
      const box = spendBox(id);
      const payDest = box.dest;
      assert.equal((await Promise.resolve(mineOne(a.store, payDest, 4))).ok, true);
      const synced = await waitFor(() => Number(b.store.tip()?.height || 0) >= 1 && Number(c.store.tip()?.height || 0) >= 1, 15000);
      assert.equal(synced, true, 'peer did not sync mined block');
      const tip = a.store.tip();
      const spent = (tip.txs[0].vout || []).find((o) => o.kind === 'pot');
      const sendNanos = 2;
      const fee = levyNanos(sendNanos);
      const tx = attachDummyOuts({
        id: 'stem-send-1',
        kind: 'send',
        from: payDest,
        to: payDest,
        nanos: sendNanos,
        fee,
        vin: [{ prev: tip.hash, index: tip.txs[0].vout.indexOf(spent), commit: spent.commit, noteCommit: spent.noteCommit, address: payDest }],
        vout: [{ address: payDest, nanos: sendNanos, kind: 'send' }],
      }, { spent });
      admitSend(tx, { id, spent, blocks: a.store.blocks });
      signSpendTx(tx, box.key);
      const queued = a.store.queueTx(tx);
      assert.equal(queued.ok, true, queued.reason);
      assert.equal(JSON.stringify(queued.tx || queued).includes('remoteAddress'), false);
      assert.equal(a.p2p.originInvSetSize('stem-send-1'), 1);
      const has = (node) => (node.store.mempool || []).some((t) => String(t.id) === 'stem-send-1');
      const fluffed = await waitFor(() => has(b) && has(c), 3000);
      assert.equal(fluffed, true, 'fluff did not reach both peers');
    } finally {
      a.p2p.close();
      b.p2p.close();
      c.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
      await c.rpc?.close?.();
    }
  });

  it('lock and vote still paint (pending) after fluff', async () => {
    const id = newIdentity();
    const box = spendBox(id);
    const dest = box.dest;
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fluff-lock-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fluff-lock-b-'));
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fluff-lock-c-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
    const c = await startNode({ dataDir: dirC, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      await a.p2p.connect('127.0.0.1', c.bound.port);
      await waitFor(() => a.p2p.syncedOnline() >= 2);
      const { levyNanos } = await import('../../crypto/levy.js');
      const lockNanos = 314159265358;
      const lock = signSpendTx({
        id: 'lock-fluff',
        kind: 'lock',
        from: dest,
        to: dest,
        nanos: lockNanos,
        fee: levyNanos(lockNanos, { depth: 1e9 }),
        vout: [{ address: dest, nanos: lockNanos, kind: 'lock' }],
      }, box.key);
      const vote = signSpendTx({
        id: 'vote-fluff',
        kind: 'vote',
        from: dest,
        to: dest,
        nanos: 0,
        payer: dest,
        fee: levyNanos(0, { depth: 1e9 }),
        vout: [{ address: dest, nanos: 0, kind: 'vote' }],
      }, box.key);
      const qLock = a.store.queueTx(lock);
      const qVote = a.store.queueTx(vote);
      assert.equal(qLock.ok, true, qLock.reason);
      assert.equal(qVote.ok, true, qVote.reason);
      assert.equal(a.p2p.originInvSetSize('lock-fluff'), 1);
      const { explorerRecentTxs, publicPayloadLeaksIdentity } = await import('../../pool/src/wallet_api.js');
      const painted = await waitFor(() => {
        const rows = explorerRecentTxs(c.store, 30);
        const lockRow = rows.find((t) => t.id === 'lock-fluff');
        const voteRow = rows.find((t) => t.id === 'vote-fluff');
        return lockRow?.pending === true && voteRow?.pending === true
          && lockRow.kind === 'lock' && voteRow.kind === 'vote';
      }, 3000);
      assert.equal(painted, true);
      const rows = explorerRecentTxs(c.store, 30);
      const lockRow = rows.find((t) => t.id === 'lock-fluff');
      assert.ok(String(lockRow.to).startsWith('ssa1'));
      assert.equal(publicPayloadLeaksIdentity(lockRow), false);
      assert.equal(lockRow.memoPlain, undefined);
    } finally {
      a.p2p.close();
      b.p2p.close();
      c.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
      await c.rpc?.close?.();
    }
  });

  it('drops metadata/RFC1918 addrs and getblocks; seeds include the public P2P node', () => {
    assert.equal(isRoutablePeerAddr('169.254.169.254'), false);
    assert.equal(isRoutablePeerAddr('10.0.0.1'), false);
    assert.equal(isRoutablePeerAddr('192.168.1.1'), false);
    assert.equal(isRoutablePeerAddr('127.0.0.1'), false);
    assert.equal(isRoutablePeerAddr('1.1.1.1'), true);
    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    assert.match(src, /getblocks/);
    assert.match(src, /sock\.destroy\(\)/);
    assert.equal(src.includes('seenTx.clear()'), false);
    assert.ok(DEFAULT_SEEDS.includes('p2p.shear.digital:30303'));
    assert.ok(DEFAULT_SEEDS.includes('46.224.132.83:30303'));
    assert.equal(GETBLOCK_BATCH, 16);
    assert.equal(HEADERS_PAGE, 2000);
    assert.match(src, /requestHeaders/);
    assert.match(src, /dialSeeds/);
    assert.equal(src.includes('hdrs.slice(-2000)'), false);
  });
});

function fakeBlocks(n) {
  const blocks = [];
  for (let i = 1; i <= n; i += 1) {
    const hash = Buffer.alloc(32);
    hash.writeUInt32BE(i, 28);
    const header = Buffer.alloc(128);
    header.writeUInt32BE(i, 0);
    blocks.push({ header, hash, height: i });
  }
  return blocks;
}

function fakeHash(n) {
  const hash = Buffer.alloc(32);
  hash.writeUInt32BE(n, 28);
  return hash.toString('hex');
}

function mineChainOne(store, dest, bits = 4) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : Date.now();
  const { tpl } = store.template({ miner: dest, bits, shareBits: bits, now });
  const found = mineTemplate({ ...tpl, bits }, { maxTries: 3_000_000, shareBits: bits });
  assert.ok(found && found.block, 'need pow');
  const got = store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  });
  assert.equal(got.ok, true, got.reason);
  return got;
}

function copyBlocks(blocks) {
  return (blocks || []).map((b) => ({
    ...b,
    header: Buffer.from(b.header),
    hash: Buffer.from(b.hash),
  }));
}

function tipsEqual(a, b) {
  const ta = a.store.tip();
  const tb = b.store.tip();
  if (!ta || !tb) return false;
  return ta.height === tb.height && Buffer.from(ta.hash).equals(Buffer.from(tb.hash));
}

async function readJsonLines(sock, want, ms = 3000) {
  const lines = [];
  let buf = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        try { lines.push(JSON.parse(raw)); } catch { continue; }
        if (lines.length >= want) {
          clearTimeout(t);
          sock.off('data', onData);
          resolve();
        }
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
  return lines;
}

describe('p2p IBD catch-up', { timeout: 600_000 }, () => {
  it('serves headers after locator and paginates past 2000 without a last-N dump', () => {
    const blocks = fakeBlocks(2500);
    const loc = locatorHashes(blocks);
    assert.equal(loc[0], fakeHash(2500));
    assert.ok(loc.length >= 1);

    const page = selectHeadersAfterLocator(blocks, {
      locator: [fakeHash(100)],
      stopHash: fakeHash(2500),
    });
    assert.equal(page.length, HEADERS_PAGE);
    assert.equal(page[0].height, 101);
    assert.equal(page[page.length - 1].height, 2100);

    const next = selectHeadersAfterLocator(blocks, {
      locator: [fakeHash(2100)],
      stopHash: fakeHash(2500),
    });
    assert.equal(next[0].height, 2101);
    assert.equal(next[next.length - 1].height, 2500);
    assert.equal(next.length, 400);

    const ibd = selectHeadersAfterLocator(blocks, { locator: [], stopHash: fakeHash(2500) });
    assert.equal(ibd[0].height, 1);
    assert.equal(ibd.length, HEADERS_PAGE);
    assert.equal(ibd[ibd.length - 1].height, 2000);

    const legacy = selectHeadersAfterLocator(blocks, { stopHash: fakeHash(16) });
    assert.equal(legacy[0].height, 17);
    assert.ok(legacy.length > 16);
  });

  it('shipped getheaders honors locator/stop and continues to the next page', async () => {
    const blocks = fakeBlocks(2500);
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = net.connect(bound.port, '127.0.0.1');
    try {
      await readJsonLines(sock, 2, 2000);
      sock.write(`${JSON.stringify({
        type: 'getheaders',
        magic: MAGIC_TESTNET,
        locator: [fakeHash(100)],
        stopHash: fakeHash(2500),
      })}\n`);
      const first = await readJsonLines(sock, 1, 2000);
      const hdrs = first.find((m) => m.type === 'headers');
      assert.ok(hdrs, 'expected headers');
      assert.equal(hdrs.headers[0].height, 101);
      assert.equal(hdrs.headers.length, HEADERS_PAGE);
      assert.equal(hdrs.headers[hdrs.headers.length - 1].height, 2100);

      sock.write(`${JSON.stringify({
        type: 'getheaders',
        magic: MAGIC_TESTNET,
        locator: [fakeHash(2100)],
        stopHash: fakeHash(2500),
      })}\n`);
      const second = await readJsonLines(sock, 1, 2000);
      const more = second.find((m) => m.type === 'headers');
      assert.ok(more, 'expected continuation headers');
      assert.equal(more.headers[0].height, 2101);
      assert.equal(more.headers[more.headers.length - 1].height, 2500);
    } finally {
      sock.destroy();
      p2p.close();
    }
  });

  it('dialSeeds reconnects after the peer socket drops', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-redial-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-redial-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const linked = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2);
      assert.equal(linked, true);
      for (const s of [...a.p2p.sockets]) s.destroy();
      const dropped = await waitFor(() => a.p2p.syncedOnline() === 1, 4000);
      assert.equal(dropped, true);
      await a.p2p.dialSeeds([`127.0.0.1:${b.bound.port}`]);
      const back = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2, 5000);
      assert.equal(back, true);
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
  });

  it('empty, lagging-prefix, and later third nodes fully catch up past one getblock batch', async () => {
    const dest = destMiner();
    const bits = 4;
    const want = 20;
    assert.ok(want > GETBLOCK_BATCH);
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-a-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      for (let i = 0; i < want; i += 1) mineChainOne(a.store, dest, bits);
      assert.equal(a.store.tip().height, want);

      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-b-'));
      const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
      try {
        assert.equal(b.store.tip(), null);
        await a.p2p.connect('127.0.0.1', b.bound.port);
        const emptyOk = await waitFor(() => tipsEqual(a, b), 30_000);
        assert.equal(emptyOk, true, `empty B stuck at ${b.store.tip()?.height || 0} want ${want}`);
        assert.equal(b.store.tip().height, want);
        assert.equal(Buffer.from(b.store.tip().hash).equals(Buffer.from(a.store.tip().hash)), true);

        const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-c-'));
        const c = await startNode({ dataDir: dirC, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
        try {
          const prefix = copyBlocks(a.store.blocks.slice(0, 8));
          const ingested = await Promise.resolve(c.store.ingest(prefix));
          assert.equal(ingested.ok, true, ingested.reason);
          assert.equal(c.store.tip().height, 8);
          assert.ok(c.store.tip().height > 0 && c.store.tip().height < want);
          await c.p2p.connect('127.0.0.1', a.bound.port);
          const lagOk = await waitFor(() => tipsEqual(a, c), 30_000);
          assert.equal(lagOk, true, `lagging C stuck at ${c.store.tip()?.height || 0} want ${want}`);
          assert.equal(c.store.tip().height, want);
          assert.equal(Buffer.from(c.store.tip().hash).equals(Buffer.from(a.store.tip().hash)), true);

          const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-d-'));
          const d = await startNode({ dataDir: dirD, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
          try {
            await d.p2p.connect('127.0.0.1', a.bound.port);
            const laterOk = await waitFor(() => tipsEqual(a, d), 30_000);
            assert.equal(laterOk, true, `later D stuck at ${d.store.tip()?.height || 0} want ${want}`);
            assert.equal(d.store.tip().height, a.store.tip().height);
            assert.equal(Buffer.from(d.store.tip().hash).equals(Buffer.from(a.store.tip().hash)), true);
          } finally {
            d.p2p.close();
            await d.rpc?.close?.();
          }
        } finally {
          c.p2p.close();
          await c.rpc?.close?.();
        }
      } finally {
        b.p2p.close();
        await b.rpc?.close?.();
      }
    } finally {
      a.p2p.close();
      await a.rpc?.close?.();
    }
  });
});
