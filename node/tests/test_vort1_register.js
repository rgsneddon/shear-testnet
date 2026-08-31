import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { levyNanos, containsShe1 } from '../../crypto/levy.js';
import { gateVorticeRegister, vorticeRegisterTx } from '../../crypto/vortex.js';
import { createStore } from '../src/store.js';
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
  };
}

describe('vort1 register consensus tx', () => {
  it('bad ticker or mint-not-Reserve fails with no id; passing register pays L; mined fields have no she1', async () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const bytesHash = 'ab'.repeat(32);
    const L = levyNanos(0);
    const she = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.ok-dapp', ticker: 'SHE', fee: L,
    });
    assert.equal(gateVorticeRegister(she).ok, false);
    assert.equal(gateVorticeRegister(she).issued, false);

    const wrap = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.wrap-dapp', ticker: 'wSHE', fee: L,
    });
    assert.equal(gateVorticeRegister(wrap).reason, 'ticker');

    const mint = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.printer', ticker: 'ABC', fee: L, mint: true,
    });
    mint.programId = 'vort1.printer';
    assert.equal(gateVorticeRegister(mint).reason, 'mint');

    const leak = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.ok-dapp', ticker: 'ABC', fee: L,
    });
    leak.she1 = id.paymentCode;
    assert.equal(gateVorticeRegister(leak).reason, 'she1');

    const okTx = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.ok-dapp', ticker: 'ABC', fee: L,
    });
    assert.equal(gateVorticeRegister(okTx).ok, true);
    assert.equal(containsShe1(okTx), false);

    const failBlock = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: Date.now(),
      txs: [she],
    }));
    const failOk = verifyBlock(failBlock, null);
    assert.equal(failOk.ok, true, failOk.reason);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vort1-'));
    const store = createStore(dir);
    const appendedFail = await store.append(failBlock);
    assert.equal(appendedFail.ok, true);
    assert.equal(Object.keys(store.vortice.issued || {}).length, 0);

    const good = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: Date.now() + 1,
      txs: [okTx],
    }));
    const body = JSON.stringify(good.txs[1]);
    assert.equal(body.includes('she1'), false);
    const goodOk = verifyBlock(good, null);
    assert.equal(goodOk.ok, true, goodOk.reason);
    const store2 = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vort1b-')));
    const appended = await store2.append(good);
    assert.equal(appended.ok, true);
    const issued = store2.vortice.issued['vort1.ok-dapp'] || store2.vortice.issued['vort1.vort1.ok-dapp'];
    assert.ok(issued);
    assert.equal(issued.author, dest);
    assert.equal(JSON.stringify(issued).includes('she1'), false);
  });
});
