import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  THREAD_HONEST,
  THREAD_INFLATE,
  THREAD_UNDERREPORT,
  assessThreadHonesty,
  inferThreadCount,
} from '../src/thread_honesty.js';
import {
  admitClient,
  applyFoldedHonesty,
  createPool,
  foldConnectionInventory,
  provenHashrate,
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

describe('folded-row honesty', () => {
  it('does not credit a miner-fee dual-login route', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const hon = fs.readFileSync(new URL('../src/thread_honesty.js', import.meta.url), 'utf8');
    const vd = fs.readFileSync(new URL('../src/share_vardiff.js', import.meta.url), 'utf8');
    for (const t of [src, hon, vd]) {
      assert.equal(/isCminerFeeLogin|CMINER_FEE|gnfpFeeRoute|HASHRATES_BASELINE/.test(t), false);
    }
  });

  it('flags inflate, under-report, and matching device', () => {
    assert.equal(inferThreadCount({ hashrate: 32, oneThreadHs: 4 }), 8);
    const honest = assessThreadHonesty({
      claimed: 8,
      cpuThreads: 12,
      cpuCores: 6,
      hashrate: 32,
      accepts: 8,
      oneThreadHs: 4,
    });
    assert.equal(honest.verdict, THREAD_HONEST);
    assert.equal(honest.honest, true);
    const inflate = assessThreadHonesty({
      claimed: 240,
      cpuCores: 8,
      cpuThreads: 8,
      hashrate: 4,
      accepts: 8,
      oneThreadHs: 4,
    });
    assert.equal(inflate.verdict, THREAD_INFLATE);
    assert.equal(inflate.honest, false);
    const hide = assessThreadHonesty({ claimed: 0, hashrate: 8, accepts: 8, oneThreadHs: 4 });
    assert.equal(hide.verdict, THREAD_UNDERREPORT);
  });

  it('32/32 + 230/256 with the small miner proven H/s flags inflate on the folded row', () => {
    const shareBits = 12;
    const miner = {
      connections: [
        { threads: 32, cpuThreads: 32, cpuCores: 32, shareBits },
        { threads: 230, cpuThreads: 256, cpuCores: 256, shareBits },
      ],
    };
    const lastWrite = miner.connections[1];
    const { one, now } = stampProvenThreads(miner, 32, shareBits);
    const lastLooksHonest = assessThreadHonesty({
      claimed: lastWrite.threads,
      cpuThreads: lastWrite.cpuThreads,
      cpuCores: lastWrite.cpuCores,
      accepts: 8,
    });
    assert.equal(lastLooksHonest.honest, true);
    assert.notEqual(lastLooksHonest.verdict, THREAD_INFLATE);
    const folded = foldConnectionInventory(miner.connections);
    assert.equal(folded.threads, 262);
    assert.equal(folded.cpuThreads, 288);
    const hs = provenHashrate(miner, now);
    assert.ok(hs > 0);
    assert.equal(Math.round(hs / one), 32);
    const verdict = applyFoldedHonesty(miner, { peers: [], now });
    assert.equal(verdict.verdict, THREAD_INFLATE);
    assert.equal(verdict.honest, false);
    assert.equal(verdict.reason, 'claimed_threads_above_work');
    assert.equal(miner.threadHonesty, THREAD_INFLATE);
    assert.equal(miner.threads, 262);
  });

  it('200+200 with matching proven work stays honest and is not capped at 256', () => {
    const shareBits = 12;
    const miner = {
      connections: [
        { threads: 200, cpuThreads: 256, cpuCores: 128, shareBits },
        { threads: 200, cpuThreads: 256, cpuCores: 128, shareBits },
      ],
    };
    const { now } = stampProvenThreads(miner, 400, shareBits);
    const verdict = applyFoldedHonesty(miner, { peers: [], now });
    assert.equal(miner.threads, 400);
    assert.ok(miner.threads > 256);
    assert.equal(verdict.honest, true);
    assert.equal(verdict.verdict, THREAD_HONEST);
    assert.equal(verdict.reason, 'matches_accepted_work');
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
    assert.equal(rig.threadHonesty === THREAD_INFLATE, false);
    a.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rig.threads, 200);
    assert.equal(rig.sessions, 1);
    b.destroy();
    other.destroy();
    pool.close();
  });

  it('createPool 32/32 + 230/256 with small-miner proven H/s flags inflate', async () => {
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
    const { one } = stampProvenThreads(row, 32, 12, now);
    const hs = provenHashrate(row, now);
    assert.equal(Math.round(hs / one), 32);
    const verdict = applyFoldedHonesty(row, { peers: [...pool.miners.values()], now });
    assert.equal(verdict.verdict, THREAD_INFLATE);
    assert.equal(verdict.reason, 'claimed_threads_above_work');
    a.destroy();
    b.destroy();
    pool.close();
  });
});
