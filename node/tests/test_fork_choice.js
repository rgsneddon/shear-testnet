import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import {
  asertNextBits,
  consensusFingerprint,
  nextBits,
  TARGET_BLOCK_INTERVAL_MS,
} from '../../crypto/asert.js';
import { decodeHeader } from '../../crypto/header.js';
import { createStore } from '../src/store.js';
import { shouldAdopt } from '../src/chain.js';
import {
  decodeWireBlock,
  encodeWireBlock,
  isFinalIngestFail,
  jsonWire,
  unconnectedHeader,
} from '../src/p2p.js';

function dest(byte) {
  return encodeDest(Buffer.alloc(20, byte));
}

function seal(store, { miner, now, bits, pow }) {
  const args = { miner, now };
  if (bits != null) args.bits = bits;
  const { job } = store.template(args);
  return store.submitHeader({
    jobId: job.jobId,
    nonce: 0n,
    miner,
    powHash: pow,
  }, { trusted: true });
}

function trust(block) {
  return { trustedPowHash: Buffer.from(block.hash), skipSharePow: true };
}

describe('fork choice does not follow the first block or the pool', () => {
  it('equal work follows the lower tip hash, then more work from either side', () => {
    const genesisPow = `${'00'.repeat(31)}11`;
    const lowPow = `${'00'.repeat(31)}01`;
    const highPow = `${'00'.repeat(31)}ff`;
    const laterPow = `${'00'.repeat(31)}22`;
    assert.ok(lowPow < highPow);
    const t0 = 1_700_000_000_000;
    const minerA = dest(3);
    const minerB = dest(9);

    const a = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-a-')));
    const b = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-b-')));
    const genesisGot = seal(a, { miner: minerA, now: t0, pow: genesisPow });
    assert.equal(genesisGot.ok, true, genesisGot.reason);
    const genesis = a.blocks[0];
    assert.equal(b.ingest([genesis], trust(genesis)).ok, true);

    const childA = seal(a, { miner: minerA, now: t0 + 1_000, pow: lowPow });
    assert.equal(childA.ok, true, childA.reason);
    const parent = decodeHeader(Buffer.from(genesis.header));
    const sealed = decodeHeader(Buffer.from(a.tip().header));
    assert.equal(a.tip().height, 2);
    const quote = asertNextBits({
      anchorBits: parent.bits,
      anchorTimeMs: Number(parent.timestamp),
      anchorHeight: 1,
      blockTimeMs: Number(sealed.timestamp),
      blockHeight: a.tip().height,
      parentTimeMs: Number(parent.timestamp),
    });
    assert.equal(quote.ok, true, quote.reason);
    assert.equal(quote.easeBits, 0);
    assert.equal(sealed.bits, quote.packed);
    const gap = Number(sealed.timestamp) - Number(parent.timestamp);
    assert.notEqual(gap, TARGET_BLOCK_INTERVAL_MS);
    assert.notEqual(sealed.bits, nextBits(parent.bits, TARGET_BLOCK_INTERVAL_MS));

    const childB = seal(b, { miner: minerB, now: t0 + 1_000, pow: highPow });
    assert.equal(childB.ok, true, childB.reason);
    const privateTip = Buffer.from(b.tip().hash).toString('hex');
    assert.equal(shouldAdopt(b.blocks, a.blocks), true);
    assert.equal(shouldAdopt(a.blocks, b.blocks), false);

    const joined = b.ingest([a.blocks[1]], trust(a.blocks[1]));
    assert.equal(joined.ok, true, joined.reason);
    assert.equal(joined.reason, undefined);
    assert.notEqual(joined.reason, 'admit_membership');
    assert.equal(Buffer.from(b.tip().hash).equals(Buffer.from(a.tip().hash)), true);
    assert.equal(b.sideTipHash(), privateTip);
    assert.equal(isFinalIngestFail('side_hold'), false);
    assert.equal(isFinalIngestFail('not_heavier'), false);
    assert.match(consensusFingerprint(), /FORK=work-then-lowhash/);
    assert.equal(consensusFingerprint().includes('11.0'), false);
    assert.equal(consensusFingerprint().includes('12.0'), false);
    assert.equal(consensusFingerprint().includes('13.0'), false);
    assert.equal(consensusFingerprint().includes('0.61'), false);
    assert.equal(consensusFingerprint().includes('0.62'), false);
    assert.equal(consensusFingerprint().includes('0.63'), false);

    const heavy = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-heavy-')));
    const light = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-light-')));
    assert.equal(heavy.ingest([genesis], trust(genesis)).ok, true);
    assert.equal(light.ingest([genesis], trust(genesis)).ok, true);
    assert.equal(seal(heavy, { miner: minerB, now: t0 + 1_000, pow: highPow }).ok, true);
    assert.equal(seal(light, { miner: minerA, now: t0 + 1_000, pow: lowPow }).ok, true);
    assert.equal(seal(heavy, { miner: minerB, now: t0 + 2_000, pow: laterPow }).ok, true);
    const held = light.ingest([heavy.blocks[1]], trust(heavy.blocks[1]));
    assert.equal(held.ok, false, held.reason);
    assert.equal(held.reason, 'side_hold');
    assert.equal(light.sideTipHash(), Buffer.from(heavy.blocks[1].hash).toString('hex'));
    const won = light.ingest([heavy.blocks[2]], trust(heavy.blocks[2]));
    assert.equal(won.ok, true, won.reason);
    assert.equal(Buffer.from(light.tip().hash).equals(Buffer.from(heavy.tip().hash)), true);
    assert.equal(shouldAdopt(a.blocks, heavy.blocks), true);
  });

  it('a second genesis is fetched when it does not connect, and the lower hash becomes the chain', () => {
    const t0 = 1_700_000_000_000;
    const low = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-g1-')));
    const high = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-g2-')));
    assert.equal(seal(low, { miner: dest(4), now: t0, pow: `${'00'.repeat(31)}01` }).ok, true);
    assert.equal(seal(high, { miner: dest(5), now: t0 + 1_000, pow: `${'00'.repeat(31)}0a` }).ok, true);
    assert.equal(shouldAdopt(high.blocks, low.blocks), true);
    const loser = high.blocks[0];
    const switched = high.ingest([low.blocks[0]], trust(low.blocks[0]));
    assert.equal(switched.ok, true, switched.reason);
    assert.equal(Buffer.from(high.tip().hash).equals(Buffer.from(low.tip().hash)), true);
    assert.equal(high.sideTipHash(), Buffer.from(loser.hash).toString('hex'));
    const stay = low.ingest([loser], trust(loser));
    assert.equal(stay.ok, false);
    assert.equal(stay.reason, 'side_hold');
    assert.equal(Buffer.from(low.tip().hash).equals(Buffer.from(low.blocks[0].hash)), true);

    const page = unconnectedHeader({
      headers: [
        { hash: 'aa'.repeat(32), height: 1, header: '00'.repeat(80) },
        { hash: 'bb'.repeat(32), height: 2, header: '00'.repeat(80) },
      ],
      have: new Set(['aa'.repeat(32)]),
    });
    assert.equal(page.hash, 'bb'.repeat(32));
    assert.equal(page.height, 2);
  });

  it('a block this code seals still verifies after the p2p wire round trip', () => {
    const t0 = 1_700_000_000_000;
    const miner = dest(7);
    const src = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wire-src-')));
    assert.equal(seal(src, { miner, now: t0, pow: `${'00'.repeat(31)}31` }).ok, true);
    const parentTs = Number(decodeHeader(Buffer.from(src.tip().header)).timestamp);
    const child = seal(src, { miner, now: parentTs + 1_000, pow: `${'00'.repeat(31)}32` });
    assert.equal(child.ok, true, child.reason);
    const fresh = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wire-dst-')));
    for (const block of src.blocks) {
      const msg = JSON.parse(jsonWire({ type: 'block', block: encodeWireBlock(block) }));
      const back = decodeWireBlock(msg.block);
      const got = fresh.ingest([back], trust(block));
      assert.equal(got.ok, true, `${got.reason || 'ingest'} at height ${block.height}`);
      assert.notEqual(got.reason, 'admit_membership');
    }
    assert.equal(fresh.tip().height, src.tip().height);
    assert.equal(Buffer.from(fresh.tip().hash).equals(Buffer.from(src.tip().hash)), true);
    assert.equal(isFinalIngestFail('admit_membership'), false);
  });
});
