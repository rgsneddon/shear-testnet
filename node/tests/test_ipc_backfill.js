import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { createStore } from '../src/store.js';
import { encodeWireBlock, headerPrevHash } from '../src/p2p.js';
import {
  IPC_BACKFILL_MAX,
  ancestorWindow,
  attachPoolIpc,
  attachSidecarIpc,
  chunkIpcBlocks,
  ipcParentRepair,
  selectIpcBackfill,
} from '../src/p2p_ipc.js';

function headerFor(prev) {
  return encodeHeader({
    prevBlockHash: prev,
    merkleRoot: Buffer.alloc(32, 1),
    continuityRoot: Buffer.alloc(32, 2),
    timestamp: 5n,
    bits: 4,
  });
}

function fakeBlocks(n, fromHeight = 101) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      height: fromHeight + i,
      hash: Buffer.alloc(32, i + 1),
    });
  }
  return out;
}

function seal(store, miner, i, now) {
  const { job } = store.template({ miner, now });
  const pow = Buffer.alloc(32, 0);
  pow[31] = i + 1;
  return store.submitHeader({
    jobId: job.jobId,
    nonce: 0n,
    miner,
    powHash: pow.toString('hex'),
  }, { trusted: true });
}

function readLinesUntil(sock, pred, ms = 5000) {
  const lines = [];
  let buf = '';
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(t);
      sock.off('data', onData);
      resolve(lines);
    };
    const t = setTimeout(finish, ms);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        try { lines.push(JSON.parse(raw)); } catch { /* ignore */ }
        if (pred(lines)) finish();
      }
    };
    sock.on('data', onData);
  });
}

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe('IPC backfill window and parent repair', () => {
  it('treats IPC_BACKFILL_MAX as a chunk size and never refuses a gap above 8', () => {
    const src = fs.readFileSync(new URL('../src/p2p_ipc.js', import.meta.url), 'utf8');
    assert.equal(/local - from > IPC_BACKFILL_MAX/.test(src), false);
    assert.equal(IPC_BACKFILL_MAX, 8);
    const blocks = fakeBlocks(15, 101);
    const plan = selectIpcBackfill(blocks, 100, { localHeight: 115 });
    assert.equal(plan.refused, false);
    assert.equal(plan.gap, 15);
    assert.equal(plan.blocks.length, 15);
    assert.equal(plan.blocks[0].height, 101);
    assert.equal(plan.blocks[14].height, 115);
    const chunks = chunkIpcBlocks(plan.blocks, IPC_BACKFILL_MAX);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 8);
    assert.equal(chunks[1].length, 7);
    const caughtUp = selectIpcBackfill(blocks, 115, { localHeight: 115 });
    assert.equal(caughtUp.refused, false);
    assert.equal(caughtUp.blocks.length, 0);
    const missing = selectIpcBackfill([], 100, { localHeight: 115 });
    assert.equal(missing.refused, true);
    assert.equal(missing.reason, 'missing_blocks');
    assert.equal(missing.gap, 15);
  });

  it('asks for the parent on prev and unsigned, and not on merkle or pow', () => {
    const parent = Buffer.alloc(32, 9);
    const block = { header: headerFor(parent), hash: 'ab'.repeat(32) };
    const prev = ipcParentRepair(block, 'prev');
    assert.equal(prev.ask, true);
    assert.equal(prev.parent, parent.toString('hex'));
    assert.equal(prev.child, 'ab'.repeat(32));
    const unsigned = ipcParentRepair(block, 'unsigned');
    assert.equal(unsigned.ask, true);
    assert.equal(unsigned.parent, prev.parent);
    assert.equal(ipcParentRepair(block, 'merkle'), null);
    assert.equal(ipcParentRepair(block, 'pow'), null);
    assert.equal(ipcParentRepair(block, 'bits'), null);
    const zero = ipcParentRepair({
      header: headerFor(Buffer.alloc(32)),
      hash: 'cd'.repeat(32),
    }, 'prev');
    assert.equal(zero.ask, false);
    const chain = fakeBlocks(10, 1);
    const tipHash = Buffer.from(chain[9].hash).toString('hex');
    const window = ancestorWindow(chain, tipHash, IPC_BACKFILL_MAX);
    assert.equal(window.length, IPC_BACKFILL_MAX);
    assert.equal(window[0].height, 3);
    assert.equal(window[window.length - 1].height, 10);
  });

  it('offers a gap wider than 8 and does not accept a synthetic digest', async () => {
    const miner = encodeDest(Buffer.alloc(20, 4));
    const tall = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ipc-tall-')));
    const behind = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ipc-behind-')));
    let now = 1_700_000_000_000;
    for (let i = 0; i < IPC_BACKFILL_MAX + 2; i += 1) {
      const got = seal(tall, miner, i, now);
      assert.equal(got.ok, true, got.reason);
      now = Number(decodeHeader(Buffer.from(tall.tip().header)).timestamp) + 90_000;
    }
    assert.equal(tall.tip().height, IPC_BACKFILL_MAX + 2);
    assert.ok(tall.tip().height - 0 > IPC_BACKFILL_MAX);
    const logs = [];
    const orig = console.error;
    console.error = (...args) => {
      logs.push(args.map(String).join(' '));
      orig.apply(console, args);
    };
    let ipc;
    let side;
    try {
      ipc = await attachPoolIpc({ store: tall, port: 0 });
      side = attachSidecarIpc({ store: behind, addr: `127.0.0.1:${ipc.port}` });
      const sawPow = await waitFor(
        () => logs.some((line) => line.includes('"event":"ipc_apply"') && line.includes('"reason":"pow"')),
        20_000,
      );
      assert.equal(sawPow, true, `no pow reject in ${logs.join(' | ')}`);
      assert.equal(behind.tip(), null);
      assert.ok(tall.tip().height > IPC_BACKFILL_MAX);
      assert.ok(logs.some((line) => line.includes('"event":"ipc_backfill"') && line.includes('"refused":false')));
      assert.equal(logs.some((line) => line.includes('ipc_backfill_refuse')), false);
    } finally {
      console.error = orig;
      side?.close();
      await ipc?.close();
    }
  });

  it('prev on a jumped ipc_block asks the peer for that parent', async () => {
    const miner = encodeDest(Buffer.alloc(20, 6));
    const tall = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ipc-jump-tall-')));
    const pool = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ipc-jump-pool-')));
    let now = 1_700_000_000_000;
    for (let i = 0; i < 4; i += 1) {
      const got = seal(tall, miner, i, now);
      assert.equal(got.ok, true, got.reason);
      now = Number(decodeHeader(Buffer.from(tall.tip().header)).timestamp) + 90_000;
    }
    const tip = tall.blocks[tall.blocks.length - 1];
    const wire = encodeWireBlock(tip);
    const parent = headerPrevHash(wire.header);
    assert.ok(parent);
    const ipc = await attachPoolIpc({ store: pool, port: 0 });
    const sock = net.connect(ipc.port, '127.0.0.1');
    try {
      await new Promise((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      });
      const pending = readLinesUntil(sock, (lines) => lines.some((m) => m.type === 'ipc_getblock'), 5000);
      sock.write(`${JSON.stringify({
        type: 'ipc_block',
        magic: MAGIC_TESTNET,
        block: wire,
        powHash: Buffer.from(tip.hash).toString('hex'),
      })}\n`);
      const lines = await pending;
      const ask = lines.find((m) => m.type === 'ipc_getblock');
      assert.ok(ask, `expected ipc_getblock, got ${lines.map((m) => m.type).join(',')}`);
      assert.equal(String(ask.hash).toLowerCase(), parent);
      assert.equal(pool.tip(), null);
    } finally {
      sock.destroy();
      await ipc.close();
    }
  });
});
