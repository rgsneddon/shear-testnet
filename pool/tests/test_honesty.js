import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  admitClient,
  createPool,
  foldConnectionInventory,
  provenHashrate,
  reportedHashrate,
  applyMinerSelfRate,
  sortMinersByHashrate,
  refreshMinerRow,
  workerKey,
} from '../src/pool.js';
import { expectedOneThreadHs } from '../src/share_vardiff.js';

function stampProvenThreads(miner, threadCount, shareBits, now = Date.now()) {
  const one = expectedOneThreadHs(shareBits);
  const spanMs = 1000;
  const work = threadCount * one * (spanMs / 1000);
  miner.shareBits = shareBits;
  miner.accepted = Math.max(8, Number(miner.accepted) || 0);
  miner.acceptAt = [now - spanMs, now - 600, now - 200, now - 50];
  miner.acceptWork = [work, 0, 0, 0];
  for (const c of miner.connections || []) c.shareBits = shareBits;
  return { one, now };
}

describe('folded-row inventory', () => {
  it('reports each miner from its own counter, never another miner', () => {
    const now = Date.now();
    const sock = {};
    const one = {
      threads: 1,
      connections: [{ sock }],
      acceptAt: [now - 1000],
      acceptWork: [900_000 * 72],
      clientHs: 900_000,
    };
    const ten = {
      threads: 10,
      connections: [{ sock }],
      acceptAt: [now - 1000],
      acceptWork: [256 * 72],
    };
    assert.equal(Math.round(provenHashrate(ten, now)), 256);
    assert.equal(Math.round(reportedHashrate(ten, now)), 256);
    applyMinerSelfRate(ten, { hashrate: 225_000_000, hashes: 1_000_000 }, now);
    assert.equal(ten.clientHs, 225_000_000);
    delete ten.smoothHs;
    delete ten.smoothHsAt;
    assert.equal(reportedHashrate(ten, now), 225_000_000);
    delete one.smoothHs;
    delete one.smoothHsAt;
    assert.equal(reportedHashrate(one, now), 900_000);
    const other = {
      threads: 10,
      connections: [{ sock }],
      acceptAt: [now],
      acceptWork: [256 * 72],
    };
    applyMinerSelfRate(other, { hashes: 1000 }, now);
    applyMinerSelfRate(other, { hashes: 1000 + 225_000_000 }, now + 1000);
    assert.equal(other.clientHs, undefined);
    applyMinerSelfRate(other, { hashes: 1000 + 225_000_000 * 10 }, now + 10_000);
    assert.equal(other.clientHs, 225_000_000);
    delete one.smoothHs;
    delete one.smoothHsAt;
    assert.equal(reportedHashrate(one, now), 900_000);
  });

  it('EMA damps a hashrate spike and sorts biggest first', () => {
    const t0 = Date.now();
    const low = { clientHs: 1_000_000 };
    const high = { clientHs: 10_000_000 };
    reportedHashrate(low, t0);
    reportedHashrate(high, t0);
    low.clientHs = 50_000_000;
    const damped = reportedHashrate(low, t0 + 1000);
    assert.ok(damped > 1_000_000, `got ${damped}`);
    assert.ok(damped < 20_000_000, `got ${damped}`);
    const ranked = sortMinersByHashrate([low, high], t0 + 1000);
    assert.equal(ranked[0], high);
  });

  it('does not ship thread honesty checks', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const minerPage = fs.readFileSync(new URL('../public/miner.html', import.meta.url), 'utf8');
    const vd = fs.readFileSync(new URL('../src/share_vardiff.js', import.meta.url), 'utf8');
    assert.equal(/thread_honesty|assessThreadHonesty|threadHonesty|applyFoldedHonesty/.test(src), false);
    assert.equal(/Honesty|honesty|inflate/.test(minerPage), false);
    assert.equal(/gnfpFeeRoute|HASHRATES_BASELINE/.test(src), false);
    assert.equal(/gnfpFeeRoute|HASHRATES_BASELINE/.test(vd), false);
  });

  it('32/32 + 230/256 still sums and is not capped at 256', () => {
    const shareBits = 12;
    const miner = {
      connections: [
        { threads: 32, cpuThreads: 32, cpuCores: 32, shareBits },
        { threads: 230, cpuThreads: 256, cpuCores: 256, shareBits },
      ],
    };
    const { now } = stampProvenThreads(miner, 32, shareBits);
    const folded = foldConnectionInventory(miner.connections);
    assert.equal(folded.threads, 262);
    assert.equal(folded.cpuThreads, 288);
    assert.ok(provenHashrate(miner, now) > 0);
    refreshMinerRow(miner, now);
    assert.equal(miner.threadHonesty, undefined);
    assert.equal(miner.threads, 262);
    assert.ok(miner.threads > 256);
  });

  it('200+200 with matching proven work is not capped at 256', () => {
    const shareBits = 12;
    const miner = {
      connections: [
        { threads: 200, cpuThreads: 256, cpuCores: 128, shareBits },
        { threads: 200, cpuThreads: 256, cpuCores: 128, shareBits },
      ],
    };
    const { now } = stampProvenThreads(miner, 400, shareBits);
    refreshMinerRow(miner, now);
    assert.equal(miner.threads, 400);
    assert.ok(miner.threads > 256);
    assert.equal(miner.threadHonesty, undefined);
  });

  it('keys the book by dest.worker, not dest-only', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    assert.equal(workerKey(`${dest}.alpha`), `${dest}.alpha`);
    assert.notEqual(workerKey(`${dest}.alpha`), workerKey(`${dest}.beta`));
    assert.equal(admitClient({ login: `${dest}.alpha`, client: 'ShearHash' }).workerKey, `${dest}.alpha`);
    assert.equal(admitClient({ login: `${dest}.alpha`, client: 'ShearHash' }).login, dest);
  });

  it('two sockets on one worker sum; dest.other is a separate row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hon-'));
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
    const port = pool.stratum.address().port;
    const login = (user, threads, cpuThreads) => new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: user, client: 'ShearHash', threads, cpuThreads, cpuCores: cpuThreads },
        }) + '\n');
      });
      sock.once('data', () => resolve(sock));
      sock.on('error', reject);
      setTimeout(() => reject(new Error('login_timeout')), 5000);
    });
    const a = await login(`${dest}.rig`, 200, 256);
    const b = await login(`${dest}.rig`, 200, 256);
    const other = await login(`${dest}.other`, 4, 8);
    const rig = pool.miners.get(`${dest}.rig`);
    const oth = pool.miners.get(`${dest}.other`);
    assert.ok(rig);
    assert.ok(oth);
    assert.notEqual(rig, oth);
    assert.equal(rig.threads, 400);
    assert.ok(rig.threads > 256);
    assert.equal(rig.sessions, 2);
    assert.equal(oth.threads, 4);
    assert.equal(rig.threadHonesty, undefined);
    const httpPort = pool.httpServer.address().port;
    const stats = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.equal(JSON.stringify(stats).includes('honesty'), false);
    assert.equal(JSON.stringify(stats).includes('inflate'), false);
    a.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rig.threads, 200);
    assert.equal(rig.sessions, 1);
    b.destroy();
    other.destroy();
    pool.close();
  });

  it('createPool 32/32 + 230/256 still folds without an honesty verdict', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ep01-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 12,
      bits: 16,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const port = pool.stratum.address().port;
    const login = (threads, cpuThreads) => new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: {
            login: `${dest}.EP01`,
            client: 'ShearHash',
            threads,
            cpuThreads,
            cpuCores: cpuThreads,
          },
        }) + '\n');
      });
      sock.once('data', () => resolve(sock));
      sock.on('error', reject);
      setTimeout(() => reject(new Error('login_timeout')), 5000);
    });
    const a = await login(32, 32);
    const b = await login(230, 256);
    const row = pool.miners.get(`${dest}.EP01`);
    assert.equal(row.threads, 262);
    assert.equal(row.cpuThreads, 288);
    const now = Date.now();
    stampProvenThreads(row, 32, 12, now);
    assert.ok(provenHashrate(row, now) > 0);
    refreshMinerRow(row, now);
    assert.equal(row.threadHonesty, undefined);
    assert.equal(row.threads, 262);
    a.destroy();
    b.destroy();
    pool.close();
  });
});
