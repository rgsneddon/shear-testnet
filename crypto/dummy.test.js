import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from './address.js';
import { destForLogin, vaultDest } from './flow_sheet.js';
import { lockTx, voteTx } from './reserve_vault.js';
import { verifySealedNote, verifyRange, verifyFlowConservation, sealNote, spentCommitEquals } from './note.js';
import {
  DUMMY_KIND,
  attachDummyOuts,
  dummyCount,
  flowNeedsDummy,
  publicExplorerRow,
  viewTagOf,
} from './dummy.js';
import { compactTx } from './chronoflux.js';
import { PI_SHE_NANOS } from './asert.js';

describe('Flow dummy outs', () => {
  it('adds at least one dummy note on send; lock/vote stay typed without dummies', () => {
    const id = newIdentity();
    const from = destForLogin(id.address, { viewKey: id.viewKey });
    const to = destForLogin(id.address, { viewKey: id.viewKey });
    const send = attachDummyOuts({
      kind: 'send',
      from,
      to,
      nanos: 10,
      vin: [{ address: from }],
      vout: [{ address: to, nanos: 10, kind: 'send' }],
    });
    assert.equal(flowNeedsDummy(send), true);
    assert.ok(dummyCount(send) >= 1);
    assert.ok(send.vout[0].commit);
    assert.equal(send.vout[0].nanos, undefined);
    assert.equal(verifySealedNote(send.vout[0], 10), true);
    assert.ok(send.vout[0].rangeProof);
    assert.equal(verifyRange(send.vout[0].commit, send.vout[0].rangeProof), true);
    const dummy = send.vout.find((o) => o.kind === DUMMY_KIND);
    assert.ok(dummy.commit);
    assert.equal(verifySealedNote(dummy, 0), true);
    assert.ok(dummy.rangeProof);
    assert.equal(verifyRange(dummy.commit, dummy.rangeProof), true);
    const stripped = { ...send.vout[0], rangeProof: { bits: [], B: [] } };
    assert.equal(verifyRange(stripped.commit, stripped.rangeProof), false);
    assert.equal(dummy.viewTag[0], viewTagOf(dummy.noteCommit)[0]);
    assert.equal(dummy.address, undefined);

    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const lock = lockTx({ from, to: vault, nanos: PI_SHE_NANOS, id: 'lock-d' });
    assert.equal(flowNeedsDummy(lock), false);
    assert.equal(dummyCount(attachDummyOuts(lock)), 0);
    const sealedLock = compactTx(lock);
    assert.equal(sealedLock.nanos, undefined);
    assert.equal(sealedLock.to, vault);
    assert.equal(sealedLock.vout[0].address, vault);
    const vote = voteTx({ from, dest: vault, choice: 'hold', id: 'vote-d' });
    assert.equal(flowNeedsDummy(vote), false);
    assert.equal(dummyCount(attachDummyOuts(vote)), 0);

    assert.equal(send.vin[0].commit, undefined);
    assert.equal(verifyFlowConservation(send), false);
    const compactBare = compactTx(send);
    assert.equal(compactBare.nanos, undefined);
    assert.equal(compactBare.from, undefined);
    assert.equal(compactBare.to, undefined);
    assert.equal(compactBare.vout[0].address, undefined);
    assert.equal(compactBare.vin[0].address, undefined);
    assert.equal(compactBare.vin[0].commit, undefined);
    assert.ok(compactBare.vout[0].commit);
    assert.ok(compactBare.vout[0].rangeProof);
  });

  it('does not mint C_in; conservation binds vin.commit to the spent vout', () => {
    const id = newIdentity();
    const from = destForLogin(id.address, { viewKey: id.viewKey });
    const to = destForLogin(id.address, { viewKey: id.viewKey });
    const spent = sealNote(10, { dest20: Buffer.alloc(20, 7), kind: 'pot' });
    const fake = sealNote(10, { dest20: Buffer.alloc(20, 8), kind: 'spend-in' });
    const send = attachDummyOuts({
      kind: 'send',
      from,
      to,
      nanos: 10,
      vin: [{ prev: Buffer.alloc(32, 1), index: 0, address: from }],
      vout: [{ address: to, nanos: 10, kind: 'send' }],
    }, { spent });
    assert.equal(spentCommitEquals(send.vin[0], spent), true);
    assert.equal(spentCommitEquals(send.vin[0], fake), false);
    const spentOf = (vin) => (spentCommitEquals(vin, spent) ? spent : null);
    assert.equal(verifyFlowConservation(send, spentOf), true);
    assert.equal(verifyFlowConservation(send), false);
    assert.equal(verifyFlowConservation(send, () => fake), false);
    const compact = compactTx(send);
    assert.ok(compact.vin[0].commit);
    assert.equal(compact.vin[0].r, undefined);
    assert.equal(verifyFlowConservation(compact, spentOf), true);
    assert.equal(verifyFlowConservation(compact, () => fake), false);
  });

  it('public explorer row hides amounts and keeps Reserve kind + dest', () => {
    const hidden = publicExplorerRow({
      id: 'x-vout-0',
      kind: 'send',
      to: 'ssa1secret',
      nanos: 99,
      height: 8,
      confirmed: true,
      memo: true,
      memoCt: 'cipher',
    });
    assert.equal(hidden.amountHidden, true);
    assert.equal(hidden.nanos, undefined);
    assert.equal(hidden.memoCt, undefined);
    assert.equal(hidden.memo, true);
    assert.equal(hidden.to, undefined);
    const lock = publicExplorerRow({
      id: 'y',
      kind: 'lock',
      to: 'ssa1vault',
      nanos: 314,
      height: 9,
      confirmed: true,
    });
    assert.equal(lock.kind, 'lock');
    assert.equal(lock.to, 'ssa1vault');
    assert.equal(lock.nanos, undefined);
    assert.equal(lock.height, 9);
  });
});
