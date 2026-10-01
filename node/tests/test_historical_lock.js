import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChainBin } from '../../crypto/chainbin.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  nextBits,
  medianIntervalMs,
  MAGIC_TESTNET,
  SPENDABLE_CONFIRMATIONS,
  consensusFingerprint,
} from '../../crypto/asert.js';
import { verifyBlock, headerGapsMs } from '../src/chain.js';
import { applyReserveBlock, emptyVault } from '../../crypto/reserve_vault.js';
import { HISTORICAL_TIP, isHistoricalHeader } from '../../crypto/historical_prefix.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lock-prefix-chain.bin');

function ancestors(blocks, index) {
  return blocks.slice(0, index);
}

describe('sealed reserve-lock prefix', () => {
  it('median work rejects the lock headers and the sealed prefix still verifies', async () => {
    const blocks = readChainBin(fixture);
    assert.equal(blocks.length, 23);
    assert.equal(Buffer.from(blocks[blocks.length - 1].hash).toString('hex'), HISTORICAL_TIP);
    const gaps = [];
    let firstMedianMiss = null;
    for (let i = 1; i < blocks.length; i += 1) {
      const parent = decodeHeader(Buffer.from(blocks[i - 1].header));
      const child = decodeHeader(Buffer.from(blocks[i].header));
      const d = Number(child.timestamp) - Number(parent.timestamp);
      gaps.push(Number.isFinite(d) && d > 0 ? d : 90_000);
      const medianWant = nextBits(parent.bits, medianIntervalMs(gaps), MAGIC_TESTNET);
      if (child.bits !== medianWant && !firstMedianMiss) {
        firstMedianMiss = { height: blocks[i].height, bits: child.bits, medianWant };
      }
    }
    assert.ok(firstMedianMiss);
    assert.equal(firstMedianMiss.height, 3);
    assert.notEqual(firstMedianMiss.bits, firstMedianMiss.medianWant);
    console.log(`CURVE_REJECT height=${firstMedianMiss.height} bits=${firstMedianMiss.bits} medianWant=${firstMedianMiss.medianWant}`);

    let lockHeight = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      const prev = i === 0 ? null : {
        hash: blocks[i - 1].hash,
        header: blocks[i - 1].header,
        height: blocks[i - 1].height,
        txs: blocks[i - 1].txs,
        weight: blocks[i - 1].weight,
      };
      const prior = ancestors(blocks, i);
      const got = await verifyBlock(block, prev, {
        trustedPowHash: block.hash,
        magic: MAGIC_TESTNET,
        nowMs: Date.now(),
        evmHistory: prior,
        grandparentHeader: prior.length >= 2 ? prior[prior.length - 2].header : null,
        sealedIntervalsMs: headerGapsMs(prior),
        mtpTimestamps: prior.slice(-11).map((b) => Number(decodeHeader(Buffer.from(b.header)).timestamp)),
      });
      assert.equal(got.ok, true, `height ${block.height} ${got.reason}`);
      if ((block.txs || []).some((tx) => tx && tx.kind === 'lock')) lockHeight = block.height;
    }
    assert.equal(lockHeight, 18);

    const mutated = Buffer.from(blocks[2].header);
    mutated[112] ^= 0x01;
    assert.equal(isHistoricalHeader(mutated), false);
    const parent = {
      hash: blocks[1].hash,
      header: blocks[1].header,
      height: blocks[1].height,
      txs: blocks[1].txs,
      weight: blocks[1].weight,
    };
    const prior = ancestors(blocks, 2);
    const rejected = await verifyBlock({ ...blocks[2], header: mutated }, parent, {
      trustedPowHash: blocks[2].hash,
      magic: MAGIC_TESTNET,
      nowMs: Date.now(),
      evmHistory: prior,
      grandparentHeader: prior.length >= 2 ? prior[prior.length - 2].header : null,
      sealedIntervalsMs: headerGapsMs(prior),
      mtpTimestamps: prior.slice(-11).map((b) => Number(decodeHeader(Buffer.from(b.header)).timestamp)),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'bits');

    const vault = emptyVault();
    for (const block of blocks) {
      const ts = Number(decodeHeader(Buffer.from(block.header)).timestamp);
      applyReserveBlock({ state: vault, block, nowMs: ts });
    }
    const locked = BigInt(vault.totalLockedNanos);
    assert.equal(locked, 400000000000n);
    const confs = blocks[blocks.length - 1].height - lockHeight + 1;
    assert.equal(confs, 6);
    assert.ok(confs < SPENDABLE_CONFIRMATIONS);
    assert.match(consensusFingerprint(), new RegExp(`HISTORICAL_TIP=${HISTORICAL_TIP}`));
    assert.match(consensusFingerprint(), /NETWORK=shear-testnet-v10/);
    assert.match(consensusFingerprint(), /ASERT_STEP=median11/);
    console.log(`LOCK_PRESENT height=${lockHeight} nanos=${locked} confs=${confs} need=${SPENDABLE_CONFIRMATIONS} tip=${blocks[blocks.length - 1].height}`);
  });
});
