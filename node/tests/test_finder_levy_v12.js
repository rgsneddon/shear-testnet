import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { FEE_SPLIT_FINDER_BPS, poolFeeDest, reserveFeeDest, splitLevy } from '../../crypto/levy.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { openedCoinbaseNanos } from '../../crypto/note.js';
import { emptyVault, applyReserveBlock } from '../../crypto/reserve_vault.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { GENESIS_PREV, buildTemplate, templateForFinder, coinbaseLevyPays, verifyBlock, digestTx } from '../src/chain.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const NOW = 1_700_000_000_000;
const FEES = [0, 1, 2, 3, 100, 999, 1000, 1_048_576, (2 ** 20) + 3];

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

function byteSort(dests) {
  return dests.slice().sort((a, b) => dest20(a).compare(dest20(b)));
}

/** Coinbase only, header rebound, so verifyBlock reaches the levy check. */
function coinbaseBlock(tpl) {
  const cb = tpl.txs[0];
  const decoded = decodeHeader(Buffer.from(tpl.header));
  const header = encodeHeader({
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash,
    merkleRoot: merkleRoot([digestTx(cb)]),
    continuityRoot: decoded.continuityRoot,
    timestamp: decoded.timestamp,
    bits: decoded.bits,
    nonce: 0n,
    baseFee: decoded.baseFee,
  });
  return {
    header,
    txs: [cb],
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height: tpl.height,
  };
}

describe('finder-fee pays the miner who found the block', () => {
  it('any levy pays the named finder, and the reserve half credits the fee bank', () => {
    const finders = [minerDest(), minerDest(), minerDest()];
    const lowest = byteSort(finders)[0];
    const feeTo = minerDest();
    assert.equal(finders.includes(feeTo), false);
    assert.equal(finders.includes(poolFeeDest()), false);
    assert.equal(finders.includes(reserveFeeDest()), false);
    for (const fee of FEES) {
      const split = splitLevy(fee);
      assert.equal(split.finder, Math.floor(fee * FEE_SPLIT_FINDER_BPS / 10000));
      assert.equal(split.finder + split.reserve, fee);
      for (const finder of finders) {
        const tpl = buildTemplate({
          prev: GENESIS_PREV,
          height: 1,
          miner: lowest,
          finderDest: finder,
          poolDest: feeTo,
          feeDest: feeTo,
          txs: [{ id: `fee-${fee}`, kind: 'send', fee }],
          bits: GENESIS_BITS_PACKED,
          now: NOW,
        });
        const body = tpl.txs[0];
        const finderNotes = body.vout.filter((o) => o.kind === 'finder-fee');
        const reserveNotes = body.vout.filter((o) => o.kind === 'reserve-fee');
        if (split.finder <= 0) {
          assert.equal(finderNotes.length, 0, `fee ${fee}`);
        } else {
          assert.equal(finderNotes.length, 1, `fee ${fee}`);
          assert.equal(openedCoinbaseNanos(finderNotes[0]), split.finder, `fee ${fee}`);
          assert.equal(same20(finderNotes[0], finder), true, `fee ${fee} pays the finder`);
          assert.equal(same20(finderNotes[0], feeTo), false);
          assert.equal(same20(finderNotes[0], poolFeeDest()), false);
          assert.equal(same20(finderNotes[0], reserveFeeDest()), false);
          if (finder !== lowest) assert.equal(same20(finderNotes[0], lowest), false, `fee ${fee} is not the lowest dest`);
        }
        if (split.reserve <= 0) {
          assert.equal(reserveNotes.length, 0, `fee ${fee}`);
        } else {
          assert.equal(reserveNotes.length, 1, `fee ${fee}`);
          assert.equal(openedCoinbaseNanos(reserveNotes[0]), split.reserve, `fee ${fee}`);
          assert.equal(same20(reserveNotes[0], reserveFeeDest()), true);
          assert.equal(same20(reserveNotes[0], finder), false);
          assert.equal(same20(reserveNotes[0], feeTo), false);
        }
        const bound = coinbaseLevyPays(body, fee);
        assert.equal(bound.ok, true, bound.reason || `fee ${fee}`);
        const state = emptyVault();
        applyReserveBlock({ state, block: { txs: tpl.txs }, nowMs: NOW });
        assert.equal(Number(state.feeBankNanos), split.reserve, `fee ${fee}`);
        if (split.finder > 0) assert.notEqual(Number(state.feeBankNanos), fee);
        const stolen = {
          ...body,
          vout: body.vout.map((o) => (o.kind === 'reserve-fee'
            ? { ...o, dest20: dest20(finder) }
            : o)),
        };
        const stolenState = emptyVault();
        applyReserveBlock({ state: stolenState, block: { txs: [stolen] }, nowMs: NOW });
        assert.equal(Number(stolenState.feeBankNanos), 0);
        if (split.reserve > 0) {
          const denied = coinbaseLevyPays(stolen, fee);
          assert.equal(denied.ok, false);
          assert.equal(denied.reason, 'levy_split');
        }
      }
    }
    const withheld = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: feeTo,
      finderDest: '',
      poolDest: feeTo,
      feeDest: feeTo,
      txs: [{ id: 'empty-round', kind: 'send', fee: 100 }],
      bits: GENESIS_BITS_PACKED,
      now: NOW,
    });
    assert.equal(withheld.txs[0].vout.some((o) => o.kind === 'finder-fee'), false);
    const reserved = withheld.txs[0].vout.find((o) => o.kind === 'reserve-fee');
    assert.equal(openedCoinbaseNanos(reserved), splitLevy(100).reserve);
    assert.equal(same20(reserved, reserveFeeDest()), true);
    assert.equal(same20(reserved, feeTo), false);
    const aimed = templateForFinder(withheld, finders[2]);
    const paid = aimed.txs[0].vout.find((o) => o.kind === 'finder-fee');
    assert.equal(openedCoinbaseNanos(paid), splitLevy(100).finder);
    assert.equal(same20(paid, finders[2]), true);
    assert.equal(same20(paid, feeTo), false);
    assert.equal(same20(paid, lowest), false);
    assert.equal(templateForFinder(withheld, feeTo), null);
    assert.equal(templateForFinder(withheld, poolFeeDest()), null);
    assert.equal(templateForFinder(withheld, reserveFeeDest()), null);
    const solo = minerDest();
    const soloTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: solo,
      txs: [{ id: 'solo', kind: 'send', fee: 100 }],
      bits: GENESIS_BITS_PACKED,
      now: NOW,
    });
    const soloNote = soloTpl.txs[0].vout.find((o) => o.kind === 'finder-fee');
    assert.equal(same20(soloNote, solo), true);

    // probeBody skips the hash search. store.append never sets it.
    // A coinbase that names a levy, with no fee-paying body, is levy_split.
    for (const fee of FEES) {
      const tpl = buildTemplate({
        prev: GENESIS_PREV,
        height: 1,
        miner: lowest,
        finderDest: finders[0],
        poolDest: feeTo,
        feeDest: feeTo,
        txs: fee ? [{ id: `body-${fee}`, kind: 'send', fee }] : [],
        bits: GENESIS_BITS_PACKED,
        now: NOW,
      });
      const verdict = verifyBlock(coinbaseBlock(tpl), null, { probeBody: true });
      if (!fee) {
        assert.equal(verdict.ok, true, verdict.reason);
        continue;
      }
      assert.equal(verdict.ok, false, `fee ${fee}`);
      assert.equal(verdict.reason, 'levy_split', `fee ${fee}`);
    }
  });
});
