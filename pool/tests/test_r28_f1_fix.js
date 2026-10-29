// F1-FIX public surfaces. This file is the corrected red test. It fails on
// the tree that still publishes finders, per-tag counters, and per-miner
// round-hash rows. S1 removes those rows. It does not replace them with a
// salted tag.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createPullBook } from '../src/pull_book.js';
import { createPool, publicMinerTag } from '../src/pool.js';
import { SHEARK_MINER_VERSION } from '../../crypto/asert.js';
import { CLIENT } from '../../crypto/shear_hash.js';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';

const CANARY = 'pa_canary_7Q';
const OTHER = 'other_rig';

// A letter before roundHashes is a different word (networkRoundHashes).
const PAGE_RE = /finder|foundblocks|blockslifetime|blockssession|(?<![a-z])roundhashes/i;

const DENY_KEY = /^(finder|findertag|finder_tag|finderworker|finder_worker|foundblocks|found_blocks|blockssession|blocks_session|blockslifetime|blocks_lifetime|workernames|worker_names|workername|worker_name|roundhashes|round_hashes|provenhashes|proven_hashes|proven_round|miner|worker|hashes|hashrate)$/i;

function read(rel) {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
}

function unsaltedTag(login) {
  const dest = String(login || '').trim().split('.')[0];
  const hex = createHash('sha256').update('shear-miner-tag-v1').update(dest).digest('hex').slice(0, 8);
  return `m${hex}`;
}

function denyKeys(value, where, trail = []) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) denyKeys(value[i], where, trail.concat(i));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.equal(DENY_KEY.test(key), false, `${where} ${trail.concat(key).join('.')}`);
    denyKeys(child, where, trail.concat(key));
  }
}

function login(port, name) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('login_timeout'));
    }, 20_000);
    const fail = (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    sock.on('error', fail);
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) {
          fail(new Error(String(msg.error)));
          return;
        }
        if (msg.id === 1 && msg.result) {
          clearTimeout(timer);
          resolve({ sock, result: msg.result });
          return;
        }
      }
    });
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({
        id: 1,
        method: 'login',
        params: {
          login: name,
          client: CLIENT,
          version: SHEARK_MINER_VERSION,
          threads: 1,
        },
      })}\n`);
    });
  });
}

function listen(pool) {
  return new Promise((resolve, reject) => {
    pool.stratum.listen(0, '127.0.0.1', () => {
      pool.httpServer.listen(0, '127.0.0.1', () => resolve({
        httpPort: pool.httpServer.address().port,
        stratumPort: pool.stratum.address().port,
      }));
    });
    pool.stratum.on('error', reject);
    pool.httpServer.on('error', reject);
  });
}

async function text(port, pathname, headers) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  return { status: res.status, body: await res.text() };
}

describe('F1-FIX public pool surfaces', () => {
  function bookWithFinder() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-f1-book-'));
    fs.writeFileSync(path.join(dir, 'pull-book.json'), `${JSON.stringify({
      credits: [],
      pulled: [],
      lastPullMs: {},
      found: { mabcdef01: 2 },
      finders: { 4: { tag: 'mabcdef01', worker: 'rig1' } },
      dests: {},
    })}\n`);
    return { dir, book: createPullBook(dir) };
  }

  it('a reloaded pull book does not return a finder', () => {
    const { book } = bookWithFinder();
    assert.equal(book.finderOf(4), null);
  });

  it('a reloaded pull book view has no foundBlocks key', () => {
    const { book } = bookWithFinder();
    assert.equal(Object.hasOwn(book.view('mabcdef01'), 'foundBlocks'), false);
  });

  it('a reloaded pull book does not keep found or finders on disk', () => {
    const { dir } = bookWithFinder();
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'pull-book.json'), 'utf8'));
    assert.equal(Object.hasOwn(disk, 'found'), false);
    assert.equal(Object.hasOwn(disk, 'finders'), false);
  });

  it('pool pages and the dag page do not name a finder or a per-tag counter', () => {
    const files = [
      '../public/explorer.html',
      '../public/index.html',
      '../public/miner.html',
      '../../explorer/explorer.html',
    ];
    for (const rel of files) {
      assert.equal(PAGE_RE.test(read(rel)), false, rel);
    }
    const dagDir = new URL('../../site/dag/', import.meta.url);
    const names = fs.readdirSync(dagDir).filter((n) => n.endsWith('.js') || n.endsWith('.html'));
    assert.ok(names.length > 0);
    for (const name of names) {
      const src = fs.readFileSync(new URL(name, dagDir), 'utf8');
      assert.equal(PAGE_RE.test(src), false, name);
    }
  });

  it('two sockets with one worker name are two sessions, and a ban drops only one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-f1-sess-'));
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: freshStealthDest(newIdentity()).dest,
      shareBits: 8,
      bits: 16,
    });
    const socks = [];
    try {
      const { stratumPort } = await listen(pool);
      const a = await login(stratumPort, CANARY);
      const b = await login(stratumPort, CANARY);
      socks.push(a.sock, b.sock);
      const rows = pool.adminOps.miners().filter((m) => m.workerKey.startsWith(CANARY));
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0].workerKey, rows[1].workerKey);
      pool.adminOps.ban(rows[0].workerKey);
      const left = pool.adminOps.miners().filter((m) => m.connected && m.workerKey.startsWith(CANARY));
      assert.equal(left.length, 1);
      assert.equal(left[0].workerKey, rows[1].workerKey);
    } finally {
      for (const sock of socks) {
        try { sock.destroy(); } catch { /* closed */ }
      }
      try { pool.close(); } catch { /* closed */ }
    }
  });

  it('each login reply carries its own ownerToken', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-f1-tok-'));
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: freshStealthDest(newIdentity()).dest,
      shareBits: 8,
      bits: 16,
    });
    const socks = [];
    try {
      const { stratumPort } = await listen(pool);
      const a = await login(stratumPort, CANARY);
      const b = await login(stratumPort, OTHER);
      socks.push(a.sock, b.sock);
      assert.equal(typeof a.result.ownerToken, 'string');
      assert.equal(typeof b.result.ownerToken, 'string');
      assert.notEqual(a.result.ownerToken, b.result.ownerToken);
    } finally {
      for (const sock of socks) {
        try { sock.destroy(); } catch { /* closed */ }
      }
      try { pool.close(); } catch { /* closed */ }
    }
  });

  it('public bytes hide the canary, both tags, and per-miner hash rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-f1-http-'));
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: freshStealthDest(newIdentity()).dest,
      shareBits: 8,
      bits: 16,
    });
    const published = [];
    pool.setP2p({
      publishWork(rows) {
        published.push(Array.isArray(rows) ? rows.map((r) => ({ ...r })) : rows);
      },
    });
    const socks = [];
    try {
      const { httpPort, stratumPort } = await listen(pool);
      const a = await login(stratumPort, CANARY);
      const b = await login(stratumPort, OTHER);
      socks.push(a.sock, b.sock);
      for (const m of pool.miners.values()) {
        if (m.login === CANARY) m.roundHashes = 9;
      }
      const salted = publicMinerTag(CANARY);
      const v1 = unsaltedTag(CANARY);
      pool.setNetworkView({
        txs: [],
        rounds: [{ tag: salted, count: 4, source: 'peer' }],
      });
      pool.paintStatsSnap();
      assert.deepEqual(pool.store.openRoundRows(), []);
      assert.deepEqual(published.at(-1), []);

      const stats = JSON.parse((await text(httpPort, '/api/stats')).body);
      assert.ok(Array.isArray(stats.recentTxs) && stats.recentTxs.length >= 1);
      assert.ok(stats.workers === undefined || stats.workers.length >= 1);
      denyKeys(stats, '/api/stats');
      const mem = await text(httpPort, '/api/mempool');
      const recent = await text(httpPort, '/api/explorer/recent');
      const html = await text(httpPort, `/miner/${salted}`);
      const open = await text(httpPort, `/api/miners/${salted}`);
      const otherHdr = { authorization: `Bearer ${b.result.ownerToken || ''}` };
      const crossed = await text(httpPort, `/api/miners/${salted}`, otherHdr);
      assert.equal(open.status, 404);
      assert.equal(crossed.status, 404);
      assert.equal(html.status, 404);
      const blobs = [JSON.stringify(stats), mem.body, recent.body, html.body, open.body, crossed.body];
      for (const blob of blobs) {
        assert.equal(blob.includes(CANARY), false);
        assert.equal(blob.includes(salted), false);
        assert.equal(blob.includes(v1), false);
        assert.equal(blob.includes(`hash-${salted}`), false);
        assert.equal(blob.includes(`hash-${v1}`), false);
      }
      for (const blob of [mem.body, recent.body]) {
        const parsed = JSON.parse(blob);
        denyKeys(parsed, 'public-json');
      }
    } finally {
      for (const sock of socks) {
        try { sock.destroy(); } catch { /* closed */ }
      }
      try { pool.close(); } catch { /* closed */ }
    }
  });
});
