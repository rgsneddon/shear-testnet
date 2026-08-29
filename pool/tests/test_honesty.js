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
  rememberShare,
  shareFingerprint,
  CMINER_FEE_SHE,
  HASHRATE_WINDOW_MS,
  HASHRATE_EMA_TAU_S,
} from '../src/pool.js';
import { extraMintAllowed, RESERVE_PROGRAM, JOIN_PROGRAM } from '../../crypto/asert.js';
import { expectedOneThreadHs, hashesProvenByShare } from '../src/share_vardiff.js';

const RATE_WIN_S = HASHRATE_WINDOW_MS / 1000;

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

describe('duplicate shares cannot inflate round work', () => {
  it('remembers a job+nonce+hash once; a copy is duplicate_share', () => {
    const seen = new Set();
    const job = { jobId: 'j1' };
    const fp = shareFingerprint(job, '42', 'abc');
    assert.equal(rememberShare(seen, fp).ok, true);
    assert.equal(rememberShare(seen, fp).ok, false);
    assert.equal(rememberShare(seen, fp).reason, 'duplicate_share');
    assert.equal(rememberShare(seen, shareFingerprint(job, '43', 'def')).ok, true);
    assert.equal(reportedHashrate({
      acceptAt: [Date.now()],
      acceptWork: [100],
      clientHs: 9e12,
      clientHashes: 9e12,
    }), provenHashrate({
      acceptAt: [Date.now()],
      acceptWork: [100],
      clientHs: 9e12,
    }));
  });

  it('extra leading zeros / padded client hashes do not inflate credited work', () => {
    const shareBits = 8;
    const job = { shareBits, jobId: 'j-pad' };
    const credited = hashesProvenByShare(shareBits);
    const luckyZeros = hashesProvenByShare(40);
    assert.equal(credited, 256);
    assert.ok(luckyZeros > credited);
    const miner = {
      roundHashes: 0,
      hashes: 0,
      clientHashes: 16_590_151_266_784,
      clientHs: 1_062_582_824,
    };
    miner.roundHashes += hashesProvenByShare(Number(job.shareBits) || 0);
    miner.hashes += hashesProvenByShare(Number(job.shareBits) || 0);
    assert.equal(miner.roundHashes, 256);
    assert.equal(miner.hashes, 256);
    assert.ok(miner.roundHashes < miner.clientHashes);
    assert.equal(
      reportedHashrate({
        acceptAt: [Date.now()],
        acceptWork: [credited],
        clientHashes: miner.clientHashes,
        clientHs: miner.clientHs,
      }).toFixed(0),
      provenHashrate({
        acceptAt: [Date.now()],
        acceptWork: [credited],
      }).toFixed(0),
    );
  });

  it('third-party vortices cannot extra-mint; Reserve APR and Join genesis only', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: 'join-genesis' }), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: 'claim' }), false);
    assert.equal(extraMintAllowed('third-party-vortice'), false);
    assert.equal(extraMintAllowed('stake-pool-a', { kind: 'withdraw' }), false);
  });
});

describe('folded-row inventory', () => {
  it('reports each miner from its own counter, never another miner', () => {
    const now = Date.now();
    const sock = {};
    const one = {
      threads: 1,
      connections: [{ sock }],
      acceptAt: [now - 1000],
      acceptWork: [900_000 * RATE_WIN_S],
      clientHs: 900_000,
    };
    const ten = {
      threads: 10,
      connections: [{ sock }],
      acceptAt: [now - 1000],
      acceptWork: [256 * RATE_WIN_S],
    };
    assert.equal(Math.round(provenHashrate(ten, now)), 256);
    assert.equal(Math.round(reportedHashrate(ten, now)), 256);
    applyMinerSelfRate(ten, { hashrate: 2_000_000_000, hashes: 1_000_000 }, now);
    assert.equal(ten.clientHs, undefined);
    applyMinerSelfRate(ten, { hashrate: 2_000_000_000, hashes: 1_000_000 + 225_000_000 }, now + 1000);
    assert.equal(ten.clientHs, undefined);
    applyMinerSelfRate(ten, { hashrate: 2_000_000_000, hashes: 1_000_000 + 225_000_000 * 10 }, now + 10_000);
    assert.equal(ten.clientHs, 225_000_000);
    assert.equal(Math.round(reportedHashrate(ten, now + 10_000)), 256);
    assert.equal(reportedHashrate(one, now), 900_000);
    const other = {
      threads: 10,
      connections: [{ sock }],
      acceptAt: [now],
      acceptWork: [256 * RATE_WIN_S],
    };
    applyMinerSelfRate(other, { hashes: 1000 }, now);
    applyMinerSelfRate(other, { hashes: 1000 + 225_000_000 }, now + 1000);
    assert.equal(other.clientHs, undefined);
    applyMinerSelfRate(other, { hashes: 1000 + 225_000_000 * 10 }, now + 10_000);
    assert.equal(other.clientHs, 225_000_000);
    assert.equal(Math.round(reportedHashrate(other, now)), 256);
    assert.equal(reportedHashrate(one, now), 900_000);
  });

  it('reported hashrate eases over HASHRATE_EMA_TAU_S instead of jumping each 1s poll', () => {
    assert.equal(HASHRATE_EMA_TAU_S, 30);
    const now = 1_700_000_000_000;
    const m = {
      connections: [{ sock: {} }],
      acceptAt: [now],
      acceptWork: [3_000_000 * RATE_WIN_S],
    };
    const a = reportedHashrate(m, now);
    assert.equal(Math.round(a), 3_000_000);
    m.acceptAt = [now + 1000];
    m.acceptWork = [1_000_000 * RATE_WIN_S];
    const b = reportedHashrate(m, now + 1000);
    assert.ok(b < 2_980_000, `eased down from 3MH/s, got ${b}`);
    assert.ok(b > 2_800_000, `1s poll must not drop to the new instant, got ${b}`);
    const c = reportedHashrate(m, now + 30_000);
    assert.ok(c < 2_200_000, `after ~tau should be near 1MH/s, got ${c}`);
    assert.ok(c > 1_000_000);
  });

  it('connect hashrate ramps up from own hashes, never down from a session-average spike', () => {
    const t0 = Date.now();
    const miner = {};
    applyMinerSelfRate(miner, { hashrate: 2_000_000_000, hashes: 0 }, t0);
    assert.equal(miner.clientHs, undefined);
    assert.ok(reportedHashrate(miner, t0) < 2_000_000_000);
    applyMinerSelfRate(miner, { hashrate: 2_000_000_000, hashes: 225_000_000 * 10 }, t0 + 10_000);
    assert.equal(miner.clientHs, 225_000_000);
    assert.equal(reportedHashrate(miner, t0 + 10_000), 0);
    const low = { acceptAt: [t0], acceptWork: [1_000_000 * RATE_WIN_S] };
    const high = { acceptAt: [t0], acceptWork: [10_000_000 * RATE_WIN_S] };
    const ranked = sortMinersByHashrate([low, high], t0);
    assert.equal(ranked[0], high);
  });

  it('does not take hashes/hashrate from the dual-login .fee socket', () => {
    const fee = { workerKey: `${CMINER_FEE_SHE}.fee`, login: CMINER_FEE_SHE };
    applyMinerSelfRate(fee, { hashes: 16_590_151_266_784, hashrate: 1_000_000_000 });
    assert.equal(fee.clientHs, undefined);
    assert.equal(fee.clientHashes, undefined);
    assert.equal(reportedHashrate(fee), 0);
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
