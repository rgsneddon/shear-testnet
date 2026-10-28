// The finder levy under R28 (as built, Russell 28 Oct): it never becomes a
// public finder-fee note. With shares it joins the draw (T). In an empty
// round it goes to the coinbase's one-time fee key, or, with no key, into
// the reserve levy note. It never enters the carry, so the carry is always
// pot money. Every case is checked on the template and by verifyBlock.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { GENESIS_BITS_PACKED, POOL_FEE_BPS } from '../../crypto/asert.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { FEE_SPLIT_FINDER_BPS, reserveFeeDest, splitLevy } from '../../crypto/levy.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { excessOf, openedCoinbaseNanos, sealCoinbaseNote } from '../../crypto/note.js';
import { decodeRecord, oneTimeKey, recogniseOneTime } from '../../crypto/blunote.js';
import { emptyVault, applyReserveBlock } from '../../crypto/reserve_vault.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { GENESIS_PREV, buildTemplate, templateForFinder, verifyBlock, digestTx } from '../src/chain.js';
import { bluWallet } from './support/blunote_mine.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const NOW = 1_700_000_000_000;
const FEES = [0, 1, 2, 3, 100, 999, 1000, 1_048_576, (2 ** 20) + 3];
const TRUSTED = Buffer.alloc(32);

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function dest20(addr) {
  return Buffer.from(hash20FromAddress(addr));
}

function same20(note, addr) {
  return !!(note?.dest20 && Buffer.from(note.dest20).equals(dest20(addr)));
}

function feeKeyOf(w) {
  const k = oneTimeKey(w);
  return { R: k.R, P: k.P, viewTag: k.tag };
}

function resealed(tpl, txs) {
  const decoded = decodeHeader(Buffer.from(tpl.header));
  return {
    header: encodeHeader({ ...decoded, merkleRoot: merkleRoot(txs.map(digestTx)), nonce: 0n }),
    txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height: tpl.height,
  };
}

/** A genesis template whose body is one claim paying `fee`. */
function genesisWith(fee, extra = {}) {
  const miner = minerDest();
  return buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner,
    bits: GENESIS_BITS_PACKED,
    now: NOW,
    txs: fee ? [{ kind: 'claim', fee, vin: [{ address: miner }] }] : [],
    ...extra,
  });
}

function verified(tpl) {
  return verifyBlock(resealed(tpl, tpl.txs), null, { trustedPowHash: TRUSTED });
}

describe('the finder levy joins the draw and is never a public note', () => {
  it('the split is all finder: there is no separate reserve half', () => {
    assert.equal(FEE_SPLIT_FINDER_BPS, 10000);
    for (const fee of FEES) assert.deepEqual(splitLevy(fee), { finder: fee, reserve: 0 });
  });

  it('an empty round with no fee key pays its finder levy with the reserve note, and the carry stays pot money', () => {
    const base = genesisWith(0);
    const potCarry = Number(base.txs[0].carryNanos);
    assert.ok(potCarry > 0, 'an empty round carries its pot');
    for (const fee of FEES) {
      const split = splitLevy(fee);
      const tpl = genesisWith(fee, { finderDest: minerDest(), poolDest: minerDest(), feeDest: minerDest() });
      const cb = tpl.txs[0];
      assert.equal(cb.vout.some((o) => o.kind === 'finder-fee'), false, `fee ${fee}: no public finder note`);
      const reserve = cb.vout.filter((o) => o.kind === 'reserve-fee');
      assert.equal(Number(cb.carryNanos), potCarry, `fee ${fee}: the levy never enters the carry`);
      if (fee === 0) {
        assert.equal(reserve.length, 0);
      } else {
        assert.equal(reserve.length, 1, `fee ${fee}`);
        assert.equal(openedCoinbaseNanos(reserve[0]), split.finder + split.reserve, `fee ${fee}`);
        assert.equal(same20(reserve[0], reserveFeeDest()), true, `fee ${fee}`);
      }
      // Nothing to aim: the template is handed back as it is.
      assert.equal(templateForFinder(tpl, minerDest()), tpl, `fee ${fee}`);
      const got = verified(tpl);
      assert.equal(got.ok, true, `fee ${fee} ${got.reason}`);
      const rec = decodeRecord(Buffer.from(got.blunoteRecord, 'hex'));
      assert.equal(rec.n, 0);
      assert.equal(rec.feeV, 0n, `fee ${fee}: no key, no fee note`);
      // The reserve note pays the reserve's own dest. The vault's fee bank is
      // retired (reserve_vault.js creditFeeBank keeps it at 0), so the note,
      // not a bank counter, is what the reserve holds.
      const state = emptyVault();
      applyReserveBlock({ state, block: { txs: [cb] }, nowMs: NOW });
      assert.equal(Number(state.feeBankNanos), 0, `fee ${fee}: no fee bank counter`);
      if (fee === 0) continue;
      // The reserve note redirected to a finder: verify refuses the coinbase.
      const finder = minerDest();
      // Sealed to the finder's own dest20, so its label is its own: only the
      // levy rule can refuse it.
      const toFinder = sealCoinbaseNote(fee, { kind: 'reserve-fee', dest20: dest20(finder) });
      const stolenVout = cb.vout.map((o) => (o.kind === 'reserve-fee' ? toFinder : o));
      const stolenCb = { ...cb, vout: stolenVout, excess: excessOf(stolenVout) };
      const stolen = verifyBlock(resealed(tpl, [stolenCb, ...tpl.txs.slice(1)]), null, { trustedPowHash: TRUSTED });
      assert.equal(stolen.ok, false, `fee ${fee}`);
      assert.equal(stolen.reason, 'levy_split', `fee ${fee}`);
      // A planted public finder-fee note for the finder is refused: an R28
      // coinbase carries only the reserve levy note.
      const planted = sealCoinbaseNote(split.finder, { kind: 'finder-fee', dest20: dest20(finder) });
      const plantedVout = cb.vout.filter((o) => o.kind !== 'reserve-fee').concat([planted]);
      const plantedCb = { ...cb, vout: plantedVout, excess: excessOf(plantedVout) };
      const aimed = verifyBlock(resealed(tpl, [plantedCb, ...tpl.txs.slice(1)]), null, { trustedPowHash: TRUSTED });
      assert.equal(aimed.ok, false, `fee ${fee}`);
      assert.equal(aimed.reason, 'blunote_vout', `fee ${fee}`);
    }
  });

  it('an empty round with a fee key pays its finder levy to that key, and only its owner finds it', () => {
    const pool = bluWallet();
    const stranger = bluWallet();
    const key = feeKeyOf(pool);
    const base = verified(genesisWith(0, { feeKey: key, feeBps: POOL_FEE_BPS }));
    assert.equal(base.ok, true, base.reason);
    const poolFee = decodeRecord(Buffer.from(base.blunoteRecord, 'hex')).feeV;
    assert.ok(poolFee > 0n, 'the pool fee is a piece of the subsidy');
    const baseCarry = Number(genesisWith(0, { feeKey: key, feeBps: POOL_FEE_BPS }).txs[0].carryNanos);
    for (const fee of FEES) {
      const split = splitLevy(fee);
      const tpl = genesisWith(fee, { feeKey: key, feeBps: POOL_FEE_BPS });
      const cb = tpl.txs[0];
      assert.equal(cb.vout.length, 0, `fee ${fee}: no explicit note at all`);
      assert.equal(Number(cb.carryNanos), baseCarry, `fee ${fee}: the levy never enters the carry`);
      const got = verified(tpl);
      assert.equal(got.ok, true, `fee ${fee} ${got.reason}`);
      const rec = decodeRecord(Buffer.from(got.blunoteRecord, 'hex'));
      assert.equal(rec.feeV, poolFee + BigInt(split.finder), `fee ${fee}`);
      assert.ok(recogniseOneTime({ y: pool.y, B: pool.B }, rec.feeR, rec.feeP) != null, `fee ${fee}`);
      assert.equal(recogniseOneTime({ y: stranger.y, B: stranger.B }, rec.feeR, rec.feeP), null, `fee ${fee}`);
    }
  });

  it('a solo option (b) round pays pot and finder levy to the key, and carries nothing', () => {
    const solo = bluWallet();
    const potOnly = verified(genesisWith(0, { feeKey: feeKeyOf(solo), feeBps: 0, potToFee: true }));
    assert.equal(potOnly.ok, true, potOnly.reason);
    const pot = decodeRecord(Buffer.from(potOnly.blunoteRecord, 'hex')).feeV;
    assert.ok(pot > 0n);
    for (const fee of FEES) {
      const tpl = genesisWith(fee, { feeKey: feeKeyOf(solo), feeBps: 0, potToFee: true });
      assert.equal(Number(tpl.txs[0].carryNanos || 0), 0, `fee ${fee}`);
      assert.equal(tpl.txs[0].vout.length, 0, `fee ${fee}`);
      const got = verified(tpl);
      assert.equal(got.ok, true, `fee ${fee} ${got.reason}`);
      assert.equal(decodeRecord(Buffer.from(got.blunoteRecord, 'hex')).feeV, pot + BigInt(splitLevy(fee).finder), `fee ${fee}`);
    }
  });

  it('a coinbase that names a levy with no fee-paying body is levy_split', () => {
    // probeBody skips the hash search. store.append never sets it.
    for (const fee of FEES) {
      const tpl = genesisWith(fee);
      const verdict = verifyBlock(resealed(tpl, [tpl.txs[0]]), null, { probeBody: true });
      if (!fee) {
        assert.equal(verdict.ok, true, verdict.reason);
        continue;
      }
      assert.equal(verdict.ok, false, `fee ${fee}`);
      assert.equal(verdict.reason, 'levy_split', `fee ${fee}`);
    }
  });
});
