import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin, memoSeal } from '../../crypto/flow_sheet.js';
import { createStore } from '../../node/src/store.js';
import { buildTemplate, mineTemplate, GENESIS_PREV } from '../../node/src/chain.js';
import { handleWalletApi, searchExplorerTxs, explorerCirculation, poolRecentBlockTxs, publicBlockDetail, mempoolIncoming } from '../src/wallet_api.js';
import { HASH_BONUS_NANOS, NANOS_PER_SHE } from '../../crypto/asert.js';
import { bitsForBlock, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { decodeHeader } from '../../crypto/header.js';

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
        fee: 8,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: 1, memoCt: env }],
        memoCt: env,
      }],
    });
    const got = store.append(mine(tpl));
    assert.equal(got.ok, true, got.reason);
    assert.ok(got.block.txs[0].vout.every((o) => o.address.startsWith('ssa1')));

    const pub = get(store, '/api/explorer/history');
    assert.equal(pub.status, 200);
    assert.ok(pub.json.txs.length >= 1);
    assert.ok(pub.json.txs.every((t) => t.kind === 'block'));
    assert.ok(pub.json.txs.every((t) => t.from === 'coinbase'));
    assert.ok(pub.json.txs.every((t) => t.asset === 'SHE'));
    assert.ok(pub.json.txs.every((t) => !t.to || String(t.to).startsWith('ssa1')));
    assert.ok(pub.json.txs.every((t) => typeof t.amount === 'number'));
    assert.ok(pub.json.txs.every((t) => t.memoCt == null && t.memoPlain == null));
    assert.ok(pub.json.txs.every((t) => t.id && t.amount != null && t.height != null));
    assert.equal(JSON.stringify(pub.json).includes('shear1'), false);
    assert.equal(JSON.stringify(pub.json).includes('secret-memo'), false);
    assert.equal(pub.json.txs.some((t) => t.id === 'm1'), false);

    const hist = get(store, `/api/wallet/history?address=${dest}`);
    assert.equal(hist.status, 200);
    assert.equal(hist.json.amountsOnly, false);
    assert.equal(hist.json.rolled, true);
    assert.ok(hist.json.txs.some((t) => t.to === dest && t.kind === 'blockfound'));
    assert.ok(hist.json.txs.every((t) => t.kind !== 'hash'));
    const she = get(store, `/api/wallet/history?address=${alice.paymentCode}`);
    assert.equal(she.status, 200);
    assert.equal(she.json.amountsOnly, true);
    assert.ok(she.json.txs.every((t) => t.to == null && t.from == null && t.memoCt == null));
    assert.equal(JSON.stringify(she.json).includes(dest), false);
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
        fee: 8,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: 1, memoCt: env }],
        memoCt: env,
      }],
    });
    assert.equal(store.append(mine(b1)).ok, true);
    const parent = store.tip();
    const parentH = decodeHeader(Buffer.from(parent.header));
    const t2 = Number(parentH.timestamp) + TARGET_BLOCK_INTERVAL_MS;
    const bits2 = bitsForBlock(parentH.bits, parentH.timestamp, t2);
    const b2 = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: bits2,
      now: t2,
      samples: [{ miner: dest, nonce: '2', tag: 'b', count: 1 }],
    });
    assert.equal(store.append(mine(b2)).ok, true);

    const hist = get(store, '/api/explorer/history');
    assert.equal(hist.status, 200);
    const heights = hist.json.txs.map((t) => Number(t.height));
    assert.ok(heights.length >= 2);
    assert.deepEqual(heights, [...heights].sort((a, b) => b - a));
    assert.ok(heights[0] >= heights[heights.length - 1]);

    const byHeight = get(store, '/api/explorer/search?height=1');
    assert.equal(byHeight.status, 200);
    assert.ok(byHeight.json.txs.length >= 1);
    assert.ok(byHeight.json.txs.every((t) => Number(t.height) === 1));
    assert.ok(byHeight.json.txs.every((t) => t.kind === 'block'));
    assert.ok(byHeight.json.txs.every((t) => t.from === 'coinbase'));
    assert.ok(byHeight.json.txs.every((t) => typeof t.amount === 'number'));
    assert.ok(byHeight.json.txs.every((t) => t.memoCt == null && t.memoPlain == null));
    assert.equal(JSON.stringify(byHeight.json).includes('shear1'), false);
    assert.equal(JSON.stringify(byHeight.json).includes('do-not-leak'), false);

    const h1 = store.blocks[0];
    const hid = Buffer.isBuffer(h1.hash) ? h1.hash.toString('hex') : String(h1.hash);
    const byId = get(store, `/api/explorer/search?id=${hid}`);
    assert.equal(byId.status, 200);
    assert.ok(byId.json.txs.some((t) => t.id === hid));
    assert.ok(byId.json.txs.every((t) => t.kind === 'block'));
    const miss = get(store, '/api/explorer/search?id=tx-alpha');
    assert.equal(miss.json.txs.some((t) => t.id === 'tx-alpha'), false);

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

    const recent = poolRecentBlockTxs(store, 30);
    assert.ok(recent.length >= 1);
    assert.ok(recent.every((t) => t.kind === 'block'));
    assert.ok(recent.every((t) => t.asset === 'SHE'));
    assert.ok(recent.every((t) => t.from === 'coinbase'));
    assert.ok(recent.every((t) => Number(t.amount) > 0));
    assert.ok(recent[0].height >= recent[recent.length - 1].height);
    const ids = recent.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    const blob = JSON.stringify(recent);
    assert.equal(blob.includes('shear1'), false);
    assert.equal(/she1[^1]/.test(blob.replace(/ssa1/g, '')), false);
    assert.ok(recent.every((t) => Number.isFinite(Number(t.at)) && Number(t.at) > 0));
    assert.ok(recent.every((t) => !t.to || t.to.startsWith('ssa1')));
    const apiRecent = get(store, '/api/pool/recent-txs');
    assert.equal(apiRecent.status, 200);
    assert.deepEqual(apiRecent.json.txs.map((t) => t.id), recent.map((t) => t.id));

    const detail = publicBlockDetail(store, hid);
    assert.ok(detail && detail.cli);
    assert.match(detail.cli, /SHEAR CTF/);
    assert.match(detail.cli, /privacy audit/);
    assert.equal(detail.cli.includes('shear1'), false);
    assert.equal(/she1[^p]/i.test(detail.cli.replace(/ssa1/g, '')), false);
    assert.equal(detail.cli.includes('do-not-leak'), false);
    const apiTx = get(store, `/api/explorer/tx?id=${hid}`);
    assert.equal(apiTx.status, 200);
    assert.equal(apiTx.json.ok, true);
    assert.equal(apiTx.json.cli, detail.cli);
  });

  it('explorer page lists confirmed blocks like the pool last-30 table', () => {
    const page = fs.readFileSync(new URL('../public/explorer.html', import.meta.url), 'utf8');
    assert.match(page, /function hasSearchQuery/);
    assert.match(page, /if \(hasSearchQuery\(\)\) runSearch\(\)/);
    assert.doesNotMatch(page, /if \(filled\) loadRecent\(\)\.catch/);
    assert.match(page, /\/explorer\/search\?/);
    assert.match(page, /\/explorer\/recent/);
    assert.match(page, /Last 30 transactions/);
    assert.match(page, />Time</);
    assert.match(page, />Kind</);
    assert.match(page, />From</);
    assert.match(page, />To</);
    assert.match(page, />Amount</);
    assert.doesNotMatch(page, />Asset</);
    assert.match(page, /function fmtLocalTs/);
    assert.match(page, /getSeconds\(\)/);
    assert.match(page, /font:13px\/1\.35/);
    assert.match(page, /function shortDest/);
    assert.match(page, /slice\(0, 9\)/);
    assert.doesNotMatch(page, />Memo</);
    assert.doesNotMatch(page, /Recent transfers/);
    assert.match(page, /id="net-grid"/);
    assert.doesNotMatch(page, /id="ex-algo"/);
    assert.doesNotMatch(page, /id="ex-network"/);
    assert.match(page, /id="tx-cli"/);
    assert.match(page, /#00FF41/);
    assert.match(page, /back to explorer/);
    assert.match(page, /\/tx\//);
    assert.match(page, /\/explorer\/tx\?id=/);
  });
});

describe('wallet pending incoming', () => {
  it('balance lists mempool receives as incoming; hash pending stays separate', () => {
    const alice = newIdentity();
    const dest = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const peer = newIdentity();
    const bob = destForLogin(peer.address, { viewKey: peer.viewKey, height: 1 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-in-'));
    const store = createStore(dir);
    store.mempool.push({
      id: 'in-1',
      from: bob,
      to: dest,
      amount: 0.4,
      nanos: Math.round(0.4 * NANOS_PER_SHE),
    });
    const miners = new Map([['m', { login: dest, roundHashes: 7 }]]);
    const url = new URL(`http://127.0.0.1/api/wallet/balance?address=${dest}`);
    const out = handleWalletApi(url, 'GET', {}, { store, miners, queueSend: () => ({}) });
    assert.equal(out.status, 200);
    assert.equal(out.json.incoming.length, 1);
    assert.equal(out.json.incoming[0].kind, 'receive');
    assert.equal(out.json.incoming[0].id, 'in-1');
    assert.equal(out.json.incoming[0].confirmed, false);
    assert.equal(out.json.incoming[0].amount, 0.4);
    assert.equal(out.json.pending, 7 * HASH_BONUS_NANOS / NANOS_PER_SHE);
    assert.equal(mempoolIncoming(store, dest).length, 1);
  });
});
