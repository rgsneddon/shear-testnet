import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool, scoreShare } from '../src/pool.js';
import {
  clampShareBits,
  expectedOneThreadHs,
  hashesProvenByShare,
  nextShareBits,
  shouldRetargetShare,
  SHARE_VARDIFF_TARGET_MS,
  SHARE_VARDIFF_RETARGET_SHARES,
  SHARE_BITS_V2_START,
} from '../src/share_vardiff.js';

function send(sock, obj) {
  sock.write(`${JSON.stringify(obj)}\n`);
}

function attachLines(sock) {
  let buf = '';
  const q = [];
  const waiters = [];
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, n);
      buf = buf.slice(n + 1);
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw);
      if (waiters.length) waiters.shift()(msg);
      else q.push(msg);
    }
  });
  return function readLine(timeoutMs = 8000) {
    if (q.length) return Promise.resolve(q.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('line timeout')), timeoutMs);
      waiters.push((msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  };
}

function findNonces(job, n) {
  const out = [];
  for (let nonce = 0n; nonce < 2_000_000n && out.length < n; nonce += 1n) {
    const s = scoreShare({ job, nonce });
    if (!s.ok) continue;
    if (s.block) continue;
    out.push({ nonce, hash: s.hash });
  }
  return out;
}

describe('share vardiff', () => {
  it('expected 1-thread H/s is hashes-per-share over the target interval', () => {
    const one = expectedOneThreadHs(12);
    assert.ok(one > 0);
    assert.equal(one, hashesProvenByShare(12) / (SHARE_VARDIFF_TARGET_MS / 1000));
  });

  it('v2 opening share bits is livable at RandomX-lite H/s, not SHA-256 farm scale', () => {
    assert.equal(SHARE_BITS_V2_START, 8);
    const one = expectedOneThreadHs(SHARE_BITS_V2_START);
    assert.ok(one < 10_000, `opening 1-thread H/s ${one} is SHA-256 scale`);
    assert.ok(one > 10);
    assert.ok(expectedOneThreadHs(18) > one);
  });

  it('v2 share interval is slow enough that RandomX verify cannot flood the event loop', () => {
    assert.ok(SHARE_VARDIFF_TARGET_MS >= 2000, SHARE_VARDIFF_TARGET_MS);
  });

  it('never exceeds block bits and never goes below min', () => {
    assert.equal(clampShareBits(24, { blockBits: 21 }), 21);
    assert.equal(clampShareBits(16, { blockBits: 29 }), 16);
    assert.equal(clampShareBits(1, { minBits: 4, blockBits: 8 }), 4);
    assert.equal(clampShareBits(40, { blockBits: 48 }), 40);
    assert.equal(clampShareBits(25, { blockBits: 25 }), 25);
    assert.equal(clampShareBits(300), 256);
  });

  it('raises share bits when shares arrive faster than the session target', () => {
    const next = nextShareBits({
      current: 8,
      actualIntervalMs: 1,
      targetMs: SHARE_VARDIFF_TARGET_MS,
      blockBits: 21,
    });
    assert.ok(next > 8, `expected climb from 8, got ${next}`);
    assert.ok(next <= 21);
  });

  it('does not let share bits fight header bits', () => {
    const next = nextShareBits({
      current: 16,
      actualIntervalMs: 1,
      blockBits: 16,
    });
    assert.equal(next, 16);
  });

  it('retargets after N shares or T milliseconds', () => {
    assert.equal(shouldRetargetShare({ shares: SHARE_VARDIFF_RETARGET_SHARES, elapsedMs: 100 }), true);
    assert.equal(shouldRetargetShare({ shares: 1, elapsedMs: 20_000 }), true);
    assert.equal(shouldRetargetShare({ shares: 1, elapsedMs: 100 }), false);
  });

  it('createPool login job uses v2 opening share bits; accept path retargets from actual interval', async () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /shouldRetargetShare/);
    assert.match(src, /nextShareBits/);
    assert.match(src, /conn\.shareBits = next/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-var-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const openBits = 4;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: openBits,
      bits: 12,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const sock = net.connect(pool.stratum.address().port, '127.0.0.1');
    const readLine = attachLines(sock);
    try {
      send(sock, {
        id: 1,
        method: 'login',
        params: { login: dest + '.var', client: 'ShearHash', threads: 1 },
      });
      const hello = await readLine();
      const job = hello.job || hello.result?.job;
      assert.equal(Number(job.shareBits), openBits);
      assert.ok(Number(job.blockBits) >= Number(job.shareBits));
      assert.ok(Number(job.blockBits) < 21, `blockBits ${job.blockBits} still the too-hard default`);

      const shares = findNonces(job, SHARE_VARDIFF_RETARGET_SHARES);
      assert.equal(shares.length, SHARE_VARDIFF_RETARGET_SHARES);
      let pushed = null;
      for (let i = 0; i < shares.length; i += 1) {
        send(sock, {
          id: 10 + i,
          method: 'submit',
          params: { jobId: job.jobId, nonce: String(shares[i].nonce), hash: shares[i].hash },
        });
        let msg = await readLine();
        if (msg.method === 'job') {
          pushed = msg.params;
          msg = await readLine();
        }
        assert.equal(msg.result?.status, 'OK', msg.error);
        if (msg.method === 'job') pushed = msg.params;
      }
      if (!pushed) {
        const maybe = await readLine(4000).catch(() => null);
        if (maybe?.method === 'job') pushed = maybe.params;
        if (maybe?.job) pushed = maybe.job;
      }
      const conn = [...pool.miners.values()][0]?.connections?.[0];
      const connBits = Number(conn?.shareBits);
      assert.ok(Number.isFinite(connBits));
      assert.ok(pool.stats.accepted >= SHARE_VARDIFF_RETARGET_SHARES);
      assert.ok(Number(conn.varShares) < pool.stats.accepted, 'accept path must retarget the session window');
      assert.ok(connBits <= Number(job.blockBits), 'share bits must never exceed header bits');
      assert.ok(connBits >= 1);
      const climbed = nextShareBits({
        current: openBits,
        actualIntervalMs: 1,
        blockBits: job.blockBits,
        minBits: 1,
      });
      assert.ok(climbed > openBits, 'faster-than-target accepts raise session share bits');
      assert.ok(climbed <= Number(job.blockBits));
      if (pushed) {
        assert.ok(Number(pushed.shareBits) <= Number(pushed.blockBits || job.blockBits));
      }
    } finally {
      sock.end();
      pool.close();
    }
  });
});
