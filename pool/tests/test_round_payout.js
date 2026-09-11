import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { hashesCreditedForShare } from '../src/share_vardiff.js';
import { createPool, scoreShare, provenLag1Shares } from '../src/pool.js';
import { coinbaseSplit } from '../../crypto/mint.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { lag1Continuity } from '../../node/src/chain.js';

function send(sock, obj) {
  sock.write(`${JSON.stringify(obj)}\n`);
}

function attachLines(sock) {
  let buf = '';
  const q = [];
  const waiters = [];
  sock.on('data', (c) => {
    buf += c.toString();
    let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, n);
      buf = buf.slice(n + 1);
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (waiters.length) waiters.shift()(msg);
      else q.push(msg);
    }
  });
  function readLine(timeoutMs = 8000) {
    if (q.length) return Promise.resolve(q.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = waiters.indexOf(go);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error('line timeout'));
      }, timeoutMs);
      const go = (msg) => {
        clearTimeout(t);
        resolve(msg);
      };
      waiters.push(go);
    });
  }
  async function readResult(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const left = timeoutMs - (Date.now() - start);
      const msg = await readLine(Math.max(50, left));
      if (msg?.method === 'job') continue;
      return msg;
    }
    throw new Error('line timeout');
  }
  return { readLine, readResult };
}

async function login(port, login) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((res, rej) => {
    sock.on('connect', res);
    sock.on('error', rej);
  });
  const lines = attachLines(sock);
  send(sock, {
    id: 1,
    method: 'login',
    params: { login, client: 'ShearHash', threads: 1 },
  });
  const hello = await lines.readLine();
  assert.equal(hello.result?.status, 'OK');
  return { sock, job: hello.job, lines };
}

function findNonces(job, n, { block = false, skip = [], max = 2_500 } = {}) {
  const seen = new Set([...skip].map((x) => String(x)));
  const out = [];
  for (let nonce = 0n; nonce < BigInt(max) && out.length < n; nonce += 1n) {
    if (seen.has(String(nonce))) continue;
    const s = scoreShare({ job, nonce });
    if (!s.ok) continue;
    if (block && !s.block) continue;
    if (!block && s.block) continue;
    out.push({ nonce, hash: s.hash });
  }
  return out;
}

/** One RandomX pass: non-sealing shares then a block nonce. */
function collectRoundNonces(job, shareCount, max = 2_500) {
  const shares = [];
  const blocks = [];
  for (let nonce = 0n; nonce < BigInt(max); nonce += 1n) {
    const s = scoreShare({ job, nonce });
    if (!s.ok) continue;
    const rec = { nonce, hash: s.hash };
    if (s.block) blocks.push(rec);
    else shares.push(rec);
    if (shares.length >= shareCount && blocks.length >= 1) break;
  }
  return { shares, blocks };
}

describe('round hash bonuses', { timeout: 1_200_000 }, () => {
  it('pays N and M nanos to two miners plus 1 SHE pot on the next sealed job', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pay-'));
    const alice = newIdentity();
    const bob = newIdentity();
    const destA = freshStealthDest(alice.paymentCode).dest;
    const destB = freshStealthDest(bob.paymentCode).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: destA,
      shareBits: SHARE_FLOOR_BITS,
      bits: 9,
      noValidShareMs: 3_600_000,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const port = pool.stratum.address().port;
    let a;
    let b;
    try {
    a = await login(port, destA + '.a');
    b = await login(port, destB + '.b');
    const job1 = a.job;
    const nA = 1;
    const nB = 1;
    const pin = findNonces(job1, 1, { block: false, max: 2_500 })[0];
    assert.ok(pin, 'need a floor share before the long hunt');
    send(a.sock, { id: 2, method: 'submit', params: { jobId: job1.jobId, nonce: String(pin.nonce), hash: pin.hash } });
    assert.equal((await a.lines.readResult()).result?.status, 'OK');
    const found = collectRoundNonces(job1, nA + nB);
    const rest = found.shares.filter((s) => String(s.nonce) !== String(pin.nonce));
    const aliceShares = [pin, ...rest.slice(0, nA - 1)];
    const bobShares = rest.slice(nA - 1, nA - 1 + nB);
    assert.equal(aliceShares.length, nA);
    assert.equal(bobShares.length, nB);
    for (const rec of aliceShares.slice(1)) {
      send(a.sock, { id: 2, method: 'submit', params: { jobId: job1.jobId, nonce: String(rec.nonce), hash: rec.hash } });
      const r = await a.lines.readResult();
      assert.equal(r.result?.status, 'OK');
    }
    for (const rec of bobShares) {
      send(b.sock, { id: 2, method: 'submit', params: { jobId: job1.jobId, nonce: String(rec.nonce), hash: rec.hash } });
      const r = await b.lines.readResult();
      assert.equal(r.result?.status, 'OK');
    }
    assert.equal(pool.stats.blocks, 0);
    const win = found.blocks[0];
    assert.ok(win != null);
    send(a.sock, { id: 3, method: 'submit', params: { jobId: job1.jobId, nonce: String(win.nonce), hash: win.hash } });
    let sealed = null;
    let job2 = null;
    for (let i = 0; i < 8 && (!sealed || !job2); i += 1) {
      const maybe = await a.lines.readLine(8000).catch(() => null);
      if (!maybe) continue;
      if (maybe.result?.status) sealed = maybe;
      if (maybe?.method === 'job') job2 = maybe.params;
      if (maybe?.job) job2 = maybe.job;
    }
    assert.equal(sealed?.result?.status, 'OK');
    if (!job2) job2 = pool.issueJob();
    const snap = pool.pendingPayout;
    const unit = 2 ** SHARE_FLOOR_BITS;
    const aliceCount = snap.find((s) => s.miner === destA)?.count;
    const bobCount = snap.find((s) => s.miner === destB)?.count;
    assert.equal(aliceCount, (nA + 1) * unit);
    assert.equal(bobCount, nB * unit);
    const win2 = findNonces(job2, 1, { block: true })[0];
    assert.ok(win2 != null);
    send(a.sock, { id: 4, method: 'submit', params: { jobId: job2.jobId, nonce: String(win2.nonce), hash: win2.hash } });
    const sealed2 = await a.lines.readResult();
    assert.equal(sealed2.result?.status, 'OK');
    const paid = pool.store.blocks[pool.store.blocks.length - 1];
    const split = coinbaseSplit(paid.txs[0]);
    assert.equal(split.potNanos, BLOCK_SUBSIDY_NANOS);
    assert.equal(split.potNanos, BLOCK_SUBSIDY_NANOS);
    assert.notEqual(destA, alice.address);
    const hashes = paid.txs[0].vout.filter((o) => o.kind === 'hash');
    assert.equal(hashes.filter((o) => o.address === destA).length, 1);
    assert.equal(hashes.filter((o) => o.address === destB).length, 1);
    assert.equal(hashes.find((o) => o.address === destA).nanos, (nA + 1) * unit * HASH_BONUS_NANOS);
    assert.equal(hashes.find((o) => o.address === destB).nanos, nB * unit * HASH_BONUS_NANOS);
    void hashesCreditedForShare;
    a.sock.end();
    b.sock.end();
    } finally {
      try { a?.sock?.destroy(); } catch { /* */ }
      try { b?.sock?.destroy(); } catch { /* */ }
      pool.close();
    }
  });

  it('provenLag1Shares drops a parent-header miss so the next job stays sealable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lag1-'));
    const alice = newIdentity();
    const destA = freshStealthDest(alice.paymentCode).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: destA,
      shareBits: SHARE_FLOOR_BITS,
      bits: 12,
    });
    const job = pool.issueJob();
    const parent = Buffer.from(job.header, 'hex');
    const bad = { dest: destA, nonce: 0n, lz: 8 };
    const kept = provenLag1Shares(parent, [bad]);
    assert.equal(kept.length, 0);

    const sealed = Buffer.from(job.header, 'hex');
    const restamp = Buffer.from(job.header, 'hex');
    restamp.writeBigUInt64LE(restamp.readBigUInt64LE(100) + 10_000n, 100);
    const aliceShare = {
      dest: destA,
      nonce: 11n,
      verifiedHeader: sealed.toString('hex'),
    };
    const bob = newIdentity();
    const destB = freshStealthDest(bob.paymentCode).dest;
    const bobShare = {
      dest: destB,
      nonce: 12n,
      verifiedHeader: sealed.toString('hex'),
    };
    const stale = { dest: destB, nonce: 13n, verifiedHeader: restamp.toString('hex') };
    const mixed = provenLag1Shares(sealed, [aliceShare, bobShare, stale]);
    assert.equal(mixed.length, 2);
    assert.equal(mixed.some((s) => s.dest === destA), true);
    assert.equal(mixed.some((s) => s.dest === destB && String(s.nonce) === '12'), true);
    assert.equal(mixed.some((s) => String(s.nonce) === '13'), false);
    pool.close();
  });
});
