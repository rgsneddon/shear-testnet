import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { encodeDest } from '../../crypto/address.js';
import { createStore } from '../src/store.js';
import { createRpc, hostIsLoopback, rpcHostAllowed, rpcLoopbackBind } from '../src/rpc.js';
import { decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { decodeWireBlock } from '../src/p2p.js';
import { digestTx } from '../src/chain.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 3));
}

let powTag = 1;
function mineOne(store, dest) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : Date.now();
  const { tpl } = store.template({ miner: dest, now });
  const pow = Buffer.alloc(32, 0);
  pow[31] = powTag;
  powTag += 1;
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: pow, skipSharePow: true });
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
      assert.equal(pol.json.consensus_min, 9);
      assert.equal(pol.json.merchant_default, 12);
      assert.equal(pol.json.bands.pool_merchant, 12);
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
    const short = rpc.dispatch('addnode', { host: '1.1.1.1', port: 30303, token: 'x' });
    assert.equal(short.ok, false);
    assert.equal(short.reason, 'rpc_token');
    const long = rpc.dispatch('addnode', { host: '1.1.1.1', port: 30303, token: 'secret-extra' });
    assert.equal(long.ok, false);
    assert.equal(long.reason, 'rpc_token');
    const src = fs.readFileSync(new URL('../src/rpc.js', import.meta.url), 'utf8');
    const add = src.slice(src.indexOf("const mutating = new Set(['addnode'])"), src.indexOf("const hostP"));
    assert.match(add, /tokenEquals/);
    assert.doesNotMatch(add, /!==/);
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
      assert.equal(stats.json.magic, 'shear-testnet-v12');
      assert.equal(stats.json.admit, 'ADMITv3 (sends off)');
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
      // HTTP follow reads the p2p frame (wire=1): decoded as a peer's block
      // is, its body hashes to the header's merkle root (TX_DIGEST=body-v2).
      const wired = await get(`${base}/block?height=1&wire=1`);
      assert.equal(wired.json.ok, true);
      const decoded = decodeWireBlock(wired.json);
      assert.equal(decoded.txs.length, blk.json.txs.length);
      assert.ok(merkleRoot(decoded.txs.map(digestTx)).equals(Buffer.from(decodeHeader(decoded.header).merkleRoot)), 'wire body matches its header');
      const jroot = await get(`${base}/jroot`);
      assert.equal(jroot.json.admit, 'ADMITv3');
      assert.equal(typeof jroot.json.jroot, 'string');
      const explDisk = fs.readFileSync(path.join(dir, 'explorer.jsonl'), 'utf8');
      assert.equal(/"nanos"\s*:/.test(explDisk), false);
      assert.equal(/"amount"\s*:/.test(explDisk), false);
      const flux = await get(`${base}/fluxset`);
      assert.equal(flux.json.admit, 'ADMITv3');
      assert.ok(Array.isArray(flux.json.commits));
      assert.equal(flux.json.commits.length, flux.json.pubs.length);
      const tpl = await post(base, { method: 'gettemplate', params: { miner: dest } });
      assert.equal(tpl.json.ok, true);
      assert.equal(tpl.json.admit, 'ADMITv3');
      assert.equal(tpl.json.magic, 'shear-testnet-v12');
      assert.ok(tpl.json.jobId);
      assert.ok(tpl.json.header);
    } finally {
      await rpc.close();
    }
  });

  it('gates Host and Origin only on a loopback bind that has a token', async () => {
    assert.equal(rpcLoopbackBind('127.0.0.1'), true);
    assert.equal(rpcLoopbackBind('127.255.255.255'), true);
    assert.equal(rpcLoopbackBind('127.0.0.0'), true);
    assert.equal(rpcLoopbackBind('[::1]'), true);
    assert.equal(rpcLoopbackBind('::ffff:127.0.0.1'), true);
    assert.equal(rpcLoopbackBind('[::ffff:127.9.0.1]'), true);
    assert.equal(rpcLoopbackBind('0.0.0.0'), false);
    assert.equal(rpcLoopbackBind('::'), false);
    assert.equal(rpcLoopbackBind('192.168.1.10'), false);
    assert.equal(rpcLoopbackBind('10.1.2.3'), false);
    assert.equal(hostIsLoopback('::ffff:127.0.0.1'), true);
    assert.equal(hostIsLoopback('::ffff:8.8.8.8'), false);
    assert.equal(rpcHostAllowed('127.9.0.1:18332'), true);
    assert.equal(rpcHostAllowed('127.0.0.1:18332'), true);
    assert.equal(rpcHostAllowed('[::ffff:127.0.0.1]:18332'), true);
    assert.equal(rpcHostAllowed('::ffff:127.0.0.1'), true);
    assert.equal(rpcHostAllowed('[::1]:18332'), true);
    assert.equal(rpcHostAllowed('192.168.1.10'), false);
    assert.equal(rpcHostAllowed('127.0.0.1.evil.test'), false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rpc-guard-'));
    const store = createStore(dir);
    const askOn = (port, headers) => new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/policy',
        method: 'GET',
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', reject);
      req.end();
    });

    const open = createRpc({ store, port: 0, host: '127.0.0.1' });
    const bound = await open.listen();
    try {
      const ok = await askOn(bound.port, { host: `127.0.0.1:${bound.port}` });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.consensus_min, 9);
      const named = await askOn(bound.port, { host: 'localhost:18332' });
      assert.equal(named.status, 200);
      const nginx = await askOn(bound.port, { host: '127.0.0.1:18332' });
      assert.equal(nginx.status, 200);
      const host = await askOn(bound.port, { host: 'p2p.shear.digital' });
      assert.equal(host.status, 200);
      const origin = await askOn(bound.port, { host: `127.0.0.1:${bound.port}`, origin: 'https://evil.example' });
      assert.equal(origin.status, 200);
    } finally {
      await open.close();
    }

    const wide = createRpc({ store, port: 0, host: '127.8.8.8' });
    const wideBound = await wide.listen();
    try {
      const askWide = (headers) => new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.8.8.8',
          port: wideBound.port,
          path: '/policy',
          method: 'GET',
          headers,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let json = {};
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* */ }
            resolve({ status: res.statusCode, json });
          });
        });
        req.on('error', reject);
        req.end();
      });
      const okWide = await askWide({ host: '127.8.8.8:18332' });
      assert.equal(okWide.status, 200);
      const lan = await askWide({ host: '10.1.2.3' });
      assert.equal(lan.status, 200);
      const nginxWide = await askWide({ host: '127.0.0.1:18332' });
      assert.equal(nginxWide.status, 200);
    } finally {
      await wide.close();
    }

    const locked = createRpc({ store, port: 0, host: '127.0.0.1', token: 'launch-token' });
    const lockedBound = await locked.listen();
    try {
      const missing = await askOn(lockedBound.port, { host: `127.0.0.1:${lockedBound.port}` });
      assert.equal(missing.status, 403);
      assert.equal(missing.json.reason, 'rpc_token');
      const wrong = await askOn(lockedBound.port, {
        host: `127.0.0.1:${lockedBound.port}`,
        'x-shear-rpc-token': 'nope',
      });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.json.reason, 'rpc_token');
      const host = await askOn(lockedBound.port, {
        host: 'p2p.shear.digital',
        'x-shear-rpc-token': 'launch-token',
      });
      assert.equal(host.status, 403);
      assert.equal(host.json.reason, 'rpc_host');
      const mapped = await askOn(lockedBound.port, {
        host: '127.0.0.1.evil.test',
        'x-shear-rpc-token': 'launch-token',
      });
      assert.equal(mapped.status, 403);
      assert.equal(mapped.json.reason, 'rpc_host');
      const origin = await askOn(lockedBound.port, {
        host: `127.0.0.1:${lockedBound.port}`,
        origin: 'https://evil.example',
        'x-shear-rpc-token': 'launch-token',
      });
      assert.equal(origin.status, 403);
      assert.equal(origin.json.reason, 'rpc_origin');
      const nullOrigin = await askOn(lockedBound.port, {
        host: `127.0.0.1:${lockedBound.port}`,
        origin: 'null',
        'x-shear-rpc-token': 'launch-token',
      });
      assert.equal(nullOrigin.status, 403);
      assert.equal(nullOrigin.json.reason, 'rpc_origin');
      const right = await askOn(lockedBound.port, {
        host: `localhost:${lockedBound.port}`,
        'x-shear-rpc-token': 'launch-token',
      });
      assert.equal(right.status, 200);
      assert.equal(right.json.ok, true);
      const v6 = await askOn(lockedBound.port, {
        host: `[::1]:${lockedBound.port}`,
        'x-shear-rpc-token': 'launch-token',
      });
      assert.equal(v6.status, 200);
      const nginx = await askOn(lockedBound.port, {
        host: '127.0.0.1:18332',
        'x-shear-rpc-token': 'launch-token',
      });
      assert.equal(nginx.status, 200);
      assert.equal(nginx.json.ok, true);
      const eight = await askOn(lockedBound.port, {
        host: '127.4.5.6:18332',
        'x-shear-rpc-token': 'launch-token',
      });
      assert.equal(eight.status, 200);
      const mappedHost = await askOn(lockedBound.port, {
        host: '[::ffff:127.0.0.1]:18332',
        'x-shear-rpc-token': 'launch-token',
      });
      assert.equal(mappedHost.status, 200);
    } finally {
      await locked.close();
    }

    const pub = createRpc({ store, port: 0, host: '0.0.0.0', token: 'fleet-token' });
    const pubBound = await pub.listen();
    try {
      const read = await askOn(pubBound.port, { host: 'p2p.shear.digital' });
      assert.equal(read.status, 200);
      assert.equal(read.json.ok, true);
      const nginx = await askOn(pubBound.port, { host: '127.0.0.1:18332' });
      assert.equal(nginx.status, 200);
      assert.equal(nginx.json.ok, true);
      const origin = await askOn(pubBound.port, { host: '127.0.0.1:18332', origin: 'https://pool.shear.digital' });
      assert.equal(origin.status, 200);
    } finally {
      await pub.close();
    }
  });
});

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
