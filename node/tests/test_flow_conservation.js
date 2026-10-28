import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { sealNote, verifyFlowConservation } from '../../crypto/note.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { BLOCK_SUBSIDY_NANOS, GENESIS_BITS_PACKED, asertNextBits } from '../../crypto/asert.js';
import { decodeHeader } from '../../crypto/header.js';
import { levyNanos } from '../../crypto/levy.js';
import { fluxsetFromBlocks } from '../../crypto/admit.js';
import { attachStubAdmitV2 } from './stub_admit_v2.js';
import {
  buildTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';
import { bluWallet, soloCoin, soloPay } from './support/blunote_mine.js';

let powTag = 1;
function mine(tpl) {
  const pow = Buffer.alloc(32, 0);
  pow[31] = powTag;
  powTag += 1;
  return {
    header: tpl.header,
    height: tpl.height,
    txs: tpl.txs,
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
    // R28: the parent is a solo option (b) round. Its pot is a record coin of
    // the miner's wallet, which verify derives and the scan key finds.
    const blu = bluWallet(id.spendSeed);
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
      ...soloPay(blu),
    }));
    const okP = verifyBlock(parent, null, trust(parent));
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;
    parent.blunoteRecord = okP.blunoteRecord;
    const spent = soloCoin(blu, parent);
    assert.ok(spent?.commit && spent.r);
    assert.equal(spent.opened, BLOCK_SUBSIDY_NANOS, 'the genesis pot is the subsidy');
    const fee = levyNanos(2);
    const change = spent.opened - 2 - fee;
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
    attachStubAdmitV2(honest);
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
    assert.equal(honest.admit_proof.blob[0], 2);
    assert.equal(verifyFlowConservation(honest), true);
    assert.equal(gotOk.ok, false);
    assert.equal(gotOk.reason, 'admit_version', gotOk.reason);

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
    const attackNow = 1_700_000_180_000;
    const parentTs = Number(decodeHeader(parent.header).timestamp);
    const attackQuote = asertNextBits({
      anchorBits: GENESIS_BITS_PACKED,
      anchorTimeMs: parentTs,
      anchorHeight: 1,
      blockTimeMs: attackNow,
      blockHeight: 2,
      parentTimeMs: parentTs,
    });
    assert.equal(attackQuote.ok, true, attackQuote.reason);
    const attackTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: attackQuote.packed,
      now: attackNow,
      txs: [compactTx(attack)],
      prevBlock: parent,
    });
    const attackBlock = mine(attackTpl);
    const gotBad = verifyBlock(attackBlock, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
    }, trust(attackBlock));
    assert.equal(gotBad.ok, false);
    // Stage 0 refuses a v12 send that carries no proof before membership is judged.
    assert.equal(gotBad.reason, 'send_unavailable');
  });
});
