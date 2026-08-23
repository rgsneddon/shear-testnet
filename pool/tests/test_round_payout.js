import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS } from '../../crypto/asert.js';
import { createPool, scoreShare } from '../src/pool.js';
import { coinbaseSplit } from '../../crypto/mint.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { lag1Continuity } from '../../node/src/chain.js';

function send(sock, obj) {
  sock.write(`${JSON.stringify(obj)}\n`);
}

function readLine(sock, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (c) => {
      buf += c.toString();
      const n = buf.indexOf('\n');
      if (n >= 0) {
        sock.off('data', onData);
        clearTimeout(t);
        resolve(JSON.parse(buf.slice(0, n)));
      }
    };
    const t = setTimeout(() => {
      sock.off('data', onData);
      reject(new Error('line timeout ' + buf.slice(0, 120)));
    }, timeoutMs);
    sock.on('data', onData);
  });
}

async function login(port, login) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((res, rej) => {
    sock.on('connect', res);
    sock.on('error', rej);
  });
  send(sock, {
    id: 1,
    method: 'login',
    params: { login, client: 'ShearHash', threads: 1 },
  });
  const hello = await readLine(sock);
  assert.equal(hello.result?.status, 'OK');
  return { sock, job: hello.job };
}

function findNonces(job, n, { block = false } = {}) {
  const out = [];
  for (let nonce = 0n; nonce < 2_000_000n && out.length < n; nonce += 1n) {
    const s = scoreShare({ job, nonce });
    if (!s.ok) continue;
    if (block && !s.block) continue;
    if (!block && s.block) continue;
    out.push(nonce);
  }
  return out;
}

describe('round hash bonuses', () => {
  it('pays N and M nanos to two miners plus 1 SHE pot on the next sealed job', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pay-'));
    const alice = newIdentity();
    const bob = newIdentity();
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: alice.address,
      shareBits: 4,
      bits: 12,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const port = pool.stratum.address().port;
    const a = await login(port, alice.address + '.a');
    const b = await login(port, bob.address + '.b');
    const job1 = a.job;
    const nA = 3;
    const nB = 2;
    const aliceShares = findNonces(job1, nA, { block: false });
    const bobShares = findNonces(job1, nB, { block: false });
    assert.equal(aliceShares.length, nA);
    assert.equal(bobShares.length, nB);
    for (const nonce of aliceShares) {
      send(a.sock, { id: 2, method: 'submit', params: { jobId: job1.jobId, nonce: String(nonce) } });
      const r = await readLine(a.sock);
      assert.equal(r.result?.status, 'OK');
    }
    for (const nonce of bobShares) {
      send(b.sock, { id: 2, method: 'submit', params: { jobId: job1.jobId, nonce: String(nonce) } });
      const r = await readLine(b.sock);
      assert.equal(r.result?.status, 'OK');
    }
    assert.equal(pool.stats.blocks, 0);
    const win = findNonces(job1, 1, { block: true })[0];
    assert.ok(win != null);
    send(a.sock, { id: 3, method: 'submit', params: { jobId: job1.jobId, nonce: String(win) } });
    const sealed = await readLine(a.sock);
    assert.equal(sealed.result?.status, 'OK');
    let job2 = null;
    for (let i = 0; i < 5 && !job2; i += 1) {
      const maybe = await readLine(a.sock, 3000).catch(() => null);
      if (maybe?.method === 'job') job2 = maybe.params;
      if (maybe?.job) job2 = maybe.job;
    }
    if (!job2) job2 = pool.issueJob();
    const snap = pool.pendingPayout;
    const aliceCount = snap.find((s) => s.miner === alice.address)?.count;
    const bobCount = snap.find((s) => s.miner === bob.address)?.count;
    assert.equal(aliceCount, nA + 1);
    assert.equal(bobCount, nB);
    const win2 = findNonces(job2, 1, { block: true })[0];
    assert.ok(win2 != null);
    send(a.sock, { id: 4, method: 'submit', params: { jobId: job2.jobId, nonce: String(win2) } });
    const sealed2 = await readLine(a.sock);
    assert.equal(sealed2.result?.status, 'OK');
    const paid = pool.store.blocks[pool.store.blocks.length - 1];
    const split = coinbaseSplit(paid.txs[0]);
    assert.equal(split.potNanos, BLOCK_SUBSIDY_NANOS);
    assert.equal(split.potNanos, 1_000_000_000);
    const prev = pool.store.blocks[pool.store.blocks.length - 2];
    const destA = destForLogin(alice.address, {
      continuityRoot: lag1Continuity(prev?.header),
      height: paid.height,
    });
    const destB = destForLogin(bob.address, {
      continuityRoot: lag1Continuity(prev?.header),
      height: paid.height,
    });
    assert.notEqual(destA, alice.address);
    assert.equal(split.hashByMiner[destA], (nA + 1) * HASH_BONUS_NANOS);
    assert.equal(split.hashByMiner[destB], nB * HASH_BONUS_NANOS);
    a.sock.end();
    b.sock.end();
    pool.close();
  });
});
