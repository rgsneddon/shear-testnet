import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { encodeDest } from '../../crypto/address.js';
import { createStore } from '../src/store.js';
import { createRpc } from '../src/rpc.js';
import { mineTemplate } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 3));
}

function mineOne(store, dest, bits = 4) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : Date.now();
  const { tpl } = store.template({ miner: dest, bits, shareBits: bits, now });
  const found = mineTemplate({ ...tpl, bits }, { maxTries: 3_000_000, shareBits: bits });
  assert.ok(found && found.block, 'need pow');
  return store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    }).on('error', reject);
  });
}

describe('node RPC', () => {
  it('serves getpolicy, getchaintips, refuses setTip', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rpc-'));
    const store = createStore(dir);
    const dest = destMiner();
    assert.equal(mineOne(store, dest).ok, true);
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const bound = await rpc.listen();
    try {
      const pol = await get(`http://127.0.0.1:${bound.port}/policy`);
      assert.equal(pol.json.consensus_min, 6);
      assert.equal(pol.json.merchant_default, 12);
      assert.equal(pol.json.bands.pool_merchant, 30);
      assert.equal(pol.json.frozen, false);
      const tips = await get(`http://127.0.0.1:${bound.port}/chaintips`);
      assert.equal(tips.json.tips.some((t) => t.status === 'active'), true);
      const set = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: bound.port,
          path: '/',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject);
        req.write(JSON.stringify({ method: 'setTip', params: { height: 0 } }));
        req.end();
      });
      assert.equal(set.ok, false);
      assert.equal(set.reason, 'setTip_forbidden');
    } finally {
      await rpc.close();
    }
  });

  it('refuses SHEAR_RPC_BIND=0.0.0.0 without token; addnode needs the token', () => {
    assert.throws(() => createRpc({ store: createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rpc-b-'))), host: '0.0.0.0', port: 0 }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rpc-t-'));
    const store = createStore(dir);
    const rpc = createRpc({ store, host: '127.0.0.1', port: 0, token: 'secret' });
    const denied = rpc.dispatch('addnode', { host: '1.1.1.1', port: 30303 });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'rpc_token');
  });

  it('serves stats, headers, compact blocks, and jroot for wallet node-sync', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rpc-sync-'));
    const store = createStore(dir);
    const dest = destMiner();
    assert.equal(mineOne(store, dest).ok, true);
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const bound = await rpc.listen();
    const base = `http://127.0.0.1:${bound.port}`;
    try {
      const stats = await get(`${base}/stats`);
      assert.equal(stats.status, 200);
      assert.equal(stats.json.ok, true);
      assert.equal(stats.json.magic, 'shear-testnet-v3');
      assert.equal(stats.json.admit, 'AdmitV1');
      assert.equal(stats.json.hashTxLive, 1);
      assert.equal(stats.json.height, 1);
      assert.ok(stats.json.header);
      const alias = await get(`${base}/api/stats`);
      assert.equal(alias.json.height, 1);
      const hdrs = await get(`${base}/headers?from=1&to=1`);
      assert.equal(hdrs.json.headers.length, 1);
      assert.ok(hdrs.json.headers[0].header);
      const expl = await get(`${base}/api/explorer/header?height=1`);
      assert.equal(expl.json.ok, true);
      assert.ok(expl.json.header);
      const blk = await get(`${base}/block?height=1`);
      assert.equal(blk.json.ok, true);
      assert.ok(Array.isArray(blk.json.txs));
      const sendTx = (blk.json.txs || []).find((t) => !t.coinbase);
      if (sendTx) {
        assert.equal(sendTx.to, undefined);
        assert.equal(sendTx.nanos, undefined);
      }
      const jroot = await get(`${base}/jroot`);
      assert.equal(jroot.json.admit, 'AdmitV1');
      assert.equal(typeof jroot.json.jroot, 'string');
    } finally {
      await rpc.close();
    }
  });
});
