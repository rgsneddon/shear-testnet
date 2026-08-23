import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin, memoSeal } from '../../crypto/flow_sheet.js';
import { createStore } from '../../node/src/store.js';
import { buildTemplate, mineTemplate, GENESIS_PREV } from '../../node/src/chain.js';
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

describe('explorer dests', () => {
  it('lists dest amounts and memo boolean only, no ciphertext, no rest-frame', () => {
    const alice = newIdentity();
    const dest = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ex-'));
    const store = createStore(dir);
    const env = memoSeal(dest, 'secret-memo');
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 8,
      now: Date.now(),
      samples: [{ miner: dest, nonce: '1', tag: 'a', count: 4 }],
      txs: [{
        id: 'm1',
        from: dest,
        to: dest,
        nanos: 1,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: 1, memoCt: env }],
        memoCt: env,
      }],
    });
    const got = store.append(mine(tpl));
    assert.equal(got.ok, true, got.reason);
    assert.ok(got.block.txs[0].vout.every((o) => o.address.startsWith('sdcard1') || o.address.startsWith('she1')));

    const pub = get(store, '/api/explorer/history');
    assert.equal(pub.status, 200);
    assert.ok(pub.json.txs.length >= 1);
    assert.ok(pub.json.txs.every((t) => typeof t.amount === 'number'));
    assert.ok(pub.json.txs.every((t) => t.memo === true || t.memo === false));
    assert.ok(pub.json.txs.every((t) => t.memoCt == null && t.memoPlain == null));
    assert.ok(pub.json.txs.every((t) => !String(t.to || '').startsWith('shear1')));
    const withMemo = pub.json.txs.find((t) => t.id === 'm1' || t.memo === true);
    assert.ok(withMemo);
    assert.equal(JSON.stringify(pub.json).includes('secret-memo'), false);

    const hist = get(store, `/api/wallet/history?address=${dest}`);
    assert.equal(hist.status, 200);
    assert.ok(hist.json.txs.some((t) => t.to === dest));
  });
});
