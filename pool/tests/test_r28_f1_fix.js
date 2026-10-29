// F1-FIX (PA §11). Public pool surfaces must not name a finder or publish
// per-tag counters. Two sockets that log in as the same worker name are two
// sessions. These assertions fail on e01e96d7.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createPullBook } from '../src/pull_book.js';
import { createPool } from '../src/pool.js';
import { SHEARK_MINER_VERSION } from '../../crypto/asert.js';
import { CLIENT } from '../../crypto/shear_hash.js';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';

const PER_TAG = [
  'hashrate', 'hashes', 'roundHashes', 'provenHashes', 'proven_round',
  'accepted', 'stale', 'blocks', 'blocksSession', 'blocksLifetime',
  'threads', 'firstSeen', 'lastSeen',
];

function read(rel) {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
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

describe('F1-FIX public pool surfaces', () => {
  it('a reloaded pull book has no found map and no finders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-f1-book-'));
    fs.writeFileSync(path.join(dir, 'pull-book.json'), `${JSON.stringify({
      credits: [],
      pulled: [],
      lastPullMs: {},
      found: { mabcdef01: 2 },
      finders: { 4: { tag: 'mabcdef01', worker: 'rig1' } },
      dests: {},
    })}\n`);
    const book = createPullBook(dir);
    assert.equal(book.finderOf(4), null);
    assert.equal(book.view('mabcdef01').foundBlocks, 0);
    assert.equal(book.hasTag('mabcdef01'), false);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'pull-book.json'), 'utf8'));
    assert.equal(disk.found, undefined);
    assert.equal(disk.finders, undefined);
  });

  it('explorer and the DINS page do not read a finder or a per-tag round hash', () => {
    const explorer = read('../public/explorer.html');
    assert.doesNotMatch(explorer, /finderTag|finderWorker|\.finder\b/);
    const dagDir = new URL('../../site/dag/', import.meta.url);
    const names = fs.readdirSync(dagDir).filter((n) => n.endsWith('.js') || n.endsWith('.html'));
    assert.ok(names.length > 0);
    for (const name of names) {
      const src = fs.readFileSync(new URL(name, dagDir), 'utf8');
      assert.doesNotMatch(src, /finderTag|finderWorker|\.finder\b|roundHashes/, name);
    }
  });

  it('stats hide per-tag counters, miner pages need a login token, and rig1 is one session per socket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-f1-pool-'));
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
      const httpPort = await new Promise((resolve, reject) => {
        pool.stratum.listen(0, '127.0.0.1', () => {
          pool.httpServer.listen(0, '127.0.0.1', () => resolve(pool.httpServer.address().port));
        });
        pool.stratum.on('error', reject);
        pool.httpServer.on('error', reject);
      });
      const stratumPort = pool.stratum.address().port;
      const a = await login(stratumPort, 'rig1');
      const b = await login(stratumPort, 'rig1');
      socks.push(a.sock, b.sock);
      assert.equal(typeof a.result.ownerToken, 'string');
      assert.equal(typeof b.result.ownerToken, 'string');
      assert.notEqual(a.result.ownerToken, b.result.ownerToken);

      const rows = pool.miners();
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0].workerKey, rows[1].workerKey);

      const stats = pool.publicStats();
      for (const row of stats.recentTxs || []) {
        assert.equal(row.finder, undefined);
        assert.equal(row.finderWorker, undefined);
      }
      for (const group of [stats.workers, stats.gossipWorkers]) {
        for (const row of group || []) {
          for (const key of PER_TAG) assert.equal(row[key], undefined, key);
          assert.equal(row.blocks, undefined);
        }
      }

      const tag = rows[0].tag;
      const open = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${tag}`);
      assert.equal(open.status, 404);
      const owned = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${tag}`, {
        headers: { authorization: `Bearer ${a.result.ownerToken}` },
      });
      assert.equal(owned.status, 200);
      const body = await owned.json();
      assert.equal(body.ok, true);
      assert.equal(body.tag, tag);
      assert.equal(Array.isArray(body.workers) ? body.workers.length : 1, 1);

      pool.ban(rows[0].workerKey);
      const left = pool.miners().filter((m) => m.connected);
      assert.equal(left.length, 1);
      assert.equal(left[0].workerKey, rows[1].workerKey);
    } finally {
      for (const sock of socks) {
        try { sock.destroy(); } catch { /* closed */ }
      }
      try { pool.close(); } catch { /* closed */ }
    }
  });
});
