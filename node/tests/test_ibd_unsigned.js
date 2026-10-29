import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, destOpeningFromView, hash20FromAddress, admitBaseFromAddress } from '../../crypto/address.js';
import { spendBox } from '../../tests/spend_box.js';
import { attachDummyOuts, viewTagOf } from '../../crypto/dummy.js';
import { sealNote, kernelExcess } from '../../crypto/note.js';
import { attachAdmitPub } from '../../crypto/admit.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { attachStubAdmitV2 } from './stub_admit_v2.js';
import {
  signSpendTx,
  verifySpendSig,
} from '../../crypto/spend.js';
import { levyNanos, bindWeightFee } from '../../crypto/levy.js';
import { BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
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

/**
 * A send output that carries its value opening (valueProof). Since e2bd74cf
 * attachDummyOuts seals send outputs hidden, so the opening is built on purpose.
 */
function openedFlowVout(dest, nanos) {
  const d20 = hash20FromAddress(dest);
  let note = sealNote(nanos, { dest20: d20, kind: 'send' });
  note.viewTag = viewTagOf(note.noteCommit);
  note.dest20 = d20;
  note.address = dest;
  note = attachAdmitPub(note, { admitBase: admitBaseFromAddress(dest) });
  assert.ok(note.valueProof && note.commit && note.admitPub);
  return note;
}

// Regtest work (bits 4, about 16 hashes), mined off the main thread by
// mine_worker.mjs, so the file's own timeout can fire. It used to mine at
// testnet genesis bits (2^17 ShearHash light hashes) in a synchronous
// mineTemplate loop: about 55 minutes at the CI hosts' 40 hashes a second,
// heavy-tailed, and past every cap one run in three (Review, ruling D).
const MAX_TRIES = 8_192;

after(() => closeMineWorkers());

function regtestStore(dir) {
  return createRegtestStore(dir, { bits: 4 });
}

function wireIngest(store, block) {
  const decoded = decodeWireBlock(JSON.parse(jsonWire(encodeWireBlock(block))));
  return Promise.resolve(store.ingest([decoded])).then((got) => ({ got, decoded }));
}

async function minePacked(store, dest, now) {
  const bits = regtestBitsOverride(MAGIC_REGTEST);
  const { tpl } = store.template({ miner: dest, bits, shareBits: 4, now });
  assert.equal(tpl.bits, bits, 'template must seal the regtest bits');
  const found = await mineHeaderParallel(tpl.header, tpl.bits, MAX_TRIES, 1);
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
  it('recordIngestFail does not ban on prev, native-missing, or unsigned', () => {
    assert.equal(isFinalIngestFail('prev'), false);
    assert.equal(isFinalIngestFail('native_missing'), false);
    assert.equal(isFinalIngestFail('ShearHash-v3 native addon missing and ShearK-Miner not built'), false);
    assert.equal(isFinalIngestFail('unsigned'), false);
    assert.equal(isFinalIngestFail('merkle'), true);
    const rec = { expensiveFails: 0 };
    for (let i = 0; i < P2P_FAIL_DISCONNECT + 4; i += 1) {
      assert.equal(recordIngestFail(rec, 'prev'), false);
      assert.equal(recordIngestFail(rec, 'unsigned'), false);
    }
    assert.equal(rec.expensiveFails, 0);
    assert.equal(recordIngestFail(rec, 'native_missing'), false);
    assert.equal(rec.expensiveFails, 0);
  });

  it('queueTx of a truly unsigned Flow send stays unsigned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-mp-'));
    const store = regtestStore(dir);
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
    assert.equal(isFinalIngestFail(got.reason), false);
  });

  it('encodeWireBlock of a signed Flow block still ingests on a second store', async (t) => {
    if (!nativeLoaded()) {
      t.skip('native addon required to seal a funded Flow send');
      return;
    }
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-b-'));
    const a = regtestStore(dirA);
    const b = regtestStore(dirB);
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
    attachStubAdmitV2(sendTx);
    bindWeightFee(sendTx);
    signSpendTx(sendTx, box.key, { magic: 'shear-testnet-v12' });
    assert.equal(verifySpendSig(sendTx), true);
    // Send outputs are hidden (e2bd74cf), so the full body reaches the version
    // gate and the byte-2 stub is admit_version.
    const queued = a.queueTx(sendTx);
    assert.equal(queued.ok, false);
    assert.equal(queued.reason, 'admit_version', queued.reason);
    assert.equal(a.mempool.some((m) => m.id === 'ibd-flow-send'), false);
    // The same send with its pay output opened is value_open before that gate.
    const openedTx = {
      ...sendTx,
      id: 'ibd-flow-send-opened',
      vin: sendTx.vin.map((v) => ({ ...v })),
      vout: sendTx.vout.map((o) => ({ ...o })),
      admit_proof: { ...sendTx.admit_proof },
    };
    openedTx.vout[0] = openedFlowVout(dest, sendNanos);
    openedTx.excess = kernelExcess(openedTx.vout, openedTx.vin);
    assert.ok(openedTx.excess);
    bindWeightFee(openedTx);
    signSpendTx(openedTx, box.key, { magic: 'shear-testnet-v12' });
    assert.equal(verifySpendSig(openedTx), true);
    const openedQ = a.queueTx(openedTx);
    assert.equal(openedQ.ok, false);
    assert.equal(openedQ.reason, 'value_open', openedQ.reason);
    assert.equal(a.mempool.some((m) => m.id === 'ibd-flow-send-opened'), false);
    const wired = a.queueTx(compactTx(sendTx));
    assert.equal(wired.ok, false);
    assert.equal(wired.reason, 'admit_version', wired.reason);
    assert.equal(a.mempool.some((m) => m.id === 'ibd-flow-send'), false);
    const tag = Buffer.from(sendTx.admit_proof.spendTag).toString('hex');
    assert.equal(a.fluxset().spendTags.has(tag), false);
    assert.equal(verifySpendSig(sendTx), true);
    assert.equal(b.tip().height, a.tip().height);
    assert.ok(Buffer.from(b.tip().hash).equals(Buffer.from(a.tip().hash)));
  });
});
