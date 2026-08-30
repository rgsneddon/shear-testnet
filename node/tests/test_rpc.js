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
});
