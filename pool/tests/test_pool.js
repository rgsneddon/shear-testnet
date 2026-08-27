import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  TARGET_BLOCK_INTERVAL_MS,
  MAGIC_TESTNET,
  HASH_TX_LIVE,
} from '../../crypto/asert.js';
import { requiredJobFields } from '../../crypto/header.js';
import { payoutDest } from '../../crypto/address.js';
import { newIdentity, encodeHrp } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool, gateJob, scoreShare, admitClient, foldConnectionInventory, publicMinerLabel, publicMinerTag, splitPot } from '../src/pool.js';
import { publicJob, buildTemplate } from '../../node/src/chain.js';
import { GENESIS_PREV } from '../../node/src/chain.js';

describe('job gate', () => {
  it('refuses a job missing header fields', () => {
    const got = gateJob({ jobId: '1', height: 1 });
    assert.equal(got.ok, false);
    assert.ok(got.missing.includes('header'));
    assert.ok(got.missing.includes('prevBlockHash'));
    assert.ok(got.missing.includes('merkleRoot'));
    assert.ok(got.missing.includes('continuityRoot'));
    assert.ok(got.missing.includes('bits'));
    const shipped = requiredJobFields({ jobId: '1' });
    assert.equal(shipped.ok, false);
  });
});

describe('admit', () => {
  it('admits ssa1 dest and she1 silent ID, refuses rest-frame shear1 and wrong client', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    assert.equal(admitClient({ login: dest, client: 'ShearHash' }).ok, true);
    assert.equal(admitClient({ login: id.paymentCode, client: 'ShearHash' }).ok, true);
    assert.equal(admitClient({ login: id.address, client: 'ShearHash' }).ok, false);
    assert.equal(admitClient({ login: dest, client: 'other' }).ok, false);
    assert.equal(publicMinerLabel(id.paymentCode), publicMinerTag(id.paymentCode));
    assert.match(publicMinerLabel(id.paymentCode), /^she1[0-9a-f]{8}$/);
    assert.equal(publicMinerLabel(id.paymentCode).includes(id.paymentCode.slice(4)), false);
    const silent = payoutDest(id.paymentCode);
    const shares = splitPot([{ miner: id.paymentCode, count: 99 }], 'ssa1unused');
    assert.ok(silent);
    assert.equal(shares.some((s) => s.address === silent && s.nanos === Math.floor(BLOCK_SUBSIDY_NANOS * 0.99)), true);
  });
});

describe('she1 login jobs', () => {
  it('issues a header job when configured miner is rest-frame and login is she1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-she1-'));
    const id = newIdentity();
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: id.address,
      shareBits: 4,
      bits: 8,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', resolve);
      pool.stratum.on('error', reject);
    });
    const port = pool.stratum.address().port;
    const job = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: `${id.paymentCode}.de`, client: 'ShearHash', threads: 1 },
        }) + '\n');
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString();
        if (!buf.includes('\n')) return;
        sock.end();
        try {
          resolve(JSON.parse(buf.split('\n')[0]));
        } catch (e) {
          reject(e);
        }
      });
      sock.on('error', reject);
    });
    pool.stratum.close();
    assert.equal(job.error, undefined, JSON.stringify(job));
    assert.ok(job.job?.header, JSON.stringify(job));
    assert.equal(String(job.job.header).length, 256);
  });
});

describe('pool dashboard + stratum', () => {
  it('serves light SHE page and accepts a header share on 1111', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pool-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 4,
      bits: 8,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const httpPort = pool.httpServer.address().port;
    const stratumPort = pool.stratum.address().port;
    const html = await fetch(`http://127.0.0.1:${httpPort}/`).then((r) => r.text());
    assert.match(html, /background:var\(--bg\)|#eef3f8/);
    assert.match(html, /color:var\(--ink\)|#0d2137/);
    assert.match(html, />SHE</);
    assert.match(html, /ShearHash/);
    assert.match(html, /:1111/);
    assert.match(html, />SHE</);
    assert.equal(html.toLowerCase().includes('shearhash'), true);
    assert.match(html, /she is private/);
    assert.match(html, /ssa1/);
    assert.match(html, /YOUR_SHE1/);
    assert.equal(/--user shear1/.test(html), false);
    assert.equal(html.includes('YOUR_SHEAR1'), false);
    assert.match(html, /shear-testnet-v1/);
    assert.match(html, /Pool explorer · last 30 transactions/);
    assert.match(html, />Id</);
    assert.match(html, />Time</);
    assert.match(html, />Kind</);
    assert.match(html, />From</);
    assert.match(html, />To</);
    assert.match(html, />Amount</);
    assert.doesNotMatch(html, />Asset</);
    assert.match(html, /function fmtLocalTs/);
    assert.match(html, /getDate\(\)/);
    assert.match(html, /getHours\(\)/);
    assert.match(html, /getSeconds\(\)/);
    assert.match(html, /b\.hashrate/);
    assert.match(html, /function shortDest/);
    assert.match(html, /slice\(0, 9\)/);
    assert.equal(/Honesty|honesty|inflate/.test(html), false);
    const stats = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.equal(stats.magic, MAGIC_TESTNET);
    assert.equal(stats.magic, 'shear-testnet-v1');
    assert.equal(stats.network, MAGIC_TESTNET);
    assert.equal(stats.blockSubsidyNanos, BLOCK_SUBSIDY_NANOS);
    assert.equal(stats.blockSubsidyNanos, 100_000_000_000);
    assert.equal(stats.hashBonusNanos, HASH_BONUS_NANOS);
    assert.equal(stats.hashBonusNanos, 1);
    assert.equal(stats.hashTxLive, HASH_TX_LIVE);
    assert.equal(stats.hashTxLive, 1);
    assert.match(stats.bookLawFingerprint, /:1$/);
    assert.equal(stats.targetBlockIntervalMs, TARGET_BLOCK_INTERVAL_MS);
    assert.equal(stats.targetBlockIntervalMs, 90_000);
    assert.equal(stats.destHrp, 'ssa');
    assert.equal(stats.spendableConfirmations, 1);
    assert.equal(stats.minConfirmsPolicy, 12);
    assert.equal(stats.productVersion, '0.1');
    assert.equal(stats.minerVersion, '0.5');
    if (stats.header) assert.equal(stats.header.length, 256);

    const job = pool.issueJob();
    assert.equal(gateJob(job).ok, true);
    assert.equal(job.header.length, 256);

    const scored = await new Promise((resolve, reject) => {
      const sock = net.connect(stratumPort, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: dest + '.rig', client: 'ShearHash', threads: 1 },
        }) + '\n');
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('\n') && buf.includes('job')) {
          const first = JSON.parse(buf.split('\n')[0]);
          const j = first.job || first.params;
          let nonce = 0n;
          let hit = null;
          while (nonce < 200000n) {
            const s = scoreShare({ job: j || job, nonce });
            if (s.ok) { hit = { nonce, s }; break; }
            nonce += 1n;
          }
          if (!hit) {
            sock.destroy();
            reject(new Error('no_share'));
            return;
          }
          sock.write(JSON.stringify({
            id: 2,
            method: 'submit',
            params: { jobId: (j || job).jobId, nonce: String(hit.nonce) },
          }) + '\n');
        }
        if (buf.includes('"status":"OK"') && buf.includes('"hash"')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 20000);
    });
    assert.match(scored, /OK/);
    pool.close();
  });

  it('two sockets on one login sum thread inventory instead of last-write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pool-sess-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 4,
      bits: 8,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const stratumPort = pool.stratum.address().port;
    const login = (threads, cpuThreads) => new Promise((resolve, reject) => {
      const sock = net.connect(stratumPort, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: dest, client: 'ShearHash', threads, cpuThreads, cpuCores: cpuThreads },
        }) + '\n');
      });
      sock.once('data', () => resolve(sock));
      sock.on('error', reject);
      setTimeout(() => reject(new Error('login_timeout')), 5000);
    });
    const a = await login(32, 32);
    const b = await login(230, 256);
    const miner = pool.miners.get(dest);
    assert.equal(miner.threads, 262);
    assert.equal(miner.cpuThreads, 288);
    assert.equal(miner.sessions, 2);
    a.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(miner.threads, 230);
    assert.equal(miner.sessions, 1);
    b.destroy();
    pool.close();
  });
});

describe('session inventory fold', () => {
  it('sums utilised threads and each session device, never last-write', () => {
    const folded = foldConnectionInventory([
      { threads: 32, cpuThreads: 32, cpuCores: 32 },
      { threads: 230, cpuThreads: 256, cpuCores: 256 },
    ]);
    assert.equal(folded.threads, 262);
    assert.equal(folded.cpuThreads, 288);
    assert.equal(folded.cpuCores, 288);
    assert.equal(folded.sessions, 2);
  });

  it('does not cap folded claimed threads at 256', () => {
    const folded = foldConnectionInventory([
      { threads: 300, cpuThreads: 320, cpuCores: 160 },
      { threads: 300, cpuThreads: 320, cpuCores: 160 },
    ]);
    assert.equal(folded.threads, 600);
    assert.equal(folded.cpuThreads, 640);
    assert.ok(folded.threads > 256);
  });
});
