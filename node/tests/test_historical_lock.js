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
  MAGIC_TESTNET_V11,
  SPENDABLE_CONFIRMATIONS,
  GENESIS_BITS_PACKED,
  consensusFingerprint,
} from '../../crypto/asert.js';
import { verifyBlock, headerGapsMs } from '../src/chain.js';
import { applyReserveBlock, emptyVault } from '../../crypto/reserve_vault.js';
import { HISTORICAL_TIP, isHistoricalHeader, matchesHistoricalPrefix } from '../../crypto/historical_prefix.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lock-prefix-chain.bin');

describe('sealed reserve-lock prefix', () => {
  it('median work rejects the lock headers and the live v12 rules refuse the sealed prefix', async () => {
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

    // The fixture is the sealed v10 lock prefix: genesis bits 15, a public
    // lock with from/to/payoutPortalId and no vault lock note. The live book
    // is v12. Since 250bded3 its genesis seed is GENESIS_BITS 17, and v12 has
    // no closed-book carve-out (chain.js assessHeader, closedBook). So the
    // live rules refuse this prefix at its first header, and the v12 vault
    // does not credit its lock. The prefix stays a sealed historical record.
    assert.equal(matchesHistoricalPrefix(blocks), true);
    for (const block of blocks) assert.equal(isHistoricalHeader(Buffer.from(block.header)), true);
    const genesisBits = decodeHeader(Buffer.from(blocks[0].header)).bits;
    assert.notEqual(genesisBits, GENESIS_BITS_PACKED);
    const first = await verifyBlock(blocks[0], null, {
      trustedPowHash: blocks[0].hash,
      magic: MAGIC_TESTNET,
      nowMs: Date.now(),
      evmHistory: [],
      grandparentHeader: null,
      sealedIntervalsMs: headerGapsMs([]),
      mtpTimestamps: [],
    });
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'bits');

    let lockHeight = 0;
    for (const block of blocks) {
      if ((block.txs || []).some((tx) => tx && tx.kind === 'lock')) lockHeight = block.height;
    }
    assert.equal(lockHeight, 18);

    const mutated = Buffer.from(blocks[2].header);
    mutated[112] ^= 0x01;
    assert.equal(isHistoricalHeader(mutated), false);

    const vault = emptyVault();
    for (const block of blocks) {
      const ts = Number(decodeHeader(Buffer.from(block.header)).timestamp);
      applyReserveBlock({ state: vault, block, nowMs: ts });
    }
    // A lock with no vault lock note is stake_reward on v12. Nothing is locked.
    const locked = BigInt(vault.totalLockedNanos);
    assert.equal(locked, 0n);
    const confs = blocks[blocks.length - 1].height - lockHeight + 1;
    assert.equal(confs, 6);
    assert.ok(confs < SPENDABLE_CONFIRMATIONS);
    assert.doesNotMatch(consensusFingerprint(), /HISTORICAL_TIP=/);
    assert.match(consensusFingerprint(), /NETWORK=shear-testnet-v12/);
    assert.match(consensusFingerprint(), /RESERVE_NOTE=withdraw-levy-pull/);
    assert.match(consensusFingerprint(), /ASERT_STEP=aserti3-2d/);
    assert.match(consensusFingerprint(MAGIC_TESTNET_V11), new RegExp(`HISTORICAL_TIP=${HISTORICAL_TIP}`));
    console.log(`LOCK_PRESENT height=${lockHeight} nanos=${locked} confs=${confs} need=${SPENDABLE_CONFIRMATIONS} tip=${blocks[blocks.length - 1].height}`);
  });
});
