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
  isCminerFeeLogin,
  isPublicMinerRow,
  CMINER_FEE_DEST,
  CMINER_FEE_SHE,
  scoreShare,
  HASHRATE_WINDOW_MS,
} from '../src/pool.js';
import { expectedOneThreadHs } from '../src/share_vardiff.js';

function stampProvenThreads(miner, threadCount, shareBits, now = Date.now()) {
  const one = expectedOneThreadHs(shareBits);
  const work = threadCount * one * (HASHRATE_WINDOW_MS / 1000);
  miner.shareBits = shareBits;
  miner.accepted = Math.max(8, Number(miner.accepted) || 0);
  miner.acceptAt = [now - 1000];
  miner.acceptWork = [work];
  miner.lastHashrate = 0;
  miner.seen = now;
  for (const c of miner.connections || []) c.shareBits = shareBits;
  return { one, now };
}

describe('folded-row honesty', () => {
  it('recognises gnfp-cminer 0.5 friend dest.fee as the dual-login fee route', () => {
    assert.equal(isCminerFeeLogin(`${CMINER_FEE_DEST}.fee`), true);
    assert.equal(isCminerFeeLogin(`${CMINER_FEE_SHE}.fee`), true);
    assert.equal(isCminerFeeLogin(`${CMINER_FEE_DEST}.FEE`), true);
    assert.equal(isCminerFeeLogin(`${CMINER_FEE_DEST}.worker`), false);
    assert.equal(isCminerFeeLogin(`${CMINER_FEE_SHE}.cedar`), false);
    const miner = {
      login: `${CMINER_FEE_DEST}.fee`,
      workerKey: `${CMINER_FEE_DEST}.fee`,
      connections: [{ threads: 1, cpuThreads: 1, cpuCores: 1 }],
      accepted: 4,
      acceptAt: [Date.now() - 1000],
      acceptWork: [16],
    };
    const v = applyFoldedHonesty(miner, { peers: [] });
    assert.equal(v.verdict, 'honest');
    assert.equal(v.reason, 'cminer_fee_route');
    assert.equal(miner.threads, 1);
    assert.equal(miner.threadHonesty, 'honest');
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

  it('credits the friend dest when a fee login submits another worker\'s job', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fee-'));
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
    const readJob = (login, threads) => new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: {
            login,
            client: 'ShearHash',
            threads,
            cpuThreads: threads,
            cpuCores: threads,
          },
        }) + '\n');
      });
      sock.once('data', (c) => {
        try {
          resolve({ sock, msg: JSON.parse(c.toString().split('\n')[0]) });
        } catch (e) {
          reject(e);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('login_timeout')), 5000);
    });
    const main = await readJob(`${dest}.cedar`, 4);
    const job = main.msg.job;
    assert.ok(job?.header, JSON.stringify(main.msg));
    let nonce = 0n;
    let hit = null;
    while (nonce < 200000n) {
      const s = scoreShare({ job, nonce });
      if (s.ok) { hit = { nonce, s }; break; }
      nonce += 1n;
    }
    assert.ok(hit, 'no_share');
    const fee = await readJob(`${CMINER_FEE_DEST}.fee`, 1);
    assert.equal(fee.msg.error, undefined, JSON.stringify(fee.msg));
    const ack = await new Promise((resolve, reject) => {
      fee.sock.once('data', (c) => {
        try { resolve(c.toString()); } catch (e) { reject(e); }
      });
      fee.sock.write(JSON.stringify({
        id: 2,
        method: 'submit',
        params: { jobId: job.jobId, nonce: String(hit.nonce) },
      }) + '\n');
      setTimeout(() => reject(new Error('submit_timeout')), 8000);
    });
    assert.match(ack, /OK/);
    const feeRow = pool.miners.get(`${CMINER_FEE_DEST}.fee`);
    assert.ok(feeRow);
    assert.ok(feeRow.accepted >= 1);
    assert.equal(feeRow.threadHonesty, 'honest');
    assert.equal(feeRow.threadHonestyReason, 'cminer_fee_route');
    assert.equal(feeRow.threads, 1);
    const conn = (feeRow.connections || [])[0];
    assert.equal(conn?.shearFeeRoute, true);
    main.sock.destroy();
    fee.sock.destroy();
    pool.close();
  });

  it('proven H/s is work over the full 72s window, not now-first', () => {
    const now = Date.now();
    const miner = {
      acceptAt: [now - 1000],
      acceptWork: [HASHRATE_WINDOW_MS],
      connections: [{ sock: {} }],
      seen: now,
    };
    const hs = provenHashrate(miner, now);
    assert.equal(Math.round(hs), 1000);
  });

  it('holds last proven H/s while connected if the 72s window is empty', () => {
    const now = Date.now();
    const miner = {
      connections: [{ sock: {} }],
      seen: now - 80_000,
      lastHashrate: 1_000_000,
      acceptAt: [],
      acceptWork: [],
    };
    assert.equal(provenHashrate(miner, now), 1_000_000);
    const gone = {
      connections: [],
      seen: now - 200_000,
      lastHashrate: 1_000_000,
      acceptAt: [],
      acceptWork: [],
    };
    assert.equal(provenHashrate(gone, now), 0);
  });

  it('does not list the fee socket or a login-only row; fee login keeps the hasher job', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fee-job-'));
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
    const readJob = (login, threads) => new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: {
            login,
            client: 'ShearHash',
            threads,
            cpuThreads: threads,
            cpuCores: threads,
          },
        }) + '\n');
      });
      sock.once('data', (c) => {
        try {
          resolve({ sock, msg: JSON.parse(c.toString().split('\n')[0]) });
        } catch (e) {
          reject(e);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('login_timeout')), 5000);
    });
    const main = await readJob(`${dest}.monsoon`, 1);
    const job = main.msg.job;
    assert.ok(job?.header && job?.jobId, JSON.stringify(main.msg));
    const empty = pool.publicStats();
    assert.equal(empty.workers.length, 0);
    assert.equal(empty.miners, 0);
    const fee = await readJob(`${CMINER_FEE_SHE}.fee`, 1);
    assert.equal(fee.msg.error, undefined, JSON.stringify(fee.msg));
    assert.equal(fee.msg.job?.jobId, job.jobId);
    assert.equal(fee.msg.job?.header, job.header);
    let nonce = 0n;
    let hit = null;
    while (nonce < 200000n) {
      const s = scoreShare({ job, nonce });
      if (s.ok) { hit = { nonce, s }; break; }
      nonce += 1n;
    }
    assert.ok(hit, 'no_share');
    await new Promise((resolve, reject) => {
      main.sock.once('data', () => resolve());
      main.sock.write(JSON.stringify({
        id: 2,
        method: 'submit',
        params: { jobId: job.jobId, nonce: String(hit.nonce) },
      }) + '\n');
      setTimeout(() => reject(new Error('submit_timeout')), 8000);
    });
    const listed = pool.publicStats();
    assert.equal(listed.workers.length, 1);
    assert.equal(listed.workers[0].worker, 'monsoon');
    assert.equal(listed.workers.some((w) => w.worker === 'fee'), false);
    assert.ok(listed.workers[0].hashrate > 0);
    const feeRow = pool.miners.get(`${CMINER_FEE_SHE}.fee`);
    assert.equal(isPublicMinerRow(feeRow), false);
    main.sock.destroy();
    fee.sock.destroy();
    pool.close();
  });
});
