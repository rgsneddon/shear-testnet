/**
 * The id is a label its sender picks and no signature covers, so it is not
 * in a tx's merkle leaf (chain.js digestTx) or its mempool body key: a
 * relayed copy under a new id is the same tx, and a block cannot carry both
 * (blockLeaves). A withdraw signs its id, so there the id is body (Russell
 * 26 Oct).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import { txBodyKey } from '../../crypto/mempool.js';
import { withdrawTx } from '../../crypto/reserve_vault.js';
import { blockLeaves, digestTx } from '../src/chain.js';

const hex = (b) => Buffer.from(b).toString('hex');

describe('a tx id is not in its leaf, except on a withdraw', () => {
  it('a relayed copy under a new id is the same leaf and the same body key', () => {
    const tx = {
      id: 'sender-picked',
      kind: 'send',
      fee: 120,
      anchor: 3,
      vin: [{ commit: Buffer.alloc(32, 1) }],
      vout: [{ kind: 'send', commit: Buffer.alloc(32, 2), noteCommit: Buffer.alloc(32, 3) }],
    };
    const relayed = { ...tx, id: 'relayer-picked' };
    assert.equal(hex(digestTx(relayed)), hex(digestTx(tx)));
    const { id: _id, ...unlabelled } = tx;
    assert.equal(hex(digestTx(unlabelled)), hex(digestTx(tx)));
    assert.equal(txBodyKey(relayed), txBodyKey(tx));
    // One block cannot carry the tx twice under two ids.
    assert.equal(blockLeaves([{ coinbase: true, vout: [] }, tx, relayed]), null);
    // The body still binds: change a byte and the leaf moves.
    const moved = { ...tx, vout: [{ ...tx.vout[0], commit: Buffer.alloc(32, 9) }] };
    assert.notEqual(hex(digestTx(moved)), hex(digestTx(tx)));
  });

  it('a withdraw signs its id, so its id stays in the leaf', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const w = withdrawTx({ from: vault, to: dest, nanos: 5_000, id: 'w-one' });
    assert.equal(String(w.kind), 'withdraw');
    assert.notEqual(hex(digestTx({ ...w, id: 'w-two' })), hex(digestTx(w)));
  });
});
