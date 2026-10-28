// Transaction fees pay miners, under R28 (as built, Russell 28 Oct). The
// finder levy is the whole fee (FEE_SPLIT_FINDER_BPS = 10000). A round with
// shares adds it to the draw's T, so it is paid by work through the k drawn
// notes, never as a public finder-fee note. An empty round with no fee key
// pays it with the reserve levy note. The shares here are real BluNotes
// frames, ground with ShearHash on the parent header.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest, hash20FromAddress } from '../../crypto/address.js';
import { GENESIS_BITS_PACKED, bitsForBlock } from '../../crypto/asert.js';
import { reserveFeeDest, splitLevy } from '../../crypto/levy.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { sealCoinbaseNote, openedCoinbaseNanos, excessOf } from '../../crypto/note.js';
import { BLUNOTE_WINNERS, decodeRecord, drawPieces } from '../../crypto/blunote.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { buildTemplate, verifyBlock, digestTx, GENESIS_PREV } from '../src/chain.js';
import { bluWallet, mineBluShare, ownBluNotes } from './support/blunote_mine.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

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
  it('an empty round with no fee key pays the whole fee with the reserve note, never a public finder note', () => {
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
      assert.deepEqual(splitLevy(fee), { finder: fee, reserve: 0 });
      assert.equal(tpl.txs[0].vout.some((o) => o.kind === 'finder-fee'), false, String(fee));
      const reserve = tpl.txs[0].vout.filter((o) => o.kind === 'reserve-fee');
      assert.equal(reserve.length, 1, String(fee));
      assert.equal(openedCoinbaseNanos(reserve[0]), fee);
      assert.ok(Buffer.from(reserve[0].dest20).equals(Buffer.from(hash20FromAddress(reserveFeeDest()))));
      const got = verifyBlock(blockOf(tpl), null, { trustedPowHash: TRUSTED });
      assert.equal(got.ok, true, got.reason);
    }
  });

  it('a round with shares adds the whole fee to the draw, and refuses a planted reserve or finder note', () => {
    const miner = destOf(newIdentity());
    const alice = bluWallet();
    const bob = bluWallet();
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
    parent.blunoteRecord = okP.blunoteRecord;
    const prevView = { ...parent, hash: okP.hash, header: parent.header, height: 1 };
    const now = T0 + 90_000;
    const ph = decodeHeader(parent.header);
    // One share for alice and three for bob, each its own one-time key.
    const shares = [alice, bob, bob, bob].map((w) => mineBluShare(w, parent.header));
    const fee = 1000;
    const childOf = (txs) => buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: shares,
      txs,
    });
    const tpl = childOf([{ kind: 'claim', fee, vin: [{ address: miner }] }]);
    assert.equal(tpl.shareBatch.length, shares.length);
    assert.equal(tpl.txs[0].vout.some((o) => o.kind === 'finder-fee'), false);
    assert.equal(tpl.txs[0].vout.some((o) => o.kind === 'reserve-fee'), false, 'with shares the levy is not the reserve note');
    const got = verifyBlock(blockOf(tpl), prevView, { trustedPowHash: TRUSTED });
    assert.equal(got.ok, true, got.reason);
    const rec = decodeRecord(Buffer.from(got.blunoteRecord, 'hex'));
    // The same round with no fee: T differs by exactly the levy.
    const bare = verifyBlock(blockOf(childOf([])), prevView, { trustedPowHash: TRUSTED });
    assert.equal(bare.ok, true, bare.reason);
    const bareRec = decodeRecord(Buffer.from(bare.blunoteRecord, 'hex'));
    assert.equal(rec.n, shares.length);
    assert.equal(rec.T - bareRec.T, BigInt(splitLevy(fee).finder), 'the whole fee joined T');
    // The k pieces are paid to the share keys only; the remainder is the carry.
    const { piece, carry } = drawPieces(rec.T, BLUNOTE_WINNERS);
    assert.equal(BigInt(tpl.txs[0].carryNanos), carry);
    const paidA = ownBluNotes(alice, got.blunoteRecord).reduce((a, n) => a + n.v, 0n);
    const paidB = ownBluNotes(bob, got.blunoteRecord).reduce((a, n) => a + n.v, 0n);
    assert.equal(paidA + paidB, piece * BigInt(BLUNOTE_WINNERS), 'every drawn piece is a share key\'s');
    assert.equal(ownBluNotes(bluWallet(), got.blunoteRecord).length, 0);

    const finderNote = sealCoinbaseNote(fee, { dest20: hash20FromAddress(miner), kind: 'finder-fee' });
    tpl.txs[0].vout = tpl.txs[0].vout.concat([finderNote]);
    tpl.txs[0].excess = excessOf(tpl.txs[0].vout);
    reseal(tpl);
    const redirected = verifyBlock(blockOf(tpl), prevView, { trustedPowHash: TRUSTED });
    assert.equal(redirected.ok, false);
    assert.equal(redirected.reason, 'blunote_vout');

    const fresh = childOf([{ kind: 'claim', fee, vin: [{ address: miner }] }]);
    fresh.txs[0].vout.push(sealCoinbaseNote(1, {
      dest20: hash20FromAddress(reserveFeeDest()),
      kind: 'reserve-fee',
    }));
    fresh.txs[0].excess = excessOf(fresh.txs[0].vout);
    reseal(fresh);
    const vaulted = verifyBlock(blockOf(fresh), prevView, { trustedPowHash: TRUSTED });
    assert.equal(vaulted.ok, false);
    assert.equal(vaulted.reason, 'levy_split');
  });
});
