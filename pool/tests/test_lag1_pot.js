import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { createPool, scoreShare } from '../src/pool.js';
import { coinbaseSplit } from '../../crypto/mint.js';
import { expectedCoinbasePays, matchSealedCoinbaseVout } from '../../crypto/coinbase_notes.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

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

describe('lag-1 PROP pot', { timeout: 1_200_000 }, () => {
  it('height 2 seals when the live hasher dest is not a lag-1 dest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-seal-'));
    const alice = newIdentity();
    const bob = newIdentity();
    const destA = freshStealthDest(alice.paymentCode).dest;
    const destB = freshStealthDest(bob.paymentCode).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: destA,
      shareBits: 8,
      bits: 9,
      noValidShareMs: 3_600_000,
    });
    let a = null;
    let b = null;
    try {
      await new Promise((resolve, reject) => {
        pool.stratum.listen(0, '127.0.0.1', () => {
          pool.httpServer.listen(0, '127.0.0.1', resolve);
        });
        pool.stratum.on('error', reject);
      });
      const port = pool.stratum.address().port;
      a = await login(port, destA + '.a');
      const job1 = a.job;
      // Pin accepted>0 before the bits=12 block hunt so idle-drop cannot
      // kill the socket (NO_VALID_SHARE_MS is 90s; a floor block is slower).
      const hud = findNonces(job1, 1, { block: false, max: 2_500 })[0];
      assert.ok(hud, 'need a lag-1 share');
      send(a.sock, {
        id: 2,
        method: 'submit',
        params: { jobId: job1.jobId, nonce: String(hud.nonce), hash: hud.hash },
      });
      const shareAck = await a.lines.readResult();
      assert.equal(shareAck.result?.status, 'OK', JSON.stringify(shareAck));
      assert.equal(shareAck.result?.block, false);
      const win1 = findNonces(job1, 1, { block: true, max: 2_500, skip: [hud.nonce] })[0];
      assert.ok(win1 != null, 'need a height-1 block nonce');
      send(a.sock, {
        id: 3,
        method: 'submit',
        params: { jobId: job1.jobId, nonce: String(win1.nonce), hash: win1.hash },
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
      b = await login(port, destB + '.b');
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
      const win2 = findNonces(live2, 1, { block: true, max: 2_500 })[0];
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
      const split = coinbaseSplit(paid.txs[0], { shareBatch: paid.shareBatch, miner: paid.miner });
      assert.equal(split.potNanos, BLOCK_SUBSIDY_NANOS);
      const pays = expectedCoinbasePays(paid.shareBatch || [], { miner: paid.miner });
      const hasherPot = (paid.txs[0].vout || [])
        .filter((o) => o.kind === 'pot' || o.kind === 'pool-fee')
        .map((o) => matchSealedCoinbaseVout(o, pays));
      assert.ok(hasherPot.some((o) => o.address === destA), 'lag-1 dest keeps the PROP pot');
      const toB = hasherPot.filter((o) => o.address === destB).reduce((n, o) => n + Number(o.nanos || 0), 0);
      assert.ok(toB < BLOCK_SUBSIDY_NANOS * 0.5, 'live hasher dest must not take the whole pot');
    } finally {
      try { a?.sock?.destroy(); } catch { /* */ }
      try { b?.sock?.destroy(); } catch { /* */ }
      pool.close();
    }
  });
});
