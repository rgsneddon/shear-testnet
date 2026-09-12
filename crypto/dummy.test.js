import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from './address.js';
import { destForLogin, vaultDest } from './flow_sheet.js';
import { lockTx, voteTx } from './reserve_vault.js';
import { verifySealedNote } from './note.js';
import {
  DUMMY_KIND,
  attachDummyOuts,
  dummyCount,
  flowNeedsDummy,
  publicExplorerRow,
  viewTagOf,
} from './dummy.js';
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
      vout: [{ address: to, nanos: 10, kind: 'send' }],
    });
    assert.equal(flowNeedsDummy(send), true);
    assert.ok(dummyCount(send) >= 1);
    const dummy = send.vout.find((o) => o.kind === DUMMY_KIND);
    assert.ok(dummy.commit);
    assert.equal(verifySealedNote(dummy, 0), true);
    assert.equal(dummy.viewTag[0], viewTagOf(dummy.noteCommit)[0]);
    assert.equal(dummy.address, undefined);

    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const lock = lockTx({ from, to: vault, nanos: PI_SHE_NANOS, id: 'lock-d' });
    assert.equal(flowNeedsDummy(lock), false);
    assert.equal(dummyCount(attachDummyOuts(lock)), 0);
    const vote = voteTx({ from, dest: vault, choice: 'hold', id: 'vote-d' });
    assert.equal(flowNeedsDummy(vote), false);
    assert.equal(dummyCount(attachDummyOuts(vote)), 0);
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
