// F1-FIX public surfaces. Corrected red test for N1-N5, L1, L2, L4, S2, L3.
// Cite FROZEN-v2 dc1e64a173886f9c156c3c105250e84db3261b5b7a30848b4d6089750b35682f
// (§11, unchanged from v1 §8). Historical cite 8f8ba876.
// It fails on the tree that still publishes finders, per-tag counters, and
// per-miner round-hash rows. S1 removes those rows. It does not replace them
// with a salted tag.
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

const DENY_KEY = /^(blocks|finder|findertag|finder_tag|finderworker|finder_worker|foundblocks|found_blocks|blockssession|blocks_session|blockslifetime|blocks_lifetime|workernames|worker_names|workername|worker_name|roundhashes|round_hashes|provenhashes|proven_hashes|proven_round|miner|worker|hashes|hashrate)$/i;

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

function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, signature);
  const next = src.indexOf('\n  function ', start + signature.length);
  return src.slice(start, next > start ? next : src.length);
}

function windows(src, needle, len) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf(needle, i)) >= 0) {
    out.push(src.slice(i, i + len));
    i += needle.length;
  }
  return out;
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
      // N4 (§11.4 item 12). The tag is the session id, observed on the login
      // reply. adminOps is not the source: a login-derived tag would equal
      // publicMinerTag(CANARY) for both sockets.
      assert.equal(typeof a.result.tag, 'string');
      assert.equal(typeof b.result.tag, 'string');
      assert.match(a.result.tag, /^m[0-9a-f]{8}$/);
      assert.match(b.result.tag, /^m[0-9a-f]{8}$/);
      assert.notEqual(a.result.tag, b.result.tag);
      assert.notEqual(a.result.tag, publicMinerTag(CANARY));
      assert.notEqual(b.result.tag, publicMinerTag(CANARY));
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
      // N1. A real confirmed block with a legacy miner field. recentTxs is
      // poolRecentBlockTxs(store.blocks), so an empty book would fail for
      // the wrong reason.
      pool.store.blocks.push({
        height: 1,
        hash: Buffer.alloc(32, 0x11),
        miner: CANARY,
      });
      for (const m of pool.miners.values()) {
        if (m.login === CANARY) m.roundHashes = 9;
      }
      // N4. The session tag comes from the login reply, not adminOps.
      const tag = a.result.tag;
      assert.equal(typeof tag, 'string');
      assert.match(tag, /^m[0-9a-f]{8}$/);
      assert.notEqual(tag, publicMinerTag(CANARY));
      const salted = publicMinerTag(CANARY);
      const v1 = unsaltedTag(CANARY);
      pool.setNetworkView({
        txs: [],
        rounds: [{ tag: salted, count: 4, source: 'peer' }],
      });
      pool.paintStatsSnap();
      assert.deepEqual(pool.store.openRoundRows(), []);
      // N5. Removal of the publish is a pass. A non-empty row is not.
      assert.ok(published.every((r) => Array.isArray(r) && r.length === 0));

      const stats = JSON.parse((await text(httpPort, '/api/stats')).body);
      assert.ok(Array.isArray(stats.recentTxs) && stats.recentTxs.length >= 1);
      for (const row of stats.recentTxs) {
        assert.equal(Object.hasOwn(row, 'finder'), false);
        assert.equal(Object.hasOwn(row, 'finderWorker'), false);
        assert.equal(JSON.stringify(row).includes(CANARY), false);
      }
      // N2. Pool-total hashrate stays. Root blocks* counters do not.
      assert.equal(typeof stats.hashrate, 'number');
      assert.equal(Object.hasOwn(stats, 'blocksSession'), false);
      assert.equal(Object.hasOwn(stats, 'blocksLifetime'), false);
      // L2. The public stats object must not carry the payout error.
      assert.equal(Object.hasOwn(stats, 'autoPayoutLastError'), false);
      for (const row of stats.workers || []) denyKeys(row, '/api/stats.workers');
      for (const row of stats.gossipWorkers || []) denyKeys(row, '/api/stats.gossipWorkers');
      for (const row of stats.recentTxs) denyKeys(row, '/api/stats.recentTxs');

      const mem = await text(httpPort, '/api/mempool');
      const recent = await text(httpPort, '/api/explorer/recent');
      const html = await text(httpPort, `/miner/${tag}`);
      const open = await text(httpPort, `/api/miners/${tag}`);
      assert.equal(html.status, 404);
      assert.equal(open.status, 404);
      const blobs = [JSON.stringify(stats), mem.body, recent.body, html.body, open.body];
      for (const blob of blobs) {
        assert.equal(blob.includes(CANARY), false);
        assert.equal(blob.includes(salted), false);
        assert.equal(blob.includes(v1), false);
        assert.equal(blob.includes(tag), false);
        assert.equal(blob.includes(`hash-${salted}`), false);
        assert.equal(blob.includes(`hash-${v1}`), false);
        assert.equal(blob.includes(`hash-${tag}`), false);
        if (typeof a.result.ownerToken === 'string' && a.result.ownerToken) {
          assert.equal(blob.includes(a.result.ownerToken), false);
        }
        if (typeof b.result.ownerToken === 'string' && b.result.ownerToken) {
          assert.equal(blob.includes(b.result.ownerToken), false);
        }
      }
      for (const blob of [mem.body, recent.body]) {
        const parsed = JSON.parse(blob);
        const rows = [];
        if (Array.isArray(parsed)) rows.push(...parsed);
        else if (parsed && typeof parsed === 'object') {
          for (const key of ['txs', 'rows', 'recent', 'pending']) {
            if (Array.isArray(parsed[key])) rows.push(...parsed[key]);
            if (parsed[key] && Array.isArray(parsed[key].txs)) rows.push(...parsed[key].txs);
          }
          if (parsed.pendingBlock && Array.isArray(parsed.pendingBlock.txs)) {
            rows.push(...parsed.pendingBlock.txs);
          }
        }
        denyKeys(rows, 'public-json');
      }
    } finally {
      for (const sock of socks) {
        try { sock.destroy(); } catch { /* closed */ }
      }
      try { pool.close(); } catch { /* closed */ }
    }
  });

  it('the owner token returns that session only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-f1-own-'));
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
      const { httpPort, stratumPort } = await listen(pool);
      const a = await login(stratumPort, CANARY);
      const b = await login(stratumPort, OTHER);
      socks.push(a.sock, b.sock);
      const tag = a.result.tag;
      assert.equal(typeof tag, 'string');
      assert.notEqual(tag, publicMinerTag(CANARY));
      const open = await text(httpPort, `/api/miners/${tag}`);
      const foreignTok = typeof b.result.ownerToken === 'string' && b.result.ownerToken
        ? b.result.ownerToken
        : 'foreign-token';
      const crossed = await text(httpPort, `/api/miners/${tag}`, {
        authorization: `Bearer ${foreignTok}`,
      });
      assert.equal(open.status, 404);
      assert.equal(crossed.status, 404);
      assert.equal(typeof a.result.ownerToken, 'string');
      assert.equal(typeof b.result.ownerToken, 'string');
      assert.notEqual(a.result.ownerToken, b.result.ownerToken);
      const own = await text(httpPort, `/api/miners/${tag}`, {
        authorization: `Bearer ${a.result.ownerToken}`,
      });
      assert.equal(own.status, 200);
      const body = JSON.parse(own.body);
      assert.equal(body.tag, tag);
      const sessions = Array.isArray(body.workers) ? body.workers : [];
      assert.equal(sessions.length, 1);
      const ownBlob = JSON.stringify(body);
      assert.equal(ownBlob.includes(OTHER), false);
      assert.equal(ownBlob.includes(b.result.ownerToken), false);
      const pub = await text(httpPort, '/api/stats');
      assert.equal(pub.body.includes(a.result.ownerToken), false);
      assert.equal(pub.body.includes(b.result.ownerToken), false);
    } finally {
      for (const sock of socks) {
        try { sock.destroy(); } catch { /* closed */ }
      }
      try { pool.close(); } catch { /* closed */ }
    }
  });

  it('share error logs do not carry the login', () => {
    const src = read('../src/pool.js');
    const hits = windows(src, "event: 'share_hash_backend'", 500)
      .concat(windows(src, "event: 'share_bad_hash'", 500));
    assert.equal(hits.length, 3);
    for (const hit of hits) {
      assert.equal(/session\??\.(workerKey|login)/.test(hit), false, hit.slice(0, 80));
    }
  });

  it('a payout error is not stored against a miner tag', () => {
    const src = read('../src/pool.js');
    const rec = fnBody(src, 'function recordAutoPayoutError');
    assert.equal(/\btag\b/.test(rec), false);
  });

  it('creditRound does not record a finder', () => {
    const book = read('../src/pull_book.js');
    const body = fnBody(book, 'function creditRound');
    assert.equal(/state\.found\s*\[/.test(body), false);
    assert.equal(/state\.finders\s*\[/.test(body), false);
    const poolSrc = read('../src/pool.js');
    const call = windows(poolSrc, 'pullBook.creditRound', 900);
    assert.equal(call.length, 1);
    assert.equal(/finderTag|finderWorker/.test(call[0]), false);
  });

  it('a seal does not increment a public per-tag block counter', () => {
    const src = read('../src/pool.js');
    assert.equal(src.includes('session.blocks = (Number(session.blocks) || 0) + 1'), false);
  });
});
