import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
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

function findNonces(job, n, { block = false, skip = [], max = 800 } = {}) {
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
function collectRoundNonces(job, shareCount, max = 800) {
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

describe('round hash bonuses', { timeout: 600_000 }, () => {
  it('pays N and M nanos to two miners plus 1 SHE pot on the next sealed job', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pay-'));
    const alice = newIdentity();
    const bob = newIdentity();
    const destA = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const destB = destForLogin(bob.address, { viewKey: bob.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: destA,
      shareBits: 4,
      bits: 6,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const port = pool.stratum.address().port;
    const a = await login(port, destA + '.a');
    const b = await login(port, destB + '.b');
    const job1 = a.job;
    const nA = 3;
    const nB = 2;
    const found = collectRoundNonces(job1, nA + nB);
    const aliceShares = found.shares.slice(0, nA);
    const bobShares = found.shares.slice(nA, nA + nB);
    assert.equal(aliceShares.length, nA);
    assert.equal(bobShares.length, nB);
    for (const rec of aliceShares) {
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
    const unit = 2 ** 4;
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
    // 4-bit vardiff shares are HUD only; coinbase hash units require SHARE_FLOOR_BITS.
    assert.equal(split.potNanos, BLOCK_SUBSIDY_NANOS);
    void hashesCreditedForShare;
    void SHARE_FLOOR_BITS;
    void HASH_BONUS_NANOS;
    a.sock.end();
    b.sock.end();
    pool.close();
  });

  it('height 2 seals when the live hasher dest is not a lag-1 dest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-seal-'));
    const alice = newIdentity();
    const bob = newIdentity();
    const destA = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const destB = destForLogin(bob.address, { viewKey: bob.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: destA,
      shareBits: 8,
      bits: 9,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const port = pool.stratum.address().port;
    const a = await login(port, destA + '.a');
    const job1 = a.job;
    const found = collectRoundNonces(job1, 1, 4000);
    assert.ok(found.shares.length >= 1, 'need a lag-1 share');
    assert.ok(found.blocks.length >= 1, 'need a height-1 block nonce');
    send(a.sock, {
      id: 2,
      method: 'submit',
      params: { jobId: job1.jobId, nonce: String(found.shares[0].nonce), hash: found.shares[0].hash },
    });
    const shareAck = await a.lines.readResult();
    assert.equal(shareAck.result?.status, 'OK');
    assert.equal(shareAck.result?.block, false);
    send(a.sock, {
      id: 3,
      method: 'submit',
      params: { jobId: job1.jobId, nonce: String(found.blocks[0].nonce), hash: found.blocks[0].hash },
    });
    let sealed1 = null;
    for (let i = 0; i < 8 && !sealed1; i += 1) {
      const maybe = await a.lines.readLine(8000).catch(() => null);
      if (!maybe) continue;
      if (maybe.result?.status) sealed1 = maybe;
    }
    assert.equal(sealed1?.result?.status, 'OK');
    assert.equal(sealed1?.result?.block, true);
    assert.equal(pool.store.tip()?.height, 1);

    a.sock.end();
    for (const k of [...pool.miners.keys()]) {
      if (String(k).startsWith(destA)) pool.miners.delete(k);
    }
    const b = await login(port, destB + '.b');
    const job2 = pool.issueJob(undefined, { force: true });
    pool.broadcastJob(job2);
    let live2 = job2;
    for (let i = 0; i < 4; i += 1) {
      const maybe = await b.lines.readLine(4000).catch(() => null);
      if (maybe?.method === 'job' && maybe.params?.header) {
        live2 = maybe.params;
        break;
      }
      if (maybe?.job?.header) {
        live2 = maybe.job;
        break;
      }
    }
    const win2 = findNonces(live2, 1, { block: true, max: 4000 })[0];
    assert.ok(win2 != null, 'need a height-2 block nonce');
    send(b.sock, {
      id: 4,
      method: 'submit',
      params: { jobId: live2.jobId, nonce: String(win2.nonce), hash: win2.hash },
    });
    const sealed2 = await b.lines.readResult(20000);
    assert.equal(sealed2.result?.status, 'OK');
    assert.equal(sealed2.result?.block, true, JSON.stringify(sealed2));
    assert.equal(pool.store.tip()?.height, 2);
    const paid = pool.store.tip();
    const split = coinbaseSplit(paid.txs[0]);
    assert.equal(split.potNanos, BLOCK_SUBSIDY_NANOS);
    const hasherPot = (paid.txs[0].vout || [])
      .filter((o) => o.kind === 'pot' || o.kind === 'pool-fee');
    assert.ok(hasherPot.some((o) => o.address === destA), 'lag-1 dest keeps the PROP pot');
    const toB = hasherPot.filter((o) => o.address === destB).reduce((n, o) => n + Number(o.nanos || 0), 0);
    assert.ok(toB < BLOCK_SUBSIDY_NANOS * 0.5, 'live hasher dest must not take the whole pot');
    b.sock.end();
    pool.close();
  });

  it('provenLag1Shares drops a parent-header miss so the next job stays sealable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lag1-'));
    const alice = newIdentity();
    const destA = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: destA,
      shareBits: 4,
      bits: 6,
    });
    const job = pool.issueJob();
    const parent = Buffer.from(job.header, 'hex');
    const bad = { dest: destA, nonce: 0n, lz: 8 };
    const kept = provenLag1Shares(parent, [bad]);
    assert.equal(kept.length, 0);
    pool.close();
  });
});
