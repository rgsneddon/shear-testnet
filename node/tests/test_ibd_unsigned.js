import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, destOpeningFromView } from '../../crypto/address.js';
import { spendBox } from '../../tests/spend_box.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { proveFlowSpend } from '../../crypto/admit.js';
import {
  signSpendTx,
  sealedCompactSpend,
  verifySpendSig,
} from '../../crypto/spend.js';
import { levyNanos, bindWeightFee } from '../../crypto/levy.js';
import {
  BLOCK_SUBSIDY_NANOS,
  GENESIS_BITS_PACKED,
} from '../../crypto/asert.js';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import { mineTemplate } from '../src/chain.js';
import {
  encodeWireBlock,
  decodeWireBlock,
  jsonWire,
  recordIngestFail,
  isFinalIngestFail,
  P2P_FAIL_DISCONNECT,
} from '../src/p2p.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { nativeLoaded } from '../../crypto/native_admit.js';
try { setHashBackend('jit'); } catch { /* interpreter */ }

function shareBitsOf(bits) {
  const n = Number(bits) || 0;
  return n >= 65536 ? Math.max(4, Math.floor(n / 65536)) : Math.max(4, n);
}

function wireIngest(store, block) {
  const decoded = decodeWireBlock(JSON.parse(jsonWire(encodeWireBlock(block))));
  return Promise.resolve(store.ingest([decoded])).then((got) => ({ got, decoded }));
}

async function minePacked(store, dest, now) {
  const packed = GENESIS_BITS_PACKED;
  const sb = shareBitsOf(packed);
  const { tpl } = store.template({ miner: dest, bits: packed, shareBits: sb, now });
  const found = mineTemplate({ ...tpl, bits: packed }, { maxTries: 3_000_000, shareBits: sb, blockOnly: true });
  assert.ok(found && found.block, 'need pow');
  const appended = await Promise.resolve(store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }));
  return { appended, tpl };
}

describe('IBD compact Flow ingest vs mempool unsigned', () => {
  it('recordIngestFail does not ban on prev or native-missing; unsigned mempool still final', () => {
    assert.equal(isFinalIngestFail('prev'), false);
    assert.equal(isFinalIngestFail('native_missing'), false);
    assert.equal(isFinalIngestFail('ShearHash-v3 native addon missing and ShearK-Miner not built'), false);
    assert.equal(isFinalIngestFail('unsigned'), true);
    assert.equal(isFinalIngestFail('merkle'), true);
    const rec = { expensiveFails: 0 };
    for (let i = 0; i < P2P_FAIL_DISCONNECT + 4; i += 1) {
      assert.equal(recordIngestFail(rec, 'prev'), false);
    }
    assert.equal(rec.expensiveFails, 0);
    assert.equal(recordIngestFail(rec, 'native_missing'), false);
    assert.equal(rec.expensiveFails, 0);
    const ban = { expensiveFails: 0 };
    for (let i = 0; i < P2P_FAIL_DISCONNECT - 1; i += 1) {
      assert.equal(recordIngestFail(ban, 'unsigned'), false);
    }
    assert.equal(recordIngestFail(ban, 'unsigned'), true);
  });

  it('queueTx of a truly unsigned Flow send stays unsigned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-mp-'));
    const store = createStore(dir);
    const id = newIdentity();
    const box = spendBox(id);
    const dest = box.dest;
    const send = {
      kind: 'user-spend',
      from: dest,
      to: dest,
      nanos: 2,
      fee: levyNanos(2),
      vin: [{ address: dest, commit: Buffer.alloc(32, 1) }],
      vout: [{ address: dest, nanos: 2, kind: 'user-spend' }],
    };
    const got = store.queueTx(send);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'unsigned');
    assert.equal(isFinalIngestFail(got.reason), true);
  });

  it('encodeWireBlock of a signed Flow block still ingests on a second store', async (t) => {
    if (!nativeLoaded()) {
      t.skip('ADMITv2 native required to seal a funded Flow send');
      return;
    }
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-b-'));
    const a = createStore(dirA);
    const b = createStore(dirB);
    const id = newIdentity();
    const box = spendBox(id);
    const dest = box.dest;
    const t0 = 1_700_000_000_000;
    let lastPot = null;
    {
      const { appended, tpl } = await minePacked(a, dest, t0);
      assert.equal(appended.ok, true, appended.reason);
      const pot = (tpl.txs[0].vout || []).find((o) => o.kind === 'pot');
      lastPot = {
        commit: pot.commit,
        noteCommit: pot.noteCommit,
        r: pot.r,
        index: tpl.txs[0].vout.indexOf(pot),
        change: BLOCK_SUBSIDY_NANOS - 2 - levyNanos(2),
      };
      const { got } = await wireIngest(b, a.tip());
      assert.equal(got.ok, true, got.reason);
    }
    assert.ok(lastPot?.r && lastPot.commit);
    const sendNanos = 2;
    const fee = levyNanos(sendNanos);
    const tip = a.tip();
    const spent = (tip.txs[0].vout || []).find((o) => o.kind === 'pot');
    assert.ok(spent?.commit, 'need pot note');
    const sendTx = attachDummyOuts({
      id: 'ibd-flow-send',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: sendNanos,
      fee,
      changeNanos: lastPot.change,
      open: destOpeningFromView(id.viewKey, id.spendPub, 0),
      vin: [{ commit: lastPot.commit, address: dest }],
      vout: [
        { address: dest, nanos: sendNanos, kind: 'send' },
        { address: dest, nanos: lastPot.change, kind: 'send' },
      ],
    }, { spent: lastPot });
    proveFlowSpend(sendTx, {
      spendSeed: box.spendSeed,
      spentNote: { ...spent, r: lastPot.r, kind: spent.kind || 'pot' },
      pubs: a.fluxset().pubs,
      commits: a.fluxset().commits,
    });
    bindWeightFee(sendTx);
    signSpendTx(sendTx, box.key);
    assert.equal(verifySpendSig(sendTx), true);
    const queued = a.queueTx(sendTx);
    assert.equal(queued.ok, true, queued.reason);
    const parentH = decodeHeader(Buffer.from(a.tip().header));
    const mined = await minePacked(a, dest, Number(parentH.timestamp) + 90_000);
    assert.equal(mined.appended.ok, true, mined.appended.reason);
    assert.equal(
      (a.tip().txs || []).slice(1).some((t) => t.id === 'ibd-flow-send' || t.vin?.[0]?.commit),
      true,
      'mined block must carry the Flow send',
    );
    const { got, decoded } = await wireIngest(b, a.tip());
    const user = (decoded.txs || []).find((t) => !t.coinbase);
    assert.ok(user, 'compact wire must carry the Flow send');
    assert.equal(user.spendPub, undefined);
    assert.equal(user.from, undefined);
    assert.equal(sealedCompactSpend(user), true);
    assert.equal(got.ok, true, got.reason);
    assert.equal(b.tip().height, a.tip().height);
    assert.ok(Buffer.from(b.tip().hash).equals(Buffer.from(a.tip().hash)));
  });
});
