import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest, hash20FromAddress } from '../../crypto/address.js';
import { GENESIS_BITS_PACKED, bitsForBlock } from '../../crypto/asert.js';
import { splitLevy } from '../../crypto/levy.js';
import { dest20OfShare } from '../../crypto/share_batch.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { sealCoinbaseNote, verifySealedNote, noteCommitOfDest20 } from '../../crypto/note.js';
import {
  buildTemplate,
  verifyBlock,
  digestTx,
  finderFeePays,
  GENESIS_PREV,
} from '../src/chain.js';

const TRUSTED = Buffer.alloc(32);
const T0 = 1_700_000_000_000;

function destOf(id) {
  return freshStealthDest(id).dest;
}

function blockOf(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    weight: tpl.weight,
    poolDest: tpl.poolDest || '',
  };
}

function reseal(tpl) {
  const decoded = decodeHeader(tpl.header);
  tpl.header = encodeHeader({
    ...decoded,
    merkleRoot: merkleRoot(tpl.txs.map(digestTx)),
  });
  return tpl;
}

describe('transaction fees pay miners', () => {
  it('an empty round pays the whole fee as one public finder-fee note', () => {
    const miner = destOf(newIdentity());
    for (const fee of [1, 100, 101]) {
      const tpl = buildTemplate({
        prev: GENESIS_PREV,
        height: 1,
        miner,
        bits: GENESIS_BITS_PACKED,
        now: T0,
        txs: [{ kind: 'claim', fee, vin: [{ address: miner }] }],
      });
      const notes = tpl.txs[0].vout.filter((o) => o.kind === 'finder-fee');
      assert.equal(notes.length, 1, String(fee));
      assert.equal(tpl.txs[0].vout.some((o) => o.kind === 'reserve-fee'), false);
      assert.equal(verifySealedNote(notes[0], fee), true);
      assert.ok(Buffer.from(notes[0].noteCommit).equals(noteCommitOfDest20(hash20FromAddress(miner))));
      assert.deepEqual(splitLevy(fee), { finder: fee, reserve: 0 });
      const got = verifyBlock(blockOf(tpl), null, { trustedPowHash: TRUSTED });
      assert.equal(got.ok, true, got.reason);
    }
  });

  it('a round with shares splits the whole fee by work and rejects a vault note', () => {
    const miner = destOf(newIdentity());
    const alice = destOf(newIdentity());
    const bob = destOf(newIdentity());
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner,
      bits: GENESIS_BITS_PACKED,
      now: T0,
    });
    const parent = blockOf(parentTpl);
    const okP = verifyBlock(parent, null, { trustedPowHash: TRUSTED });
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;
    const now = T0 + 90_000;
    const ph = decodeHeader(parent.header);
    const shares = [
      { dest20: dest20OfShare({ dest: alice }), dest: alice, nonce: 1n, lz: 8 },
      { dest20: dest20OfShare({ dest: bob }), dest: bob, nonce: 2n, lz: 8 },
      { dest20: dest20OfShare({ dest: bob }), dest: bob, nonce: 3n, lz: 8 },
      { dest20: dest20OfShare({ dest: bob }), dest: bob, nonce: 4n, lz: 8 },
    ];
    const fee = 1000;
    const tpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: shares,
      txs: [{ kind: 'claim', fee, vin: [{ address: miner }] }],
    });
    const pays = finderFeePays(tpl.shareBatch, fee, miner);
    const notes = tpl.txs[0].vout.filter((o) => o.kind === 'finder-fee');
    assert.equal(notes.length, pays.length);
    assert.equal(pays.reduce((a, p) => a + p.nanos, 0), fee);
    assert.equal(tpl.txs[0].vout.some((o) => o.kind === 'reserve-fee'), false);
    const byDest = new Map();
    for (const p of pays) byDest.set(p.address, (byDest.get(p.address) || 0) + p.nanos);
    assert.equal(byDest.size, 2);
    const small = Math.min(...byDest.values());
    const large = Math.max(...byDest.values());
    assert.equal(large, small * 3);
    assert.equal(byDest.has(miner), false);
    for (const p of pays) {
      const hit = notes.find((o) => Buffer.from(o.noteCommit).equals(Buffer.from(p.noteCommit)));
      assert.equal(verifySealedNote(hit, p.nanos), true);
    }
    const child = blockOf(tpl);
    const got = verifyBlock(child, { ...parent, hash: okP.hash, header: parent.header, height: 1 }, {
      trustedPowHash: TRUSTED,
      skipSharePow: true,
    });
    assert.equal(got.ok, true, got.reason);

    const whole = sealCoinbaseNote(fee, {
      dest20: hash20FromAddress(miner),
      kind: 'finder-fee',
    });
    tpl.txs[0].vout = tpl.txs[0].vout.filter((o) => o.kind !== 'finder-fee').concat([whole]);
    reseal(tpl);
    const redirected = verifyBlock(blockOf(tpl), { ...parent, hash: okP.hash, header: parent.header, height: 1 }, {
      trustedPowHash: TRUSTED,
      skipSharePow: true,
    });
    assert.equal(redirected.ok, false);
    assert.equal(redirected.reason, 'levy_split');

    const fresh = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: shares,
      txs: [{ kind: 'claim', fee, vin: [{ address: miner }] }],
    });
    fresh.txs[0].vout.push({ kind: 'reserve-fee', nanos: 1, address: miner });
    reseal(fresh);
    const vaulted = verifyBlock(blockOf(fresh), { ...parent, hash: okP.hash, header: parent.header, height: 1 }, {
      trustedPowHash: TRUSTED,
      skipSharePow: true,
    });
    assert.equal(vaulted.ok, false);
    assert.equal(vaulted.reason, 'levy_split');
  });
});
