import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { requiredJobFields } from '../../crypto/header.js';
import { payoutDest } from '../../crypto/address.js';
import { newIdentity, encodeHrp } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool, gateJob, scoreShare, admitClient, foldConnectionInventory, publicMinerLabel, publicMinerTag, publicWorkerName, splitPot, avgBlockIntervalMs, AVG_BLOCK_WINDOW } from '../src/pool.js';
import { publicJob, buildTemplate } from '../../node/src/chain.js';
import { GENESIS_PREV } from '../../node/src/chain.js';
import { encodeHeader } from '../../crypto/header.js';

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
  it('admits shp1 dest and she1 silent ID, refuses rest-frame shear1 and wrong client', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    assert.equal(admitClient({ login: dest, client: 'ShearHash' }).ok, true);
    assert.equal(admitClient({ login: id.paymentCode, client: 'ShearHash' }).ok, true);
    assert.equal(admitClient({ login: id.address, client: 'ShearHash' }).ok, false);
    assert.equal(admitClient({ login: dest, client: 'other' }).ok, false);
    assert.equal(publicWorkerName(`${id.paymentCode}.monsoon`), 'monsoon');
    assert.match(publicMinerLabel(id.paymentCode), /^she1[0-9a-f]{8}$/);
    assert.equal(publicMinerLabel(`${id.paymentCode}.cedar`), publicMinerLabel(id.paymentCode));
    assert.equal(publicMinerLabel(id.paymentCode).includes(id.paymentCode.slice(4, 12)), false);
    const silent = payoutDest(id.paymentCode);
    const shares = splitPot([{ miner: id.paymentCode, count: 99 }], 'shp1unused');
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
    assert.equal(String(job.job.header).length, 240);
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
    assert.match(html, /shp1/);
    assert.match(html, /To \(she1\)/);
    assert.match(html, /she1 is the silent ID and the login/);
    assert.equal(/Dest \(shp1\)/.test(html), false);
    assert.equal(/not a login/i.test(html), false);
    assert.equal(/shp1 dest required/i.test(html), false);
    assert.match(html, /font:13px/);
    assert.match(html, /YOUR_SHE1/);
    assert.equal(/--user shear1/.test(html), false);
    assert.equal(html.includes('YOUR_SHEAR1'), false);
    assert.match(html, /function fmtUptime/);
    assert.match(html, /function fmtSinceBlock/);
    assert.match(html, /function fmtAvgBlock/);
    assert.match(html, />AVG BLOCK TIME</);
    assert.match(html, /CPU threads[\s\S]*Height[\s\S]*Pool hashrate[\s\S]*Blocks this uptime/);
    assert.match(html, /Network[\s\S]*AVG BLOCK TIME[\s\S]*Last block/);
    assert.equal(/id="rejected"/.test(html), false);
    assert.equal(/id="stat-grid"[\s\S]*<div class="label">Stale shares<\/div>/.test(html), false);
    assert.match(html, /<th>Stale shares<\/th>/);
    assert.equal(/<th>Worker<\/th>/.test(html), false);
    assert.match(html, /<th>Version<\/th>/);
    assert.match(html, /<th>Hashrate<\/th>/);
    assert.match(html, /<th>Hashes this round<\/th>/);
    assert.equal(/<th>Hashes<\/th>/.test(html), false);
    const live = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.equal(typeof live.uptimeMs, 'number');
    assert.ok(live.uptimeMs >= 0);
    assert.equal(typeof live.lastFoundAt, 'number');
    assert.equal(live.avgBlockTimeMs, null);
    assert.equal(live.avgBlockWindow, 1000);

    const job = pool.issueJob();
    assert.equal(gateJob(job).ok, true);
    assert.equal(job.header.length, 240);

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
    const after = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.ok(Array.isArray(after.workers));
    assert.equal(typeof after.workers[0].hashrate, 'number');
    assert.equal(typeof after.workers[0].blocks, 'number');
    assert.equal('hashes' in after.workers[0], false);
    assert.match(after.workers[0].miner, /^she1[0-9a-f]{8}$/);
    const tag = publicMinerTag(dest);
    assert.equal(after.workers[0].miner, tag);
    const page = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${tag}`).then((r) => r.json());
    assert.equal(page.ok, true);
    assert.equal(page.tag, tag);
    assert.ok(Array.isArray(page.workers));
    const htmlMiner = await fetch(`http://127.0.0.1:${httpPort}/miner/${tag}`).then((r) => r.text());
    assert.match(htmlMiner, /Miner stats/);
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

describe('avg block time', () => {
  function headerAt(ms) {
    return encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: BigInt(ms),
      bits: 8,
      nonce: 0n,
    });
  }

  it('is the mean interval of the last 1000 chain blocks', () => {
    assert.equal(AVG_BLOCK_WINDOW, 1000);
    assert.equal(avgBlockIntervalMs([]), null);
    assert.equal(avgBlockIntervalMs([{ header: headerAt(1000) }]), null);
    const three = [1000, 2000, 4000].map((t) => ({ header: headerAt(t) }));
    assert.equal(avgBlockIntervalMs(three), 1500);

    const times = [];
    let t = 1_000_000;
    times.push(t);
    for (let i = 0; i < 4; i += 1) {
      t += 1_000;
      times.push(t);
    }
    for (let i = 0; i < 1000; i += 1) {
      t += 90_000;
      times.push(t);
    }
    const chain = times.map((ms) => ({ header: headerAt(ms) }));
    assert.equal(chain.length, 1005);
    assert.equal(avgBlockIntervalMs(chain), 90_000);
    assert.notEqual(avgBlockIntervalMs(chain), (times[times.length - 1] - times[0]) / (times.length - 1));
  });

  it('publicStats ships avgBlockTimeMs from the chain window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-avg-'));
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
    const stamps = [1_000_000, 1_090_000, 1_180_000];
    for (const ms of stamps) pool.store.blocks.push({ header: headerAt(ms) });
    const snap = pool.publicStats();
    assert.equal(snap.avgBlockTimeMs, 90_000);
    assert.equal(snap.avgBlockWindow, 1000);
    pool.close();
    fs.rmSync(dir, { recursive: true, force: true });
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
