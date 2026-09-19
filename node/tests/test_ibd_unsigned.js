import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { spendBox } from '../../tests/spend_box.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import {
  signSpendTx,
  verifyFundedBody,
  sealedCompactSpend,
  verifySpendSig,
} from '../../crypto/spend.js';
import { levyNanos } from '../../crypto/levy.js';
import { createStore } from '../src/store.js';
import {
  encodeWireBlock,
  decodeWireBlock,
  jsonWire,
  recordIngestFail,
  isFinalIngestFail,
  P2P_FAIL_DISCONNECT,
} from '../src/p2p.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
try { setHashBackend('jit'); } catch { /* interpreter */ }

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

  it('encodeWireBlock of a signed Flow body still verifies on a second compact round-trip', () => {
    const id = newIdentity();
    const box = spendBox(id);
    const dest = box.dest;
    const commit = Buffer.alloc(32, 3);
    const fat = attachDummyOuts({
      id: 'ibd-flow-send',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee: levyNanos(2),
      vin: [{ commit, address: dest }],
      vout: [{ address: dest, nanos: 2, kind: 'send' }],
    });
    signSpendTx(fat, box.key);
    assert.equal(verifySpendSig(fat), true);
    const sealed = compactTx(fat);
    assert.equal(sealed.spendPub, undefined);
    assert.equal(sealed.from, undefined);
    assert.equal(sealedCompactSpend(sealed), true);
    const d20 = hash20FromAddress(dest);
    if (d20) sealed.vin[0].dest20 = Buffer.from(d20);
    const funded = verifyFundedBody([sealed], () => 1e12);
    assert.equal(funded.ok, true, funded.reason);
    const wire = encodeWireBlock({
      header: Buffer.alloc(128, 1),
      hash: Buffer.alloc(32, 2),
      height: 2,
      txs: [{ coinbase: true, height: 2, vout: [] }, sealed],
      shareBatch: [],
    });
    const back = decodeWireBlock(JSON.parse(jsonWire(wire)));
    const round = back.txs[1];
    assert.equal(round.spendPub, undefined);
    const again = verifyFundedBody([round], () => 1e12);
    assert.equal(again.ok, true, again.reason);
  });
});
