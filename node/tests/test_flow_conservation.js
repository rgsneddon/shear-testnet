import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { sealNote } from '../../crypto/note.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { levyNanos } from '../../crypto/levy.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
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
    hash: found.hash,
  };
}

describe('Flow conservation binds vin.commit to spent vout', () => {
  it('compact send whose vin.commit is the parent coinbase is ok; a self-minted C_in is confidential', () => {
    const dest = freshStealthDest(newIdentity().paymentCode).dest;
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_000_000_000,
    }));
    const okP = verifyBlock(parent, null);
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;
    const spent = parent.txs[0].vout.find((o) => o.kind === 'pot');
    assert.ok(spent?.commit && spent.r);
    const idx = parent.txs[0].vout.indexOf(spent);
    const fee = levyNanos(2);
    const change = BLOCK_SUBSIDY_NANOS - 2 - fee;
    const honest = attachDummyOuts({
      id: 'honest-send',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee,
      changeNanos: change,
      vin: [{
        prev: parent.hash,
        index: idx,
        commit: spent.commit,
        noteCommit: spent.noteCommit,
        r: spent.r,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent });
    const honestTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: 4,
      now: 1_700_000_090_000,
      txs: [compactTx(honest)],
    });
    const honestBlock = mine(honestTpl);
    const gotOk = verifyBlock(honestBlock, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
    });
    assert.equal(gotOk.ok, true, gotOk.reason);

    const fakeIn = sealNote(2 + change + fee, { dest20: Buffer.alloc(20, 9), kind: 'spend-in' });
    const attack = attachDummyOuts({
      id: 'fake-in',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee,
      changeNanos: change,
      vin: [{
        prev: parent.hash,
        index: idx,
        commit: fakeIn.commit,
        noteCommit: fakeIn.noteCommit,
        r: fakeIn.r,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent: fakeIn });
    const attackTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: 4,
      now: 1_700_000_180_000,
      txs: [compactTx(attack)],
    });
    const attackBlock = mine(attackTpl);
    const gotBad = verifyBlock(attackBlock, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
    });
    assert.equal(gotBad.ok, false);
    assert.equal(gotBad.reason, 'confidential');
  });
});
