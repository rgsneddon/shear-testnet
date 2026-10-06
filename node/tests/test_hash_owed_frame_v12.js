/**
 * The coinbase owed map must stay inside the P2P frame and the IPC frame
 * for any backlog size. The measure is the shipped compact + json wire,
 * not a private size helper.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import { compactTx, leanBlock } from '../../crypto/chronoflux.js';
import {
  GENESIS_BITS_PACKED,
  HASH_OWED_MAX_ENTRIES,
  HASH_OWED_SCALE_K,
  HASH_OWED_SCALE_WINDOW,
  MAX_HASH_UNITS_PER_BLOCK,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import {
  hashBudgetUnits,
  hashOwedFromTx,
  hashOwedRoot,
  replayHashOwed,
  settleHashOwed,
  writeHashLedger,
} from '../../crypto/hash_owed.js';
import {
  clearLiveSharePow,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
} from '../../crypto/share_batch.js';
import { encodeWireBlock, jsonWire, P2P_MAX_FRAME_DEFAULT } from '../src/p2p.js';
import { IPC_MAX_FRAME } from '../src/p2p_ipc.js';
import { GENESIS_PREV, buildTemplate, verifyBlock } from '../src/chain.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function destRow(i, nanos, sinceHeight) {
  const dest20 = Buffer.alloc(20);
  dest20.writeUInt32BE((i + 1) >>> 0, 0);
  dest20.writeUInt32BE((i * 17 + 3) >>> 0, 4);
  dest20[18] = (i >>> 8) & 0xff;
  dest20[19] = i & 0xff;
  return {
    noteCommit: noteCommitOfDest20(dest20),
    dest20,
    nanos,
    sinceHeight,
  };
}

function backlog(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const nanos = 1000n + BigInt((i % 13) + 1);
    rows.push(destRow(i, nanos, i + 1));
  }
  return rows;
}

function coinbaseWithBacklog(count) {
  const settled = settleHashOwed({
    owedIn: backlog(count),
    fresh: [],
    budget: 0n,
    height: count + 1,
  });
  assert.equal(settled.ok, true, settled.reason);
  const tx = { coinbase: true, height: count + 1, vin: [{ coinbase: true }], vout: [] };
  writeHashLedger(tx, settled);
  return tx;
}

function wireBytes(tx) {
  const block = {
    header: Buffer.alloc(128),
    hash: Buffer.alloc(32),
    height: tx.height,
    txs: [tx],
    samples: [],
    miner: '',
    shareBatch: [],
    aLeaves: [],
    bLeaves: [],
  };
  const coinbaseLine = jsonWire(compactTx(tx));
  const blockLine = jsonWire(encodeWireBlock(block));
  return { coinbaseLine, blockLine };
}

describe('v12 hash-owed frame', () => {
  it('keeps any owed-map backlog inside the P2P and IPC frames', () => {
    const cap = HASH_OWED_MAX_ENTRIES;
    const counts = [0, 1, 3, 17, cap - 1, cap, cap + 1, cap * 2, cap * 4];
    assert.ok(IPC_MAX_FRAME > 0);
    assert.ok(IPC_MAX_FRAME < P2P_MAX_FRAME_DEFAULT);
    const measured = [];
    for (const count of counts) {
      const tx = coinbaseWithBacklog(count);
      const { coinbaseLine, blockLine } = wireBytes(tx);
      measured.push({ count, coinbase: coinbaseLine.length, block: blockLine.length });
    }
    console.log(JSON.stringify({ event: 'hash_owed_frame_measured', measured }));
    for (const row of measured) {
      assert.ok(
        row.coinbase < 4096,
        `count ${row.count} coinbase json ${row.coinbase} holds the row map`,
      );
      assert.ok(
        row.block + 1 < IPC_MAX_FRAME,
        `count ${row.count} block wire ${row.block} ipc ${IPC_MAX_FRAME}`,
      );
      assert.ok(
        row.block + 1 < P2P_MAX_FRAME_DEFAULT,
        `count ${row.count} block wire ${row.block} p2p ${P2P_MAX_FRAME_DEFAULT}`,
      );
    }
  });

  it('scales mint capacity from sealed accepted units and never under the floor', () => {
    const floor = BigInt(MAX_HASH_UNITS_PER_BLOCK);
    const k = BigInt(HASH_OWED_SCALE_K);
    assert.ok(HASH_OWED_SCALE_WINDOW >= 2);
    assert.ok(k >= 1n);
    assert.equal(hashBudgetUnits(undefined), floor);
    assert.equal(hashBudgetUnits([]), floor);
    const quiet = [];
    for (let i = 0; i < HASH_OWED_SCALE_WINDOW; i += 1) quiet.push(i % 2 === 0 ? 0n : floor);
    assert.equal(hashBudgetUnits(quiet), floor);
    assert.equal(hashBudgetUnits(quiet), hashBudgetUnits([...quiet].reverse()));
    const hot = [];
    for (let i = 0; i < HASH_OWED_SCALE_WINDOW; i += 1) hot.push(floor + 1n + BigInt(i % 5));
    const lifted = hashBudgetUnits(hot);
    assert.equal(lifted, hashBudgetUnits(hot.slice()));
    assert.ok(lifted > floor);
    const tail = [];
    for (let i = 0; i < HASH_OWED_SCALE_WINDOW * 3; i += 1) {
      tail.push(i < HASH_OWED_SCALE_WINDOW * 2 ? 0n : floor + 9n);
    }
    assert.equal(hashBudgetUnits(tail), k * (floor + 9n));
    const above = 1n << 60n;
    assert.equal(hashBudgetUnits([above]), k * above);
    assert.equal(hashBudgetUnits([0n, above]), floor);
    assert.equal(hashBudgetUnits(['nope']), null);
  });

  it('replays a lean chain, and a prefix restore matches the earlier map', () => {
    const feeTo = minerDest();
    const a = minerDest();
    const b = minerDest();
    const now = 1_700_000_000_000;
    const genesis = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: feeTo,
      bits: GENESIS_BITS_PACKED,
      now,
    });
    const genesisBlock = {
      header: genesis.header,
      txs: genesis.txs,
      shareBatch: [],
      miner: feeTo,
      height: 1,
      aLeaves: genesis.aLeaves,
      bLeaves: genesis.bLeaves,
    };
    const sealedG = verifyBlock(genesisBlock, null, {
      trustedPowHash: Buffer.from('0000000000000000000000000000000000000000000000000000000000000011', 'hex'),
      nowMs: now + 1_000,
    });
    assert.equal(sealedG.ok, true, sealedG.reason);
    const bits = shareCreditMaxBits();
    const batch = [0, 1].map((i) => ({
      dest: i === 0 ? a : b,
      nonce: nonceWithShareTarget(10n + BigInt(i), bits),
      lz: bits,
      shareBits: bits,
      creditedShareBits: bits,
    }));
    clearLiveSharePow();
    for (const row of batch) {
      assert.equal(rememberLiveSharePow(genesis.header, row.nonce, {
        noteCommit: noteCommitOfShare(row),
        shareBits: row.shareBits,
        lz: row.lz,
      }), true);
    }
    const when = now + TARGET_BLOCK_INTERVAL_MS;
    const quote = asertNextBits({
      anchorBits: GENESIS_BITS_PACKED,
      anchorTimeMs: now,
      anchorHeight: 1,
      blockTimeMs: when,
      blockHeight: 2,
      parentTimeMs: now,
    });
    assert.equal(quote.ok, true, quote.reason);
    const child = buildTemplate({
      prev: sealedG.hash,
      prevHeader: genesis.header,
      prevBlock: { ...genesisBlock, hash: sealedG.hash },
      height: 2,
      miner: a,
      bits: quote.packed,
      now: when,
      shareBatch: batch,
    });
    const childBlock = {
      header: child.header,
      txs: child.txs,
      shareBatch: child.shareBatch || batch,
      miner: a,
      height: 2,
      aLeaves: child.aLeaves,
      bLeaves: child.bLeaves,
    };
    const sealedC = verifyBlock(childBlock, {
      ...genesisBlock,
      hash: sealedG.hash,
      header: genesis.header,
    }, {
      trustedPowHash: Buffer.from('0000000000000000000000000000000000000000000000000000000000000022', 'hex'),
      skipSharePow: true,
      nowMs: when + 1_000,
      genesisMs: now,
    });
    assert.equal(sealedC.ok, true, sealedC.reason);
    const rawRows = hashOwedFromTx(childBlock.txs[0]);
    assert.ok(rawRows.length > 0);
    const chain = [
      leanBlock({ ...genesisBlock, hash: sealedG.hash }),
      leanBlock({ ...childBlock, hash: sealedC.hash }),
    ];
    assert.equal(chain[1].txs[0].hashOwed, undefined);
    assert.equal(chain[1].txs[0].hashOwedLocal, undefined);
    assert.equal(hashOwedFromTx(chain[1].txs[0]), null);
    const full = replayHashOwed(chain);
    assert.equal(full.ok, true, full.reason);
    assert.equal(full.rows.length, rawRows.length);
    assert.equal(hashOwedRoot(full.rows).equals(hashOwedRoot(rawRows)), true);
    const prefix = replayHashOwed(chain.slice(0, 1));
    assert.equal(prefix.ok, true, prefix.reason);
    assert.equal(prefix.rows.length, 0);
    assert.equal(hashOwedRoot(prefix.rows).equals(hashOwedRoot([])), true);
    const again = replayHashOwed(chain);
    assert.equal(hashOwedRoot(again.rows).equals(hashOwedRoot(full.rows)), true);
    const when3 = when + TARGET_BLOCK_INTERVAL_MS;
    const parentHeader = child.header;
    const parentTime = Number(decodeHeader(Buffer.from(parentHeader)).timestamp);
    const q3 = asertNextBits({
      anchorBits: GENESIS_BITS_PACKED,
      anchorTimeMs: now,
      anchorHeight: 1,
      blockTimeMs: when3,
      blockHeight: 3,
      parentTimeMs: parentTime,
    });
    assert.equal(q3.ok, true, q3.reason);
    const next = buildTemplate({
      prev: sealedC.hash,
      prevHeader: parentHeader,
      prevBlock: chain[1],
      parentBlocks: chain,
      height: 3,
      miner: a,
      bits: q3.packed,
      now: when3,
      shareBatch: [],
    });
    const paid = (next.txs[0].vout || []).filter((o) => o.kind === 'hash');
    assert.ok(paid.length >= rawRows.length);
    const packedNext = compactTx(next.txs[0]);
    assert.equal(packedNext.hashOwed, undefined);
    assert.equal(packedNext.hashOwedRest, undefined);
    assert.equal(packedNext.hashOwedLocal, undefined);
    const wire = jsonWire(packedNext);
    assert.ok(wire.length + 1 < IPC_MAX_FRAME, `paying coinbase json ${wire.length}`);
  });
});
