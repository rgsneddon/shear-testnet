import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin, memoSeal } from '../../crypto/flow_sheet.js';
import { createStore } from '../../node/src/store.js';
import { buildTemplate, mineTemplate, GENESIS_PREV } from '../../node/src/chain.js';
import { handleWalletApi, searchExplorerTxs, explorerCirculation } from '../src/wallet_api.js';

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
    assert.ok(got.block.txs[0].vout.every((o) => o.address.startsWith('shp1')));

    const pub = get(store, '/api/explorer/history');
    assert.equal(pub.status, 200);
    assert.ok(pub.json.txs.length >= 1);
    assert.ok(pub.json.txs.every((t) => typeof t.amount === 'number'));
    assert.ok(pub.json.txs.every((t) => t.memo === true || t.memo === false));
    assert.ok(pub.json.txs.every((t) => t.memoCt == null && t.memoPlain == null));
    assert.ok(pub.json.txs.every((t) => t.to == null && t.from == null));
    assert.ok(pub.json.txs.every((t) => t.id && t.amount != null && t.height != null));
    assert.equal(JSON.stringify(pub.json).includes('shear1'), false);
    const withMemo = pub.json.txs.find((t) => t.id === 'm1' || t.memo === true);
    assert.ok(withMemo);
    assert.equal(JSON.stringify(pub.json).includes('secret-memo'), false);

    const hist = get(store, `/api/wallet/history?address=${dest}`);
    assert.equal(hist.status, 200);
    assert.ok(hist.json.txs.some((t) => t.to === dest));
  });

  it('search by height, tx id, and from–to range; circulation sums dest balances', () => {
    const alice = newIdentity();
    const dest = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-exs-'));
    const store = createStore(dir);
    const env = memoSeal(dest, 'do-not-leak');
    const b1 = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 8,
      now: Date.now(),
      samples: [{ miner: dest, nonce: '1', tag: 'a', count: 1 }],
      txs: [{
        id: 'tx-alpha',
        from: dest,
        to: dest,
        nanos: 1,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: 1, memoCt: env }],
        memoCt: env,
      }],
    });
    assert.equal(store.append(mine(b1)).ok, true);
    const b2 = buildTemplate({
      prev: store.tip().hash,
      prevHeader: store.tip().header,
      height: 2,
      miner: dest,
      bits: 8,
      now: Date.now() + 1000,
      samples: [{ miner: dest, nonce: '2', tag: 'b', count: 1 }],
    });
    assert.equal(store.append(mine(b2)).ok, true);

    const byHeight = get(store, '/api/explorer/search?height=1');
    assert.equal(byHeight.status, 200);
    assert.ok(byHeight.json.txs.length >= 1);
    assert.ok(byHeight.json.txs.every((t) => Number(t.height) === 1));
    assert.ok(byHeight.json.txs.every((t) => typeof t.amount === 'number'));
    assert.ok(byHeight.json.txs.every((t) => t.memo === true || t.memo === false));
    assert.ok(byHeight.json.txs.every((t) => t.memoCt == null && t.memoPlain == null));
    assert.ok(byHeight.json.txs.every((t) => t.to == null && t.from == null));
    assert.equal(JSON.stringify(byHeight.json).includes('shear1'), false);
    assert.equal(JSON.stringify(byHeight.json).includes('do-not-leak'), false);

    const byId = get(store, '/api/explorer/search?id=tx-alpha');
    assert.equal(byId.status, 200);
    assert.ok(byId.json.txs.some((t) => t.id === 'tx-alpha'));
    assert.ok(byId.json.txs.every((t) => String(t.id).includes('tx-alpha')));

    const range = get(store, '/api/explorer/search?from=2&to=2');
    assert.equal(range.status, 200);
    assert.ok(range.json.txs.length >= 1);
    assert.ok(range.json.txs.every((t) => Number(t.height) === 2));
    assert.equal(range.json.txs.some((t) => t.id === 'tx-alpha'), false);

    const shipped = searchExplorerTxs(store, { height: 1 });
    assert.deepEqual(shipped.map((t) => t.id).sort(), byHeight.json.txs.map((t) => t.id).sort());

    const circ = get(store, '/api/explorer/circulation');
    assert.equal(circ.status, 200);
    assert.equal(circ.json.ok, true);
    assert.ok(circ.json.circulating > 0);
    assert.ok(circ.json.emitted > 0);
    assert.ok(circ.json.holderCount >= 1);
    assert.ok(circ.json.holders.every((h) => h.tag == null));
    const viaFn = explorerCirculation(store);
    assert.equal(viaFn.circulating, circ.json.circulating);
  });

  it('explorer page keeps Search TX results instead of polling unfiltered history', () => {
    const page = fs.readFileSync(new URL('../public/explorer.html', import.meta.url), 'utf8');
    assert.match(page, /function hasSearchQuery/);
    assert.match(page, /if \(hasSearchQuery\(\)\) runSearch\(\)/);
    assert.doesNotMatch(page, /if \(filled\) loadRecent\(\)\.catch/);
    assert.match(page, /\/explorer\/search\?/);
  });
});
