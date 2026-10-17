import { describe, it } from 'node:test';
import { fileCapMs } from './slow_caps.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, destOpeningFromView, freshStealthDest } from '../../crypto/address.js';
import { fluxsetFromBlocks } from '../../crypto/admit.js';
import { attachStubAdmitV2 } from './stub_admit_v2.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { spendBox } from '../../tests/spend_box.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { splitLevy, levyNanos, bindWeightFee, levyNeed } from '../../crypto/levy.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { BLOCK_SUBSIDY_NANOS, NANOS_PER_SHE, SPENDABLE_CONFIRMATIONS, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { signSpendTx } from '../../crypto/spend.js';
import { verifySealedNote } from '../../crypto/note.js';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
try { setHashBackend('jit'); } catch { /* interpreter */ }
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

function shareBitsOf(bits) {
  const n = Number(bits) || 0;
  return n >= 65536 ? Math.max(4, Math.floor(n / 65536)) : Math.max(4, n);
}

let clock = 1_700_000_000_000;
function nextNow() {
  clock += 90_000;
  return clock;
}

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: shareBitsOf(tpl.bits) });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

describe('verifyBlock Phase B Flow levy', { timeout: fileCapMs(import.meta.url) }, () => {
  it('dust empty L=100; 1 SHE empty 0.0002 SHE; pot/hash pay 0; underpay levy; EVM value same L; maxLevy refuse', async () => {
    assert.equal(levyNanos(1), 100);
    assert.equal(levyNanos(NANOS_PER_SHE), 100);
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const other = destForLogin(newIdentity().address, { viewKey: newIdentity().viewKey, height: 1 });
    const base = {
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: nextNow(),
      samples: [{ miner: dest, nonce: '1', tag: 'a', count: 3 }],
    };
    const free = mine(buildTemplate(base));
    const ok0 = verifyBlock(free, null);
    assert.equal(ok0.ok, true, ok0.reason);
    const potV = free.txs[0].vout.filter((o) => o.kind === 'pot');
    assert.equal(potV.length, 1);
    assert.equal(verifySealedNote(potV[0], BLOCK_SUBSIDY_NANOS), true);
    assert.equal(free.txs[0].vout.some((o) => o.kind === 'finder-fee'), false);
    assert.equal(free.txs[0].vout.some((o) => o.kind === 'reserve-fee'), false);
    assert.equal(free.txs[0].vout.filter((o) => o.kind === 'hash').every((o) => o.kind === 'hash'), true);

    const sendNanos = 2;
    const need = levyNanos(sendNanos);
    assert.equal(need, 100);
    const parent = mine(buildTemplate(base));
    const okP = verifyBlock(parent, null);
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;
    const spent = parent.txs[0].vout.find((o) => o.kind === 'pot');
    const spentIdx = parent.txs[0].vout.indexOf(spent);
    const childBase = {
      ...base,
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentFluxset: fluxsetFromBlocks([parent]).pubs,
      height: 2,
      now: nextNow(),
    };
    function potSend({ id: txId, fee, maxLevy }) {
      const change = BLOCK_SUBSIDY_NANOS - sendNanos - fee;
      const tx = attachDummyOuts({
        id: txId,
        kind: 'send',
        from: dest,
        to: dest,
        nanos: sendNanos,
        fee,
        ...(maxLevy != null ? { maxLevy } : {}),
        changeNanos: change,
        vin: [{
          commit: spent.commit,
          address: dest,
        }],
        vout: [
          { address: dest, nanos: sendNanos, kind: 'send' },
          { address: dest, nanos: change, kind: 'send' },
        ],
      }, { spent });
      return attachStubAdmitV2(tx);
    }
    const unpaid = mine(buildTemplate({
      ...childBase,
      txs: [compactTx(potSend({ id: 'u1', fee: 0 }))],
    }));
    const denied = verifyBlock(unpaid, { ...parent, hash: okP.hash, header: parent.header, height: 1 });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'admit_version', denied.reason);

    const capped = mine(buildTemplate({
      ...childBase,
      txs: [compactTx(potSend({ id: 'cap', fee: need, maxLevy: need - 1 }))],
    }));
    const capDenied = verifyBlock(capped, { ...parent, hash: okP.hash, header: parent.header, height: 1 });
    assert.equal(capDenied.ok, false);
    assert.equal(capDenied.reason, 'admit_version', capDenied.reason);

    const paid = mine(buildTemplate({
      ...childBase,
      txs: [compactTx(potSend({ id: 'u2', fee: need }))],
    }));
    const allowed = verifyBlock(paid, { ...parent, hash: okP.hash, header: parent.header, height: 1 });
    assert.equal(allowed.ok, false);
    assert.equal(allowed.reason, 'admit_version', allowed.reason);
    const split = splitLevy(need);
    const finderNotes = paid.txs[0].vout.filter((o) => o.kind === 'finder-fee');
    assert.equal(finderNotes.length, 1);
    assert.equal(paid.txs[0].vout.some((o) => o.kind === 'reserve-fee'), false);
    const finderO = finderNotes[0];
    const finder = finderO?.commit ? (verifySealedNote(finderO, split.finder) ? split.finder : -1) : Number(finderO?.nanos || 0);
    assert.equal(split.reserve, 0);
    assert.equal(finder, need);
    assert.equal(finder, split.finder);

    const valueNanos = 77;
    const evmNeed = levyNanos(valueNanos);
    assert.equal(evmNeed, 100);
    const evm = mine(buildTemplate({
      ...base,
      txs: [{
        id: 'evm-value',
        kind: 'evm-value',
        from: dest,
        to: other,
        nanos: valueNanos,
        fee: evmNeed,
        vin: [{ address: dest }],
        vout: [{ address: other, nanos: valueNanos, kind: 'evm-value' }],
      }],
    }));
    const evmOk = await verifyBlock(evm, null);
    assert.equal(evmOk.ok, true, evmOk.reason || evmOk.error);
    assert.equal(evmOk.evmRan, true);
    assert.equal(evmOk.evm.valueMoved, valueNanos);
  });

  it('a byte-2 flow send is value_open before compact and admit_version on the wire', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-levy-path-'));
    const store = createStore(dir);
    const id = newIdentity();
    const box = spendBox(id);
    const dest = box.dest;
    const t0 = 1_700_000_000_000;
    let lastPot = null;
    for (let i = 0; i < SPENDABLE_CONFIRMATIONS + 1; i += 1) {
      const parent = store.tip();
      const { tpl: fund } = store.template({
        miner: dest,
        bits: GENESIS_BITS_PACKED,
        now: t0 + i * 90_000,
      });
      const foundFund = mineTemplate(fund, { maxTries: 3_000_000, shareBits: shareBitsOf(fund.bits) });
      assert.ok(foundFund && foundFund.block, 'fund pow');
      const pot = (fund.txs[0].vout || []).find((o) => o.kind === 'pot');
      lastPot = {
        commit: pot.commit,
        noteCommit: pot.noteCommit,
        r: pot.r,
        index: fund.txs[0].vout.indexOf(pot),
        change: BLOCK_SUBSIDY_NANOS - 2 - levyNanos(2),
      };
      const funded = await store.append({
        header: foundFund.header,
        txs: fund.txs,
        samples: fund.samples,
        shareBatch: fund.shareBatch || [],
        miner: dest,
        aLeaves: fund.aLeaves,
        bLeaves: fund.bLeaves,
        rootA: fund.rootA,
        rootB: fund.rootB,
        weight: fund.weight,
      });
      assert.equal(funded.ok, true, funded.reason);
    }
    assert.ok(lastPot?.r && lastPot.commit);
    const sendNanos = 2;
    const fee = levyNanos(sendNanos);
    const tip = store.tip();
    const spent = (tip.txs[0].vout || []).find((o) => o.kind === 'pot');
    assert.ok(spent?.commit, 'need pot note');
    // r was stripped on persist; re-bind from the last funded template copy kept above.
    const sendTx = attachDummyOuts({
      id: 'q-send',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: sendNanos,
      fee,
      changeNanos: lastPot.change,
      open: destOpeningFromView(id.viewKey, id.spendPub, 0),
      vin: [{
        commit: lastPot.commit,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: sendNanos, kind: 'send' },
        { address: dest, nanos: lastPot.change, kind: 'send' },
      ],
    }, { spent: lastPot });
    attachStubAdmitV2(sendTx);
    bindWeightFee(sendTx);
    signSpendTx(sendTx, box.key);
    const queued = store.queueTx(sendTx);
    assert.equal(queued.ok, false);
    assert.equal(queued.reason, 'value_open', queued.reason);
    const wired = store.queueTx(compactTx(sendTx));
    assert.equal(wired.ok, false);
    assert.equal(wired.reason, 'admit_version', wired.reason);
    const parent = store.tip();
    const parentH = decodeHeader(Buffer.from(parent.header));
    const nowSend = Number(parentH.timestamp) + 90_000;
    const { tpl } = store.template({
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: nowSend,
    });
    assert.equal(tpl.txs.slice(1).some((t) => t.id === 'q-send'), false);
    assert.equal(store.tip().height, parent.height);
  });

  it('Flow send without a range proof is confidential', () => {
    const dest = freshStealthDest(newIdentity().paymentCode).dest;
    const send = attachDummyOuts({
      id: 'no-range',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee: levyNanos(2),
      vin: [{ address: dest }],
      vout: [{ address: dest, nanos: 2, kind: 'send' }],
    });
    for (const o of send.vout) delete o.rangeProof;
    const block = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: nextNow(),
      txs: [send],
    }));
    const got = verifyBlock(block, null);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'range_proof');
  });
});
