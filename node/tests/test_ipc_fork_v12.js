/**
 * IPC must stage or adopt a fork whose parent this store already has.
 * Repair asks for a parent only when it is absent, and only after the
 * child header meets the target it declares. A miss gets no repair.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GENESIS_BITS_PACKED, LIVE_MIN_BITS, MAGIC_TESTNET, TARGET_BLOCK_INTERVAL_MS, nextBits, packBits } from '../../crypto/asert.js';
import { VERSION, decodeHeader, encodeHeader, setNonce } from '../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

import { shouldAdopt } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { decodeWireBlock, encodeWireBlock } from '../src/p2p.js';
import { IPC_BACKFILL_MAX, ancestorWindow, attachPoolIpc } from '../src/p2p_ipc.js';

// The fixture's own nonces (fixtures/seal_wedge_v12.mjs seals them).
const WEDGE_FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/p2p-wedge-v12.json', import.meta.url), 'utf8'));
const WEDGE_HEADER_NONCE = WEDGE_FIXTURE.headerNonces.map(BigInt);

function cloneBlock(block) {
  return {
    header: Buffer.from(block.header),
    hash: Buffer.from(block.hash),
    height: block.height,
    txs: block.txs,
    samples: block.samples || [],
    shareBatch: block.shareBatch || [],
    hashCredits: block.hashCredits,
    hashSpill: block.hashSpill || [],
    miner: block.miner,
    poolDest: block.poolDest,
    aLeaves: block.aLeaves,
    bLeaves: block.bLeaves,
    rootA: block.rootA,
    rootB: block.rootB,
    weight: block.weight,
  };
}

function loadFleet() {
  const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/p2p-wedge-v12.json', import.meta.url), 'utf8'));
  const childBits = nextBits(GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS);
  assert.equal(childBits, GENESIS_BITS_PACKED);
  return raw.blocks.map((row, i) => {
    const block = cloneBlock(decodeWireBlock(row));
    const header = setNonce(block.header, WEDGE_HEADER_NONCE[i]);
    const hash = shearHash(header);
    assert.equal(decodeHeader(header).bits, GENESIS_BITS_PACKED);
    assert.equal(meetsTarget(hash, GENESIS_BITS_PACKED), true);
    block.header = header;
    block.hash = hash;
    return block;
  });
}

function losingBlock(winner) {
  const found = JSON.parse(fs.readFileSync(new URL('./fixtures/lose-block-nonce.json', import.meta.url), 'utf8'));
  const header = setNonce(winner.header, BigInt(found.nonce));
  const hash = shearHash(header);
  const block = cloneBlock(winner);
  block.header = header;
  block.hash = hash;
  assert.equal(meetsTarget(hash, GENESIS_BITS_PACKED), true);
  return block;
}

function tipHex(store) {
  const tip = store.tip();
  return tip?.hash ? Buffer.from(tip.hash).toString('hex') : '';
}

function blockHex(block) {
  return Buffer.from(block.hash).toString('hex');
}

function freshStore(tag) {
  return createStore(fs.mkdtempSync(path.join(os.tmpdir(), tag)));
}

function appendReal(store, block) {
  const got = store.append(cloneBlock(block));
  assert.equal(got.ok, true, got.reason || 'append');
  return got;
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function collect(sock) {
  const lines = [];
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!raw) continue;
      try { lines.push(JSON.parse(raw)); } catch { /* ignore */ }
    }
  });
  return lines;
}

function sendBlock(sock, block) {
  const wire = encodeWireBlock(block);
  sock.write(`${JSON.stringify({
    type: 'ipc_block',
    magic: MAGIC_TESTNET,
    block: wire,
    powHash: blockHex(block),
  })}\n`);
}

async function withPool(store, fn) {
  const ipc = await attachPoolIpc({ store, port: 0 });
  const sock = net.connect(ipc.port, '127.0.0.1');
  const lines = collect(sock);
  const logs = [];
  const orig = console.error;
  console.error = (...args) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    await fn({ sock, lines, logs });
  } finally {
    console.error = orig;
    sock.destroy();
    await ipc.close();
  }
}

function asks(lines) {
  return lines.filter((m) => m.type === 'ipc_getblock');
}

function mineEasy({ prev, bits = 4, timestamp = 1_700_000_000_000n }) {
  let nonce = 0n;
  while (nonce < 200000n) {
    const header = encodeHeader({
      version: VERSION,
      prevBlockHash: prev,
      merkleRoot: Buffer.alloc(32, 3),
      continuityRoot: Buffer.alloc(32, 4),
      timestamp,
      bits,
      nonce,
      baseFee: 1n,
    });
    const hash = shearHash(header);
    if (meetsTarget(hash, bits)) {
      return { header, hash, height: 2, txs: [] };
    }
    nonce += 1n;
  }
  throw new Error('easy header missed its target');
}

function easyChain(n, firstPrev) {
  const out = [];
  let prev = firstPrev;
  for (let i = 0; i < n; i += 1) {
    const block = mineEasy({
      prev,
      bits: packBits(LIVE_MIN_BITS),
      timestamp: BigInt(1_700_000_000_000 + i),
    });
    block.height = i + 1;
    out.push(block);
    prev = block.hash;
  }
  return out;
}

describe('IPC stages a known-parent fork and repairs only an unknown parent', () => {
  const fleet = loadFleet();
  const winner = fleet[0];
  const loser = losingBlock(winner);
  const winnerHex = blockHex(winner);
  const loserHex = blockHex(loser);
  assert.ok(loserHex > winnerHex);
  assert.equal(shouldAdopt([loser], [winner]), true);
  assert.equal(shouldAdopt([winner], [loser]), false);
  assert.equal(shouldAdopt([loser], fleet), true);
  assert.equal(shouldAdopt(fleet, [loser]), false);

  it('equal work: the heavier-hash sibling is side_hold, not a parent repair', async () => {
    const pool = freshStore('shear-ipc-eq-');
    appendReal(pool, winner);
    await withPool(pool, async ({ sock, lines, logs }) => {
      sendBlock(sock, loser);
      const held = await waitFor(() => logs.some((line) => line.includes('"reason":"side_hold"')));
      assert.equal(held, true, logs.join(' | '));
      assert.equal(asks(lines).length, 0);
      assert.equal(tipHex(pool), winnerHex);
      assert.ok(pool.sideHashes().includes(loserHex));
    });
  });

  it('equal work the other way adopts the lower tip hash', async () => {
    const pool = freshStore('shear-ipc-eq-win-');
    appendReal(pool, loser);
    await withPool(pool, async ({ sock, lines, logs }) => {
      sendBlock(sock, winner);
      const adopted = await waitFor(() => tipHex(pool) === winnerHex);
      assert.equal(adopted, true, logs.join(' | '));
      assert.equal(asks(lines).length, 0);
      assert.equal(pool.tip().height, 1);
      assert.ok(pool.sideHashes().includes(loserHex));
    });
  });

  it('a heavier fork adopts and a lighter one stays on the side', async () => {
    const heavy = freshStore('shear-ipc-heavy-');
    appendReal(heavy, loser);
    await withPool(heavy, async ({ sock, lines, logs }) => {
      sendBlock(sock, winner);
      assert.equal(await waitFor(() => tipHex(heavy) === winnerHex), true, logs.join(' | '));
      sendBlock(sock, fleet[1]);
      assert.equal(await waitFor(() => heavy.tip().height === 2), true, logs.join(' | '));
      sendBlock(sock, fleet[2]);
      assert.equal(await waitFor(() => heavy.tip().height === 3), true, logs.join(' | '));
      assert.equal(tipHex(heavy), blockHex(fleet[2]));
      assert.equal(asks(lines).length, 0);
      assert.equal(shouldAdopt([loser], heavy.blocks), true);
    });

    const light = freshStore('shear-ipc-light-');
    for (const block of fleet) appendReal(light, block);
    await withPool(light, async ({ sock, lines, logs }) => {
      sendBlock(sock, loser);
      const held = await waitFor(() => logs.some((line) => line.includes('"reason":"side_hold"')));
      assert.equal(held, true, logs.join(' | '));
      assert.equal(asks(lines).length, 0);
      assert.equal(light.tip().height, 3);
      assert.equal(tipHex(light), blockHex(fleet[2]));
      assert.ok(light.sideHashes().includes(loserHex));
    });
  });

  it('a parent on the main chain that is not the tip is ingested, not repaired', async () => {
    const pool = freshStore('shear-ipc-main-');
    for (const block of fleet) appendReal(pool, block);
    const child = mineEasy({ prev: fleet[0].hash, bits: 4 });
    await withPool(pool, async ({ sock, lines, logs }) => {
      sendBlock(sock, child);
      const saw = await waitFor(() => logs.some((line) => line.includes('"event":"ipc_apply"')));
      assert.equal(saw, true, logs.join(' | '));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(asks(lines).length, 0);
      assert.equal(logs.some((line) => line.includes('"reason":"prev"')), false);
      assert.equal(pool.tip().height, 3);
      assert.equal(tipHex(pool), blockHex(fleet[2]));
    });
  });

  it('a parent on the side chain is appended, not repaired', async () => {
    const pool = freshStore('shear-ipc-side-');
    appendReal(pool, winner);
    const child = mineEasy({ prev: loser.hash, bits: 4 });
    await withPool(pool, async ({ sock, lines, logs }) => {
      sendBlock(sock, loser);
      assert.equal(await waitFor(() => pool.sideHashes().includes(loserHex)), true, logs.join(' | '));
      const before = asks(lines).length;
      sendBlock(sock, child);
      const saw = await waitFor(() => logs.filter((line) => line.includes('"event":"ipc_apply"')).length >= 2);
      assert.equal(saw, true, logs.join(' | '));
      assert.equal(asks(lines).length, before);
      assert.equal(logs.some((line) => line.includes('"reason":"prev"')), false);
      assert.equal(tipHex(pool), winnerHex);
    });
  });

  it('an unknown parent is asked once, and a second burst inside the retry gap is suppressed', async () => {
    const pool = freshStore('shear-ipc-unk-');
    appendReal(pool, winner);
    const child = mineEasy({ prev: Buffer.alloc(32, 0xab), bits: packBits(LIVE_MIN_BITS) });
    await withPool(pool, async ({ sock, lines }) => {
      sendBlock(sock, child);
      const first = await waitFor(() => asks(lines).length >= 1);
      assert.equal(first, true);
      assert.equal(asks(lines).length, 1);
      assert.equal(String(asks(lines)[0].hash).toLowerCase(), Buffer.alloc(32, 0xab).toString('hex'));
      sendBlock(sock, child);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(asks(lines).length, 1);
      assert.equal(tipHex(pool), winnerHex);
    });
  });

  it('a bad-PoW child gets no repair', async () => {
    const pool = freshStore('shear-ipc-badpow-');
    appendReal(pool, winner);
    const header = encodeHeader({
      version: VERSION,
      prevBlockHash: Buffer.alloc(32, 0xcd),
      merkleRoot: Buffer.alloc(32, 1),
      continuityRoot: Buffer.alloc(32, 2),
      timestamp: 1_700_000_000_000n,
      bits: 16,
      nonce: 1n,
      baseFee: 1n,
    });
    const hash = shearHash(header);
    assert.equal(meetsTarget(hash, 16), false);
    const zero = encodeHeader({
      version: VERSION,
      prevBlockHash: Buffer.alloc(32, 0xce),
      merkleRoot: Buffer.alloc(32, 1),
      continuityRoot: Buffer.alloc(32, 2),
      timestamp: 1_700_000_000_000n,
      bits: 0,
      nonce: 0n,
      baseFee: 1n,
    });
    const zeroHash = shearHash(zero);
    assert.equal(meetsTarget(zeroHash, 0), true);
    await withPool(pool, async ({ sock, lines, logs }) => {
      sendBlock(sock, { header, hash, height: 9, txs: [] });
      const saw = await waitFor(() => logs.some((line) => line.includes('"reason":"pow"')));
      assert.equal(saw, true, logs.join(' | '));
      const powLogs = () => logs.filter((line) => line.includes('"reason":"pow"')).length;
      const before = powLogs();
      sendBlock(sock, { header: zero, hash: zeroHash, height: 9, txs: [] });
      const sawZero = await waitFor(() => powLogs() > before);
      assert.equal(sawZero, true, logs.join(' | '));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(asks(lines).length, 0);
      assert.equal(tipHex(pool), winnerHex);
    });
  });

  it('a fork deeper than the repair window asks for one missing parent, and a known root is not a repair', async () => {
    const deep = easyChain(IPC_BACKFILL_MAX + 1, Buffer.alloc(32, 0x11));
    assert.equal(deep.length, 9);
    const window = ancestorWindow(deep.map((b, i) => ({
      height: i + 1,
      hash: b.hash,
    })), blockHex(deep[deep.length - 1]), IPC_BACKFILL_MAX);
    assert.equal(window.length, IPC_BACKFILL_MAX);
    assert.equal(window.length < deep.length, true);

    const unknown = freshStore('shear-ipc-deep-');
    appendReal(unknown, winner);
    await withPool(unknown, async ({ sock, lines }) => {
      sendBlock(sock, deep[deep.length - 1]);
      assert.equal(await waitFor(() => asks(lines).length >= 1), true);
      assert.equal(asks(lines).length, 1);
      assert.equal(String(asks(lines)[0].hash).toLowerCase(), blockHex(deep[deep.length - 2]));
      sendBlock(sock, deep[0]);
      assert.equal(await waitFor(() => asks(lines).length >= 2), true);
      assert.equal(asks(lines).length, 2);
      assert.equal(String(asks(lines)[1].hash).toLowerCase(), Buffer.alloc(32, 0x11).toString('hex'));
      assert.equal(unknown.tip().height, 1);
    });

    const rooted = easyChain(IPC_BACKFILL_MAX + 1, winner.hash);
    const known = freshStore('shear-ipc-deep-known-');
    for (const block of fleet) appendReal(known, block);
    await withPool(known, async ({ sock, lines, logs }) => {
      sendBlock(sock, rooted[0]);
      const saw = await waitFor(() => logs.some((line) => line.includes('"event":"ipc_apply"')));
      assert.equal(saw, true, logs.join(' | '));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(asks(lines).length, 0);
      assert.equal(logs.some((line) => line.includes('"reason":"prev"')), false);
      assert.equal(known.tip().height, 3);
      sendBlock(sock, rooted[rooted.length - 1]);
      assert.equal(await waitFor(() => asks(lines).length === 1), true);
      assert.equal(String(asks(lines)[0].hash).toLowerCase(), blockHex(rooted[rooted.length - 2]));
    });
  });
});
