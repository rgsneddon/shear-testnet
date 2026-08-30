import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  POOL_FEE_BPS,
  TARGET_BLOCK_INTERVAL_MS,
  MAGIC_TESTNET,
  HASH_TX_LIVE,
} from '../../crypto/asert.js';
import { requiredJobFields, encodeHeader, decodeHeader, headerFromHex } from '../../crypto/header.js';
import { payoutDest } from '../../crypto/address.js';
import { newIdentity, encodeHrp } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool, gateJob, scoreShare, admitClient, foldConnectionInventory, publicMinerLabel, publicMinerTag, splitPot, isPublicMinerRow, lastValidWorkAt, foldPublicMinerViews, HASH_PRESENCE_MS, CMINER_FEE_SHE, isCminerFeeLogin, bloomExpletive, publicWorkerName, uniquePublicLabels, avgBlockIntervalMs, JOB_RESTAMP_MS, STATS_REFRESH_MS } from '../src/pool.js';
import { publicJob, buildTemplate, hashBonusByMiner } from '../../node/src/chain.js';
import { GENESIS_PREV } from '../../node/src/chain.js';

describe('observed interval', () => {
  it('averages every consecutive sealed header, not only the last pair or a window of 20', () => {
    const hdr = (ms) => encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: BigInt(ms),
      bits: 16,
    });
    const blocks = [
      { header: hdr(1_000_000) },
      { header: hdr(1_090_000) },
      { header: hdr(1_180_000) },
      { header: hdr(1_370_000) },
    ];
    assert.equal(avgBlockIntervalMs(blocks), (90_000 + 90_000 + 190_000) / 3);
    assert.equal(avgBlockIntervalMs(blocks.slice(-2)), 190_000);
    assert.equal(avgBlockIntervalMs(blocks, 2), 190_000);
  });

  it('pool restamps live jobs so header time tracks wall clock', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /JOB_RESTAMP_MS/);
    assert.match(src, /maybeRestampJob/);
    assert.match(src, /setInterval\(maybeRestampJob/);
    assert.equal(/if \(!\(want < have\)\) return/.test(src), false);
    assert.equal(JOB_RESTAMP_MS, 10_000);
  });

  it('restamp patches timestamp only; merkle/bits/jobId stay so RandomX K does not rebuild', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-restamp-k-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    const job = pool.issueJob();
    assert.ok(job?.header);
    const before = decodeHeader(headerFromHex(job.header));
    job.timestamp = String(Date.now() - JOB_RESTAMP_MS - 50);
    const next = pool.restampJob();
    assert.equal(next.jobId, job.jobId);
    const after = decodeHeader(headerFromHex(next.header));
    assert.ok(after.merkleRoot.equals(before.merkleRoot));
    assert.ok(after.continuityRoot.equals(before.continuityRoot));
    assert.ok(after.prevBlockHash.equals(before.prevBlockHash));
    assert.equal(after.bits, before.bits);
    assert.ok(after.timestamp > before.timestamp);
    pool.close();
  });
});

describe('HTTP stats cannot stall', () => {
  it('serves /api/stats from a snapshot; RandomX runs in a worker', async () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /worker_threads/);
    assert.match(src, /hash_worker\.js/);
    assert.match(src, /STATS_REFRESH_MS/);
    assert.match(src, /scoreShareLive/);
    assert.match(src, /hashOffThread/);
    const start = src.indexOf("url.pathname === '/api/stats'");
    assert.ok(start >= 0);
    const slice = src.slice(start, start + 420);
    assert.match(slice, /statsSnap\.json/);
    assert.equal(slice.includes('publicStats()'), false);
    assert.equal(STATS_REFRESH_MS, 400);
    const worker = fs.readFileSync(new URL('../src/hash_worker.js', import.meta.url), 'utf8');
    assert.match(worker, /shearHash/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pool-stats-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const httpPort = pool.httpServer.address().port;
    const t0 = Date.now();
    const stats = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.ok(Date.now() - t0 < 500, 'stats handler must not wait on RandomX');
    assert.equal(stats.ok, true);
    assert.equal(stats.coin, 'SHE');
    pool.close();
  });
});

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
    assert.equal(admitClient({ login: id.paymentCode, client: 'ShearHash', name: 'Shear-Miner' }).ok, true);
    assert.equal(admitClient({ login: dest, client: 'ShearHash', name: 'ShearK-Miner' }).ok, true);
    assert.equal(admitClient({ login: id.address, client: 'ShearHash' }).ok, false);
    assert.equal(admitClient({ login: dest, client: 'other' }).ok, false);
    assert.equal(publicMinerLabel(id.paymentCode), publicMinerTag(id.paymentCode));
    assert.match(publicMinerLabel(id.paymentCode), /^she1[0-9a-f]{8}$/);
    assert.equal(publicMinerLabel(id.paymentCode).includes(id.paymentCode.slice(4)), false);
    const silent = payoutDest(id.paymentCode);
    const shares = splitPot([{ miner: id.paymentCode, count: 99 }], 'ssa1unused');
    assert.ok(silent);
    assert.equal(shares.some((s) => s.address === silent && s.nanos === Math.floor(BLOCK_SUBSIDY_NANOS * 0.99)), true);
    assert.equal(BLOCK_SUBSIDY_NANOS, 100_000_000_000);
    assert.equal(POOL_FEE_BPS, 100);
    const hashes = 1_000_000;
    const bonuses = hashBonusByMiner([{ miner: dest, count: hashes }]);
    assert.equal(bonuses.get(dest), hashes * HASH_BONUS_NANOS);
    assert.notEqual(bonuses.get(dest), Math.floor(hashes * HASH_BONUS_NANOS * (10000 - POOL_FEE_BPS) / 10000));
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
          params: { login: `${id.paymentCode}.de`, client: 'ShearHash', name: 'ShearK-Miner', threads: 1 },
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
    assert.match(html, /Pool explorer · last 10 transactions/);
    assert.match(html, />Id</);
    assert.match(html, />Time</);
    assert.match(html, />Status</);
    assert.doesNotMatch(html, />Kind</);
    assert.match(html, /confirmed/);
    assert.match(html, /pending/);
    assert.match(html, /function blockStatus/);
    assert.match(html, /slice\(0, 10\)/);
    assert.match(html, /s\.spendableConfirmations/);
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
    assert.match(html, />NODES ONLINE</);
    assert.equal(html.includes('Blocks this uptime'), false);
    const stats = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.equal(stats.nodesOnline, 1);
    assert.equal(stats.magic, MAGIC_TESTNET);
    assert.equal(stats.magic, 'shear-testnet-v2');
    assert.equal(stats.network, MAGIC_TESTNET);
    assert.equal(stats.personalisation, 'ShearHash-v2');
    assert.equal(stats.rxMode, 'light');
    assert.equal(stats.blockSubsidyNanos, BLOCK_SUBSIDY_NANOS);
    assert.equal(stats.blockSubsidyNanos, 100_000_000_000);
    assert.equal(typeof stats.circulatingNanos, 'number');
    assert.ok(stats.circulatingNanos >= 0);
    assert.equal(typeof stats.hashBonusEmittedNanos, 'number');
    assert.equal(stats.hashBonusNanos, HASH_BONUS_NANOS);
    assert.equal(stats.hashBonusNanos, 1);
    assert.equal(stats.hashTxLive, HASH_TX_LIVE);
    assert.equal(stats.hashTxLive, 1);
    assert.match(stats.bookLawFingerprint, /HASH_FN=ShearHash-v2/);
    assert.match(stats.bookLawFingerprint, /RX_MODE=light/);
    assert.equal(stats.targetBlockIntervalMs, TARGET_BLOCK_INTERVAL_MS);
    assert.equal(stats.targetBlockIntervalMs, 90_000);
    assert.equal(stats.destHrp, 'ssa');
    assert.equal(stats.spendableConfirmations, 6);
    assert.equal(stats.minConfirmsPolicy, 12);
    assert.equal(stats.productVersion, '0.3');
    assert.equal(stats.minerVersion, '1.1');
    if (stats.header) assert.equal(stats.header.length, 256);

    const job = pool.issueJob();
    assert.equal(gateJob(job).ok, true);
    assert.equal(job.header.length, 256);

    const scored = await new Promise((resolve, reject) => {
      const sock = net.connect(stratumPort, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: dest + '.rig', client: 'ShearHash', name: 'ShearK-Miner', version: '1.2', threads: 1 },
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
            params: { jobId: (j || job).jobId, nonce: String(hit.nonce), hash: hit.s.hash },
          }) + '\n');
        }
        if (buf.includes('"status":"OK"') && buf.includes('"hash"')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 120000);
    });
    assert.match(scored, /OK/);
    const named = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.ok((named.workers || []).some((w) => w.name === 'ShearK-Miner' && w.version === '1.2'));
    assert.match(html, /w\.name/);
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
          params: { login: dest, client: 'ShearHash', name: 'ShearK-Miner', threads, cpuThreads, cpuCores: cpuThreads },
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

function loginAndShare(port, login, extra = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(JSON.stringify({
        id: 1,
        method: 'login',
        params: { login, client: 'ShearHash', threads: 1, name: 'ShearK-Miner', ...extra },
      }) + '\n');
    });
    let buf = '';
    let nonce = 0n;
    let job = null;
    const submitNext = () => {
      if (!job) return;
      while (nonce < 400000n) {
        const s = scoreShare({ job, nonce });
        const n = nonce;
        nonce += 1n;
        if (s.ok) {
          sock.write(JSON.stringify({
            id: 2,
            method: 'submit',
            params: { jobId: job.jobId, nonce: String(n), hash: s.hash },
          }) + '\n');
          return;
        }
      }
      sock.destroy();
      reject(new Error('no_share'));
    };
    sock.on('data', (c) => {
      buf += c.toString();
      if (!job && buf.includes('\n') && buf.includes('job')) {
        const first = JSON.parse(buf.split('\n')[0]);
        job = first.job || first.result?.job || first.params;
        if (job && job.header) submitNext();
      }
      if (buf.includes('duplicate_share') || buf.includes('"busy"') || buf.includes('low_diff') || buf.includes('hash_failed')) {
        buf = '';
        submitNext();
        return;
      }
      if (buf.includes('"status":"OK"') && buf.includes('"hash"')) {
        resolve(sock);
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('share_timeout')), 20000);
  });
}

describe('public miner listing', () => {
  it('share ACK includes block so the miner can paint blockfound', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /block: !!scored\.block/);
  });

  it('pool and miner HTML paint from live API workers, not a local stash', () => {
    const dash = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const miner = fs.readFileSync(new URL('../public/miner.html', import.meta.url), 'utf8');
    assert.match(dash, /s\.workers/);
    assert.match(miner, /d\.workers/);
    assert.equal(/localStorage/.test(dash + miner), false);
  });

  it('dashboard last-10 table uses Status not Kind; TESTNET sits above the fee note', () => {
    const dash = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.match(dash, /Pool explorer · last 10 transactions/);
    assert.match(dash, />Status</);
    assert.doesNotMatch(dash, />Kind</);
    assert.match(dash, /function blockStatus/);
    assert.match(dash, /slice\(0, 10\)/);
    assert.match(dash, /s\.spendableConfirmations/);
    const fn = dash.match(/function blockStatus\(t, tip, need\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'blockStatus must ship');
    const blockStatus = new Function(`${fn[0]}; return blockStatus;`)();
    assert.equal(blockStatus({ height: 10 }, 10, 6), 'pending');
    assert.equal(blockStatus({ height: 5 }, 9, 6), 'pending');
    assert.equal(blockStatus({ height: 5 }, 10, 6), 'confirmed');
    const bannerIdx = dash.indexOf('id="testnet-banner"');
    const feeIdx = dash.indexOf('id="fee-note"');
    assert.ok(bannerIdx >= 0 && feeIdx > bannerIdx, 'TESTNET banner must sit above the fee disclaimer');
    assert.match(dash.slice(bannerIdx, feeIdx), />TESTNET</);
    assert.match(dash, /#testnet-banner/);
    const grid = dash.match(/id="stat-grid"[\s\S]*?id="miners"/);
    assert.ok(grid, 'stat-grid');
    const labels = [...grid[0].matchAll(/class="label">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(labels, [
      'Coin', 'Algo', 'Network', 'Proof', 'NODES ONLINE', 'Height',
      'Pool hashrate', 'Workers online', 'Resistance', 'Uptime', 'AVG BLOCK TIME', 'Last block',
    ]);
    assert.match(dash, /pool fee is 1% of the 1 SHE pot for development/);
    assert.match(dash, /your hashes pay in full and are not subject to pool fees/);
    assert.doesNotMatch(dash, /0\.1 SHE pot/);
    assert.equal(/feeless/i.test(dash), false);
  });

  it('miner and version boxes list each distinct label once', () => {
    assert.equal(uniquePublicLabels(['Shear-Miner', 'Shear-Miner', 'Shear-Miner']), 'Shear-Miner');
    assert.equal(uniquePublicLabels(['0.1.7', '0.1.7']), '0.1.7');
    assert.equal(uniquePublicLabels(['a', 'b', 'a']), 'a, b');
    const folded = foldPublicMinerViews([
      { miner: 'she1aaaaaaaa', name: 'Shear-Miner', version: '1.1', hashrate: 1, accepted: 1, threads: 1, sessions: 1, roundHashes: 1 },
      { miner: 'she1aaaaaaaa', name: 'Shear-Miner', version: '1.1', hashrate: 1, accepted: 1, threads: 1, sessions: 1, roundHashes: 1 },
    ]);
    assert.equal(folded[0].name, 'Shear-Miner');
    assert.equal(folded[0].version, '1.1');
  });

  it('replaces rude miner software names with flower names; worker names stay raw', () => {
    assert.equal(bloomExpletive('ShitCuntMiner'), 'LilyRoseMiner');
    assert.equal(bloomExpletive('Shear-Miner'), 'Shear-Miner');
    assert.equal(publicWorkerName('ssa1qexample.workiecunt'), 'workiecunt');
    assert.equal(publicWorkerName('ssa1qexample.ShitRig'), 'ShitRig');
    assert.equal(publicWorkerName('ssa1qexample.ok-rig'), 'ok-rig');
  });

  it('isPublicMinerRow lists a connected hasher immediately; .fee stays hidden; linger only after proven work', () => {
    assert.equal(HASH_PRESENCE_MS, 12_000);
    const now = 1_700_000_000_000;
    const live = { accepted: 0, connections: [{ sock: {} }], workerKey: 'ssa1qtest.rig' };
    assert.equal(isPublicMinerRow(live, now), true);
    assert.equal(isPublicMinerRow({ ...live, accepted: 9, lastShareAt: now - 5_000 }, now), true);
    assert.equal(isPublicMinerRow({ ...live, lastShareAt: now - 13_000 }, now), true);
    assert.equal(isPublicMinerRow({
      accepted: 0,
      connections: [],
      workerKey: 'ssa1qtest.rig',
    }, now), false);
    assert.equal(isPublicMinerRow({
      accepted: 4,
      lastShareAt: now - 20_000,
      acceptAt: [now - 20_000],
      connections: [],
      disconnectedAt: now - 5_000,
    }, now), true);
    assert.equal(isPublicMinerRow({
      accepted: 4,
      lastShareAt: now - 20_000,
      acceptAt: [now - 20_000],
      connections: [],
      disconnectedAt: now - 13_000,
    }, now), false);
    assert.equal(isPublicMinerRow({
      accepted: 4,
      lastShareAt: now - 5_000,
      connections: [],
    }, now), true);
    assert.equal(lastValidWorkAt({ lastShareAt: 10, acceptAt: [5, 12] }), 12);
    const fee = { accepted: 9, lastShareAt: now, workerKey: 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.fee' };
    assert.equal(isPublicMinerRow(fee, now), false);
    assert.equal(isPublicMinerRow({
      accepted: 0,
      connections: [{ sock: {} }],
      workerKey: 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.fee',
    }, now), false);
  });

  it('publicStats lists a connected hasher with accepted=0 and records miner hashes without minting them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-list-on-login-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(dest);
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
    const sock = await new Promise((resolve, reject) => {
      const s = net.connect(pool.stratum.address().port, '127.0.0.1', () => {
        s.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: {
            login: `${dest}.rig`,
            client: 'ShearHash',
            name: 'ShearK-Miner',
            threads: 2,
            hashes: 4200,
            hashrate: 55,
          },
        }) + '\n');
      });
      s.once('data', () => resolve(s));
      s.on('error', reject);
      setTimeout(() => reject(new Error('login_timeout')), 5000);
    });
    const stats = pool.publicStats();
    const w = (stats.workers || []).find((x) => x.miner === tag);
    assert.ok(w, JSON.stringify(stats.workers));
    assert.equal(stats.miners, 1);
    assert.equal(w.accepted, 0);
    assert.equal(w.connected, true);
    assert.equal(w.roundHashes, 0);
    assert.equal(w.hashes, 0);
    assert.equal(w.threads, 2);
    const row = [...pool.miners.values()].find((m) => String(m.workerKey || '').endsWith('.rig'));
    assert.equal(Number(row.roundHashes) || 0, 0);
    assert.equal(Number(row.clientHashes), 4200);
    sock.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const gone = pool.publicStats();
    assert.equal((gone.workers || []).some((x) => x.miner === tag), false);
    pool.close();
  });

  it('foldPublicMinerViews keeps one row per she1 tag and sums device stats', () => {
    const folded = foldPublicMinerViews([
      { miner: 'she1aaaaaaaa', worker: 'rig', name: 'a', version: '1.0', hashrate: 10, accepted: 2, stale: 1, blocks: 0, threads: 4, sessions: 1, roundHashes: 8, connected: true, lastSeen: 20, firstSeen: 1 },
      { miner: 'she1aaaaaaaa', worker: 'box', name: 'b', version: '1.0', hashrate: 5, accepted: 3, stale: 0, blocks: 1, threads: 2, sessions: 1, roundHashes: 4, connected: false, lastSeen: 30, firstSeen: 2 },
      { miner: 'she1bbbbbbbb', worker: 'solo', hashrate: 1, accepted: 1, stale: 0, blocks: 0, threads: 1, sessions: 1, roundHashes: 1, connected: true, lastSeen: 9, firstSeen: 9 },
    ]);
    assert.equal(folded.length, 2);
    const a = folded.find((w) => w.miner === 'she1aaaaaaaa');
    assert.equal(a.hashrate, 15);
    assert.equal(a.accepted, 5);
    assert.equal(a.threads, 6);
    assert.equal(a.sessions, 2);
    assert.equal(a.blocks, 1);
    assert.equal(a.roundHashes, 12);
    assert.equal(a.connected, true);
    assert.equal(a.lastSeen, 30);
    assert.equal(a.firstSeen, 1);
  });

  it('dashboard lists one she1 row for two device logins; 12s after full disconnect ghosts drop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-miner-ui-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(dest);
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
    const a = await loginAndShare(stratumPort, `${dest}.alpha`);
    const b = await loginAndShare(stratumPort, `${dest}.beta`);
    const stats = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    const rows = (stats.workers || []).filter((w) => w.miner === tag);
    assert.equal(rows.length, 1, JSON.stringify(stats.workers));
    assert.equal(new Set((stats.workers || []).map((w) => w.miner)).size, (stats.workers || []).length);
    assert.equal(rows[0].accepted, 2);
    assert.ok(rows[0].threads >= 2);
    const page = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${tag}`).then((r) => r.json());
    assert.equal(page.ok, true);
    assert.ok((page.workers || []).length >= 1);
    assert.ok((page.workers || []).every((w) => Number(w.accepted) > 0));
    assert.equal(
      (page.workers || []).some((w) => String(w.worker || '').toLowerCase() === 'fee'),
      false,
    );

    const aged = Date.now() - HASH_PRESENCE_MS - 1_000;
    for (const m of pool.miners.values()) {
      m.lastShareAt = aged;
      m.acceptAt = [aged];
    }
    const stillLive = pool.publicStats();
    assert.equal((stillLive.workers || []).some((w) => w.miner === tag), true);
    a.destroy();
    b.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const grace = pool.publicStats();
    assert.equal((grace.workers || []).some((w) => w.miner === tag), true, '12s grace after full disconnect');
    for (const m of pool.miners.values()) {
      m.lastShareAt = aged;
      m.acceptAt = [aged];
      m.connections = [];
      m.disconnectedAt = aged;
    }
    const ghost = pool.publicStats();
    assert.equal((ghost.workers || []).some((w) => w.miner === tag), false);
    const detail = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${tag}`);
    assert.equal(detail.status, 404);
    pool.close();
  });

  it('hashes this round is own count after a valid share; zero with no share', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-round-h-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(dest);
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
    const sock = await loginAndShare(pool.stratum.address().port, `${dest}.rig`, {
      hashes: 16_590_151_266_784,
      hashrate: 1_062_582_824,
    });
    const row = [...pool.miners.values()].find((m) => !String(m.workerKey || '').endsWith('.fee'));
    assert.ok(row);
    const proven = Number(row.roundHashes) || 0;
    assert.ok(proven > 0);
    assert.ok(proven < 1_000_000);
    row.clientHashes = 16_590_151_266_784;
    row.clientHashesRound0 = 16_590_151_266_784;
    row.clientHs = 1_062_582_824;
    let stats = pool.publicStats();
    let w = (stats.workers || []).find((x) => x.miner === tag);
    assert.ok(w);
    assert.equal(w.hashes, proven);
    assert.equal(w.roundHashes, proven);
    assert.equal(w.provenHashes, proven);
    assert.notEqual(w.roundHashes, row.clientHashes);
    row.clientHashes = 16_590_151_266_784 + 900;
    stats = pool.publicStats();
    w = (stats.workers || []).find((x) => x.miner === tag);
    assert.equal(w.hashes, 900);
    assert.equal(w.roundHashes, 900);
    assert.equal(w.provenHashes, proven);
    row.roundHashes = 0;
    const reset = pool.publicStats();
    const w2 = (reset.workers || []).find((x) => x.miner === tag);
    if (w2) {
      assert.equal(w2.provenHashes, 0);
      assert.equal(w2.roundHashes, 0);
      assert.equal(w2.hashes, 0);
    }
    sock.destroy();
    pool.close();
  });

  it('legacy dual-login fee login with hasher lifetime hashes never appears as a public GH/s row', async () => {
    assert.equal(isCminerFeeLogin(`${CMINER_FEE_SHE}.fee`), true);
    assert.equal(isCminerFeeLogin(CMINER_FEE_SHE), false);
    assert.equal(isCminerFeeLogin(`${CMINER_FEE_SHE}.raskul`), false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fee-hs-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const hasherTag = publicMinerTag(dest);
    const feeTag = publicMinerTag(CMINER_FEE_SHE);
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
    const main = await loginAndShare(stratumPort, `${dest}.rig`, { hashes: 1000 });
    const fee = await loginAndShare(stratumPort, `${CMINER_FEE_SHE}.fee`, {
      hashes: 16_590_151_266_784,
      hashrate: 1_062_582_824,
      threads: 1,
    });
    const stats = pool.publicStats();
    const tags = (stats.workers || []).map((w) => w.miner);
    assert.equal(tags.includes(feeTag), false, JSON.stringify(stats.workers));
    const hasher = (stats.workers || []).find((w) => w.miner === hasherTag);
    assert.ok(hasher);
    assert.equal(hasher.roundHashes, hasher.provenHashes);
    assert.ok(hasher.provenHashes > 0);
    assert.ok(hasher.provenHashes < 1_000_000);
    assert.ok(hasher.hashrate < 1_000_000);
    const feePage = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${feeTag}`);
    assert.equal(feePage.status, 404);
    main.destroy();
    fee.destroy();
    pool.close();
  });
});
