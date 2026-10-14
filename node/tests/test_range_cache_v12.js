/**
 * The coinbase range cache is a process-wide skip of proofs already accepted.
 * V8 throws RangeError from Set.add at 2^24 entries. Any output count and any
 * chain length must keep verifying, with the cache at or under its cap.
 * The full-history audit verifies and does not record those keys.
 * The pool publish does not verify them on the caller.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyNanos } from '../../crypto/pot_sched.js';
import { MAGIC_TESTNET, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { excessOf } from '../../crypto/note.js';
import { coinbaseTx } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { networkSupply, networkSupplySettled } from '../../pool/src/wallet_api.js';
import {
  RANGE_VERIFIED_CAP,
  auditCirculatingSupply,
  coinbaseRangeVerifies,
  emptySupplyState,
  foldSupply,
  rangeVerifiedInserts,
  rangeVerifiedSize,
  rememberVerifiedRange,
  supplyStep,
} from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const V8_SET_MAX = 2 ** 24;
const OUTPUT_COUNTS = [1, 3, 7];

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function splitSum(total, n) {
  const count = Math.max(1, Math.floor(n));
  const base = Math.floor(total / count);
  const parts = Array.from({ length: count }, () => base);
  let rem = total - base * count;
  for (let i = 0; rem > 0; i += 1, rem -= 1) parts[i % count] += 1;
  return parts;
}

function potBlock(ts, height, miner, notes) {
  const potNotes = notes.filter((n) => n.kind !== 'finder-fee' && n.kind !== 'reserve-fee' && n.kind !== 'hash');
  const shares = potNotes.map((n) => ({
    address: n.address || miner,
    nanos: n.nanos,
    kind: n.kind || 'pot',
  }));
  const tx = coinbaseTx({
    height,
    miner,
    potShares: shares,
    potNanos: shares.reduce((a, s) => a + s.nanos, 0),
    carryNanos: 0,
    shareBatch: [],
  });
  tx.vout = (tx.vout || []).filter((o) => String(o?.kind || '') !== 'hash');
  tx.excess = excessOf(tx.vout);
  const hash = Buffer.alloc(32);
  hash.writeUInt32BE(height, 28);
  return {
    header: encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: ts,
      bits: 16,
    }),
    txs: [tx],
    shareBatch: [],
    height,
    hash,
  };
}

describe('v12 range-proof cache stays under the engine limit', () => {
  it('verifies past 2^24 outputs, and the audit does not fill the cache', { timeout: 600_000 }, async () => {
    assert.ok(RANGE_VERIFIED_CAP >= 1);
    assert.ok(RANGE_VERIFIED_CAP < V8_SET_MAX);
    const miner = minerDest();
    const subsidy = potSubsidyNanos(0);
    const blocks = OUTPUT_COUNTS.map((count, i) => {
      const parts = splitSum(subsidy, count);
      assert.equal(parts.reduce((a, n) => a + n, 0), subsidy);
      assert.equal(parts.length, count);
      return potBlock(
        GENESIS + i * TARGET_BLOCK_INTERVAL_MS,
        i + 1,
        miner,
        parts.map((nanos) => ({ nanos, kind: 'pot' })),
      );
    });
    const outputs = blocks.reduce((n, block) => n + (block.txs[0].vout || []).length, 0);
    assert.ok(outputs >= OUTPUT_COUNTS.length);

    const past = V8_SET_MAX + outputs;
    for (let i = 0; i < past; i += 1) {
      rememberVerifiedRange(String(i));
      if (rangeVerifiedSize() > RANGE_VERIFIED_CAP) {
        throw new Error(`cache grew to ${rangeVerifiedSize()} at ${i + 1}`);
      }
      if ((i + 1) % (2 ** 22) === 0) {
        process.stderr.write(`range-cache ${i + 1} size ${rangeVerifiedSize()}\n`);
      }
    }
    assert.equal(rangeVerifiedSize(), RANGE_VERIFIED_CAP);
    assert.equal(rangeVerifiedInserts(), past);
    process.stderr.write(`range-cache filled ${past} size ${rangeVerifiedSize()}\n`);

    const inserts = rangeVerifiedInserts();
    const size = rangeVerifiedSize();
    const beforeAudit = coinbaseRangeVerifies();
    const audited = auditCirculatingSupply(blocks);
    assert.equal(audited.status, 'verified', audited.reason);
    assert.equal(rangeVerifiedInserts(), inserts);
    assert.equal(rangeVerifiedSize(), size);
    const afterAudit = coinbaseRangeVerifies();
    assert.equal(afterAudit - beforeAudit, outputs);

    const netInserts = rangeVerifiedInserts();
    const net = networkSupply({ blocks, reserveVault: {} });
    assert.equal(net.supplyStatus, 'pending');
    assert.equal(rangeVerifiedInserts(), netInserts);
    assert.equal(rangeVerifiedSize(), size);
    const afterNet = coinbaseRangeVerifies();
    assert.equal(afterNet - afterAudit, 0);
    const settled = await networkSupplySettled({ blocks, reserveVault: {} });
    assert.equal(settled.supplyStatus, 'verified', settled.supplyReason);
    assert.equal(coinbaseRangeVerifies(), afterNet);
    assert.equal(rangeVerifiedInserts(), netInserts);

    const folded = foldSupply(blocks, { genesisMs: GENESIS, magic: MAGIC_TESTNET });
    assert.equal(folded.ok, true, folded.reason);
    assert.equal(rangeVerifiedInserts() - inserts, outputs);
    assert.ok(rangeVerifiedSize() <= RANGE_VERIFIED_CAP);
    const afterFold = coinbaseRangeVerifies();
    assert.equal(afterFold - afterNet, outputs);

    const again = foldSupply(blocks, { genesisMs: GENESIS, magic: MAGIC_TESTNET });
    assert.equal(again.ok, folded.ok);
    assert.equal(again.reason, folded.reason);
    assert.equal(String(again.state.mintedPot), String(folded.state.mintedPot));
    assert.equal(String(again.state.mintedHash), String(folded.state.mintedHash));
    assert.equal(coinbaseRangeVerifies(), afterFold);
    assert.equal(rangeVerifiedInserts(), inserts + outputs);

    for (let i = 0; i < RANGE_VERIFIED_CAP; i += 1) rememberVerifiedRange(`window-${i}`);
    const beforeMiss = coinbaseRangeVerifies();
    const missed = foldSupply(blocks, { genesisMs: GENESIS, magic: MAGIC_TESTNET });
    assert.equal(missed.ok, true, missed.reason);
    assert.equal(missed.reason, folded.reason);
    assert.equal(String(missed.state.mintedPot), String(folded.state.mintedPot));
    assert.equal(coinbaseRangeVerifies() - beforeMiss, outputs);
    assert.ok(rangeVerifiedSize() <= RANGE_VERIFIED_CAP);

    const one = supplyStep(emptySupplyState(GENESIS), blocks[0], {
      height: 1,
      genesisMs: GENESIS,
      magic: MAGIC_TESTNET,
      tipHeight: 1,
      blockHash: blocks[0].hash,
    });
    assert.equal(one.ok, true, one.reason);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-range-cache-'));
    try {
      const store = createStore(dir);
      const who = minerDest();
      const { tpl } = store.template({ miner: who, shareBits: 4, now: GENESIS });
      const appended = await Promise.resolve(store.append({
        header: tpl.header,
        txs: tpl.txs,
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: who,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        weight: tpl.weight,
      }, {
        trustedPowHash: Buffer.from(blocks[0].hash),
        skipSharePow: true,
      }));
      assert.equal(appended.ok, true, appended.reason);
      assert.equal(store.tip().height, 1);
      fs.rmSync(path.join(dir, 'book.snap'), { force: true });
      for (let i = 0; i < RANGE_VERIFIED_CAP; i += 1) rememberVerifiedRange(`load-${i}`);
      const loaded = createStore(dir);
      assert.equal(loaded.loadMode, 'full', loaded.loadMode);
      assert.equal(loaded.tip().height, 1);
      assert.ok(rangeVerifiedSize() <= RANGE_VERIFIED_CAP);
      const loadInserts = rangeVerifiedInserts();
      const loadSize = rangeVerifiedSize();
      const live = auditCirculatingSupply(loaded.blocks);
      assert.equal(live.status, 'verified', live.reason);
      const published = networkSupply(loaded);
      assert.equal(published.supplyStatus, 'verified', published.supplyReason);
      assert.equal(rangeVerifiedInserts(), loadInserts);
      assert.equal(rangeVerifiedSize(), loadSize);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
