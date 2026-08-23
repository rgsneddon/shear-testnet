import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createStore } from '../../node/src/store.js';
import { buildTemplate, mineTemplate, GENESIS_PREV, lag1Continuity } from '../../node/src/chain.js';
import { handleWalletApi } from '../src/wallet_api.js';

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
  };
}

function get(store, pathAndQuery) {
  const url = new URL(`http://127.0.0.1${pathAndQuery}`);
  return handleWalletApi(url, 'GET', {}, { store, miners: new Map(), queueSend: () => ({}) });
}

describe('explorer view key', () => {
  it('lists lag-1 dest amounts for alice view key and empty for bob / junk', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vk-'));
    const store = createStore(dir);
    store.registerViewKey(alice.address, alice.viewKey);
    store.registerViewKey(bob.address, bob.viewKey);

    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: alice.address,
      bits: 8,
      now: Date.now(),
      samples: [{ miner: alice.address, nonce: '1', tag: 'a', count: 4 }],
    });
    const got = store.append(mine(tpl));
    assert.equal(got.ok, true);
    const dest = destForLogin(alice.address, {
      continuityRoot: lag1Continuity(null),
      height: 1,
    });
    assert.notEqual(dest, alice.address);
    assert.ok(got.block.txs[0].vout.some((o) => o.address === dest && o.kind === 'hash'));

    const aliceOpen = get(store, `/api/explorer/history?address=${alice.address}&viewKey=${alice.viewKey}`);
    assert.equal(aliceOpen.status, 200);
    assert.ok(aliceOpen.json.txs.length >= 1);
    assert.ok(aliceOpen.json.txs.every((t) => typeof t.amount === 'number'));
    assert.ok(aliceOpen.json.txs.some((t) => t.to === dest));

    const bobOpen = get(store, `/api/explorer/history?address=${alice.address}&viewKey=${bob.viewKey}`);
    assert.equal(bobOpen.json.txs.length, 0);

    const junk = get(store, `/api/explorer/history?address=${alice.address}&viewKey=deadbeef`);
    assert.equal(junk.json.txs.length, 0);
  });
});
