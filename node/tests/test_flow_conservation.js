import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest, ed25519SeedOf } from '../../crypto/address.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { sealNote } from '../../crypto/note.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { BLOCK_SUBSIDY_NANOS, GENESIS_BITS_PACKED, bitsForBlock } from '../../crypto/asert.js';
import { levyNanos } from '../../crypto/levy.js';
import { fluxsetFromBlocks, proveFlowSpend } from '../../crypto/admit.js';
import {
  buildTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

let powTag = 1;
function mine(tpl) {
  const pow = Buffer.alloc(32, 0);
  pow[31] = powTag;
  powTag += 1;
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hash: pow,
    trustedPowHash: pow,
  };
}
function trust(block) {
  return { trustedPowHash: block.trustedPowHash, skipSharePow: true };
}

describe('Flow conservation binds vin.commit to spent vout', () => {
  it('compact send whose vin.commit is the parent coinbase is ok; a self-minted C_in is confidential', () => {
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const spendSeed = id.spendSeed || ed25519SeedOf(id.privateKey);
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
    }));
    const okP = verifyBlock(parent, null, trust(parent));
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
        commit: spent.commit,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent });
    const liveJ = fluxsetFromBlocks([parent]);
    proveFlowSpend(honest, {
      spendSeed,
      spentNote: spent,
      pubs: liveJ.pubs,
      commits: liveJ.commits,
    });
    const honestTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_090_000,
      txs: [compactTx(honest)],
      prevBlock: parent,
      parentFluxset: fluxsetFromBlocks([parent]).pubs,
    });
    const honestBlock = mine(honestTpl);
    const gotOk = verifyBlock(honestBlock, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
    }, trust(honestBlock));
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
        commit: fakeIn.commit,
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
      bits: bitsForBlock(GENESIS_BITS_PACKED, 1_700_000_000_000, 1_700_000_180_000),
      now: 1_700_000_180_000,
      txs: [compactTx(attack)],
    });
    const attackBlock = mine(attackTpl);
    const gotBad = verifyBlock(attackBlock, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
    }, trust(attackBlock));
    assert.equal(gotBad.ok, false);
    assert.equal(gotBad.reason, 'admit_membership');
  });
});
