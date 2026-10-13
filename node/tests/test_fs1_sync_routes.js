import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { createRpc } from '../src/rpc.js';
import { SYNC_EPOCH, SYNC_KEYED_PARAMS } from '../src/fs1_sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.join(here, '../../crypto/native/vendor/monero-oxide-77788c3/shear-fs1/vectors/sync_routes.txt');
const KNOWN_TO = 20 * SYNC_EPOCH;

function get(base, route) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${route}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    }).on('error', reject);
  });
}

function post(base, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function headerStore(top) {
  const blocks = [];
  for (let h = 1; h < top; h += 1) {
    const header = Buffer.alloc(100);
    header.writeUInt32LE(h, 0);
    const hash = Buffer.alloc(32);
    hash.writeUInt32LE(h, 0);
    hash[31] = 0x5a;
    blocks.push({ height: h, header, hash });
  }
  return { blocks };
}

function verdictOf(res) {
  if (res.json.ok === true) return 'ok';
  return res.json.reason;
}

describe('FS-1 sync routes on the node RPC server', () => {
  let rpc;
  let base;
  before(async () => {
    rpc = createRpc({ store: headerStore(KNOWN_TO), port: 0, host: '127.0.0.1' });
    const bound = await rpc.listen();
    base = `http://127.0.0.1:${bound.port}`;
  });
  after(() => rpc.close());

  it('answers every shared vector the same way as shear-fs1 SyncServer', async () => {
    let seen = 0;
    for (const line of fs.readFileSync(VECTORS, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [route, query, want] = line.split('\t');
      assert.ok(want, line);
      const res = await get(base, query ? `${route}?${query}` : route);
      assert.equal(verdictOf(res), want, line);
      if (want === 'ok') assert.equal(res.status, 200, line);
      else if (want === 'route') assert.equal(res.status, 404, line);
      else assert.equal(res.status, 400, line);
      seen += 1;
    }
    assert.ok(seen >= 20, String(seen));
  });

  it('serves one aligned epoch with the S-8 prefix and its headers', async () => {
    const res = await get(base, '/sync?from=64&to=128');
    assert.equal(res.status, 200);
    assert.equal(res.json.from, 64);
    assert.equal(res.json.to, 128);
    const root = Buffer.alloc(32);
    root.writeUInt32LE(127, 0);
    root[31] = 0x5a;
    assert.equal(res.json.headerRoot, root.toString('hex'));
    assert.equal(res.json.headers.length, SYNC_EPOCH);
    assert.deepEqual(res.json.headers.map((h) => h.height), Array.from({ length: SYNC_EPOCH }, (_, i) => 64 + i));
  });

  it('a window past the tip is unknown, not served', async () => {
    const res = await get(base, `/sync?from=${KNOWN_TO}&to=${KNOWN_TO + SYNC_EPOCH}`);
    assert.equal(res.status, 404);
    assert.equal(res.json.reason, 'unknown');
  });

  it('every keyed name is refused on /sync in any case', async () => {
    for (const name of SYNC_KEYED_PARAMS) {
      for (const n of [name, name.toUpperCase()]) {
        const res = await get(base, `/sync?from=0&to=64&${n}=1`);
        assert.equal(res.status, 400, n);
        assert.equal(res.json.reason, 'keyed', n);
      }
    }
  });
});

describe('FS-1 keyed-fetch ban on the real /fluxset routes', () => {
  let rpc;
  let base;
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fs1-sync-'));
    rpc = createRpc({ store: createStore(dir), port: 0, host: '127.0.0.1' });
    const bound = await rpc.listen();
    base = `http://127.0.0.1:${bound.port}`;
  });
  after(() => rpc.close());

  it('serves the whole set to an unkeyed read', async () => {
    for (const route of ['/fluxset', '/getfluxset', '/api/wallet/fluxset']) {
      const res = await get(base, route);
      assert.equal(res.status, 200, route);
      assert.equal(res.json.ok, true, route);
      assert.ok(Array.isArray(res.json.pubs), route);
    }
  });

  it('refuses a read keyed to one leaf, tag, commitment, or address', async () => {
    for (const route of ['/fluxset', '/getfluxset', '/api/wallet/fluxset']) {
      for (const name of SYNC_KEYED_PARAMS) {
        const res = await get(base, `${route}?${name}=1`);
        assert.equal(res.status, 400, `${route} ${name}`);
        assert.equal(res.json.reason, 'keyed_fetch', `${route} ${name}`);
      }
      const upper = await get(base, `${route}?Leaf=3`);
      assert.equal(upper.json.reason, 'keyed_fetch', route);
    }
  });

  it('refuses keyed params on the JSON-RPC getfluxset method', async () => {
    const res = await post(base, { jsonrpc: '2.0', id: 1, method: 'getfluxset', params: { leaf: 4 } });
    assert.equal(res.json.result.ok, false);
    assert.equal(res.json.result.reason, 'keyed_fetch');
    const plain = await post(base, { jsonrpc: '2.0', id: 2, method: 'getfluxset', params: {} });
    assert.equal(plain.json.result.ok, true);
  });

  it('has no path, witness, leaf, or bucket route', async () => {
    for (const route of ['/path', '/witness', '/leaf', '/bucket', '/sync/leaf']) {
      const res = await get(base, `${route}?leaf=1`);
      assert.equal(res.status, 404, route);
      assert.equal(res.json.reason, 'route', route);
    }
  });
});
