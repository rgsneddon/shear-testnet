import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  admitClient,
  createPool,
  foldConnectionInventory,
  provenHashrate,
  reportedHashrate,
  liveHashrate,
  applyMinerSelfRate,
  resetMinerRoundDisplay,
  liveRoundHashes,
  roundActualHashes,
  sortMinersByHashrate,
  refreshMinerRow,
  workerKey,
  rememberShare,
  shareFingerprint,
  submittedShareDigest,
  isCminerFeeLogin,
  HASHRATE_WINDOW_MS,
  HASHRATE_EMA_TAU_S,
  SELF_RATE_MIN_DT_S,
  HASHRATE_STALL_HOLD_MS,
  HASHRATE_HOLD_FRAC,
  HASH_QUEUE_MAX,
  HASH_INFLIGHT_PER_CONN,
} from '../src/pool.js';
import { extraMintAllowed, RESERVE_PROGRAM, JOIN_PROGRAM, HASH_BONUS_NANOS, NANOS_PER_SHE } from '../../crypto/asert.js';
import { pendingFor } from '../src/wallet_api.js';
import { hasherHasValidRoundShare, clientHashCreditForbidden } from '../src/hash_credit.js';
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

  it('hashes/dt paints on miner and pool alike; that rate does not mint', () => {
    const miner = {
      accepted: 0,
      roundHashes: 0,
      connections: [{ sock: {} }],
      clientHashes: 4200,
      clientHs: 55,
    };
    assert.equal(liveHashrate(miner), 55);
    assert.equal(Math.round(reportedHashrate(miner)), 55);
    assert.equal(miner.roundHashes, 0);
    assert.equal(provenHashrate(miner), 0);
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
    miner.clientHashesRound0 = miner.clientHashes;
    assert.equal(roundActualHashes(miner), 256);
    miner.clientHashes += 900;
    assert.equal(roundActualHashes(miner), 256);
    assert.notEqual(roundActualHashes(miner), miner.clientHashes);
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

  it('old-miner hash counter without a valid share mints nothing; a scored share still pays', () => {
    const idIdle = newIdentity();
    const dest = freshStealthDest(idIdle).dest;
    const idle = {
      login: dest,
      accepted: 0,
      roundHashes: 0,
      clientHashes: 16_590_151_266_784,
      clientHashesRound0: 0,
    };
    assert.equal(admitClient({ version: '2.1', login: dest, client: 'ShearHash', name: 'Shear-Miner' }).ok, true);
    assert.equal(hasherHasValidRoundShare(idle), false);
    assert.equal(roundActualHashes(idle), 0);
    const none = pendingFor(new Map([['idle', idle]]), dest);
    assert.equal(none.shares, 0);
    assert.equal(none.amount, 0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hash-gate-'));
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    pool.miners.set('old', { ...idle, workerKey: `${dest}.old` });
    const emptySnap = pool.snapshotRound();
    assert.equal(emptySnap.some((s) => (Number(s.count) || 0) > 0), false);

    const live = {
      login: dest,
      workerKey: `${dest}.rig`,
      accepted: 1,
      roundHashes: 256,
      clientHashes: 16_590_151_266_784 + 900,
      clientHashesRound0: 16_590_151_266_784,
    };
    assert.equal(hasherHasValidRoundShare(live), true);
    assert.equal(roundActualHashes(live), 256);
    assert.notEqual(roundActualHashes(live), live.clientHashes);
    const paid = pendingFor(new Map([['live', live]]), dest);
    assert.equal(paid.shares, 256);
    assert.equal(paid.amount, 256 * HASH_BONUS_NANOS / NANOS_PER_SHE);
    pool.miners.set('live', live);
    const snap = pool.snapshotRound();
    const row = snap.find((s) => s.miner === dest || String(s.miner).startsWith(dest.slice(0, 8)));
    assert.ok(row, JSON.stringify(snap));
    assert.equal(row.count, 256);
    assert.equal(row.proven, 256);
    assert.notEqual(row.count, live.clientHashes);
    assert.equal(submittedShareDigest({}), '');
    assert.equal(submittedShareDigest({ hash: 'zz' }), '');
    assert.equal(submittedShareDigest({ hashes: 99, hashrate: 1 }), '');
    assert.equal(submittedShareDigest({ hash: 'A'.repeat(64) }), 'a'.repeat(64));
    pool.close();
  });

  it('nonce-only submits (old miner) are refused without hashing and cannot stall stats', async () => {
    const idNeed = newIdentity();
    const dest = freshStealthDest(idNeed).dest;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-need-hash-'));
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
    const port = pool.stratum.address().port;
    const httpPort = pool.httpServer.address().port;
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
    sock.write(JSON.stringify({
      id: 1,
      method: 'login',
      params: { login: `${dest}.old`, client: 'ShearHash', name: 'Shear-Miner', version: '2.1', threads: 8, hashes: 9e12, hashrate: 1e9 },
    }) + '\n');
    await new Promise((res) => sock.once('data', res));
    const t0 = Date.now();
    sock.write(JSON.stringify({
      id: 2,
      method: 'submit',
      params: { jobId: 'x', nonce: '0', hashes: 9e12, hashrate: 1e9 },
    }) + '\n');
    const stats = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.ok(Date.now() - t0 < 500, 'old-miner nonce-only submit must not stall /api/stats');
    assert.equal(stats.ok, true);
    await new Promise((resolve, reject) => {
      if (sock.destroyed || sock.readyState === 'closed') {
        resolve();
        return;
      }
      const t = setTimeout(() => reject(new Error('old miner still connected')), 4000);
      sock.once('close', () => { clearTimeout(t); resolve(); });
    });
    const row = [...pool.miners.values()].find((m) => String(m.workerKey || '').endsWith('.old'));
    if (row) {
      assert.equal(Number(row.accepted) || 0, 0);
      assert.equal(Number(row.roundHashes) || 0, 0);
      assert.equal(roundActualHashes(row), 0);
    }
    pool.close();
  });

  it('third-party vortices cannot extra-mint; Reserve APR only; Join genesis refused', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: 'join-genesis' }), false);
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
      acceptWork: [80 * RATE_WIN_S],
      clientHs: 80,
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
    assert.equal(Math.round(provenHashrate(ten, now)), 256);
    applyMinerSelfRate(ten, { hashrate: 2_000_000_000, hashes: 1_000_000 + 400 }, now + 1000);
    assert.equal(Math.round(reportedHashrate(ten, now)), 256);
    applyMinerSelfRate(ten, { hashrate: 2_000_000_000, hashes: 1_000_000 + 400 * 10 }, now + 10_000);
    assert.equal(Math.round(provenHashrate(ten, now + 10_000)), 256);
    assert.equal(ten.clientHs, 400);
    const eased = reportedHashrate(ten, now + 10_000);
    assert.ok(eased > 256 && eased <= 400, `hashes/dt HUD ${eased}`);
    assert.equal(Math.round(reportedHashrate(one, now)), 80);
    applyMinerSelfRate(ten, { hashes: 1_000_000 + 400 * 10 + 225_000_000 }, now + 20_000);
    assert.equal(ten.clientHs, 400);
    assert.equal(reportedHashrate(one, now), 80);
  });

  it('connected hasher eases toward hashes/dt; stall hold does not drop to 0', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.equal(/lastPositiveHs/.test(src), false);
    assert.match(src, /const client = Number\(miner\?\.clientHs\)/);
    assert.equal(HASH_QUEUE_MAX, 16);
    assert.equal(HASH_INFLIGHT_PER_CONN, 2);
    const t0 = 1_700_000_000_000;
    const m = { connections: [{ sock: {} }], clientHs: 100 };
    assert.equal(reportedHashrate(m, t0), 100);
    m.clientHs = 96;
    const eased = reportedHashrate(m, t0 + 1000);
    assert.ok(eased < 100 && eased > 96, `eased ${eased}`);
    assert.equal(liveHashrate(m, t0 + 1000), 96);
    const held = { connections: [{ sock: {} }], clientHs: 0, emaHs: 80, emaAt: t0 };
    assert.equal(reportedHashrate(held, t0 + 1000), 80);
  });

  it('blockfound does not paint a kH/s spike on a 1-thread hasher', () => {
    const t0 = 1_700_000_000_000;
    const m = {
      connections: [{ sock: {} }],
      threads: 1,
      acceptAt: [t0 - 1000],
      acceptWork: [55 * RATE_WIN_S],
    };
    assert.equal(Math.round(reportedHashrate(m, t0)), 55);
    m.clientHs = 55;
    resetMinerRoundDisplay(m, t0 + 10_000);
    assert.equal(m.clientHs, 55);
    assert.ok(reportedHashrate(m, t0 + 10_000) > 40, 'round reset must keep eased H/s');
    applyMinerSelfRate(m, { hashes: 1000 + 550 + 50_000 }, t0 + 15_000);
    const hs = reportedHashrate(m, t0 + 15_000);
    assert.ok(hs < 200, `blockfound spike ${hs}`);
  });

  it('public stats keep proven_round separate from time-window hashrate', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /proven_round: roundActualHashes\(m\)/);
    assert.match(src, /hashrate: reportedHashrate\(m, now\)/);
    const t0 = 1_700_000_000_000;
    const m = {
      connections: [{ sock: {} }],
      threads: 1,
      roundHashes: 256,
      acceptAt: [t0 - 1000],
      acceptWork: [55 * RATE_WIN_S],
    };
    assert.equal(roundActualHashes(m), 256);
    const hsBefore = reportedHashrate(m, t0);
    resetMinerRoundDisplay(m, t0 + 10_000);
    assert.equal(roundActualHashes(m), 0);
    assert.equal(m.roundHashes, 0);
    assert.equal(reportedHashrate(m, t0 + 10_000), hsBefore, 'proven_round reset must not jump H/s');
  });

  it('HUD hashes follow the miner counter; bonus stays proven 2^shareBits units', () => {
    const m = {
      connections: [{ sock: {} }],
      threads: 1,
      roundHashes: 256,
      clientHashes: 1000,
      clientHashesRound0: 400,
    };
    assert.equal(liveRoundHashes(m), 600);
    assert.equal(roundActualHashes(m), 256);
    assert.equal(clientHashCreditForbidden(), true);
  });

  it('pool HUD hashes/dt matches the miner hashrate formula; mint stays proven', () => {
    assert.equal(SELF_RATE_MIN_DT_S, 8);
    assert.equal(HASHRATE_EMA_TAU_S, 8);
    const t0 = 1_700_000_000_000;
    const m = { connections: [{ sock: {} }], threads: 2 };
    applyMinerSelfRate(m, { hashes: 10_000 }, t0);
    applyMinerSelfRate(m, { hashes: 10_000 + 2320, hashrate: 970, threads: 2 }, t0 + 2_000);
    assert.equal(Number(m.clientHs) || 0, 0);
    applyMinerSelfRate(m, { hashes: 10_000 + 970 * 10 }, t0 + 10_000);
    assert.equal(Math.round(m.clientHs), 970);
    assert.equal(Math.round(reportedHashrate(m, t0 + 10_000)), 970);
    assert.equal(provenHashrate(m, t0 + 10_000), 0);
    assert.equal(Number(m.roundHashes) || 0, 0);
  });

  it('junk claimed hashrate is ignored; display is hashes/dt; mint stays proven', () => {
    const t0 = 1_700_000_000_000;
    const m = { connections: [{ sock: {} }], threads: 2 };
    applyMinerSelfRate(m, { hashes: 10_000, hashrate: 2_000_000_000, threads: 2 }, t0);
    applyMinerSelfRate(m, { hashes: 10_000 + 970 * 10, hashrate: 2_000_000_000, threads: 2 }, t0 + 10_000);
    assert.equal(m.clientHs, 970);
    assert.equal(Math.round(reportedHashrate(m, t0 + 10_000)), 970);
  });

  it('8s hashes/dt matches a 12 kH/s miner; a 2s burst does not paint 1.2×', () => {
    const t0 = 1_700_000_000_000;
    const m = { connections: [{ sock: {} }], threads: 40 };
    applyMinerSelfRate(m, { hashes: 0, hashrate: 12_000, threads: 40 }, t0);
    applyMinerSelfRate(m, { hashes: 2_400, hashrate: 12_000, threads: 40 }, t0 + 2_000);
    assert.equal(Number(m.clientHs) || 0, 0);
    applyMinerSelfRate(m, { hashes: 12_000 * 8, hashrate: 14_400, threads: 40 }, t0 + 8_000);
    assert.equal(m.clientHs, 12_000);
    assert.equal(Math.round(reportedHashrate(m, t0 + 8_000)), 12_000);
  });

  it('1-thread ~55 H/s hashes/dt paints ~55, not kH/s', () => {
    const t0 = 1_700_000_000_000;
    const m = { connections: [{ sock: {} }], threads: 1 };
    applyMinerSelfRate(m, { hashes: 0 }, t0);
    applyMinerSelfRate(m, { hashes: 55 * 10 }, t0 + 10_000);
    assert.equal(m.clientHs, 55);
    assert.equal(reportedHashrate(m, t0 + 10_000), 55);
    assert.equal(liveHashrate(m, t0 + 10_000), 55);
    assert.ok(reportedHashrate(m, t0 + 10_000) < 200);
  });

  it('K-pause / between-block dip holds the last rate', () => {
    assert.equal(HASHRATE_HOLD_FRAC, 0.9);
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.equal(/HASHRATE_RISE_FRAC/.test(src), false);
    const t0 = 1_700_000_000_000;
    const m = { connections: [{ sock: {} }], threads: 1 };
    applyMinerSelfRate(m, { hashes: 1_000 }, t0);
    applyMinerSelfRate(m, { hashes: 1_000 + 80 * 10 }, t0 + 10_000);
    assert.equal(m.clientHs, 80);
    assert.equal(reportedHashrate(m, t0 + 10_000), 80);
    applyMinerSelfRate(m, { hashes: 1_000 + 80 * 10 + 400 }, t0 + 30_000);
    assert.equal(m.clientHs, 80);
    assert.equal(reportedHashrate(m, t0 + 30_000), 80);
  });

  it('connect hashrate ramps up from own hashes, never down from a session-average spike', () => {
    const t0 = Date.now();
    const miner = {};
    applyMinerSelfRate(miner, { hashrate: 2_000_000_000, hashes: 0 }, t0);
    assert.equal(miner.clientHs, undefined);
    assert.ok(reportedHashrate(miner, t0) < 2_000_000_000);
    applyMinerSelfRate(miner, { hashrate: 2_000_000_000, hashes: 225_000_000 * 10 }, t0 + 10_000);
    assert.equal(miner.clientHs, undefined);
    assert.equal(reportedHashrate(miner, t0 + 10_000), 0);
    const low = { acceptAt: [t0], acceptWork: [1_000_000 * RATE_WIN_S] };
    const high = { acceptAt: [t0], acceptWork: [10_000_000 * RATE_WIN_S] };
    const ranked = sortMinersByHashrate([low, high], t0);
    assert.equal(ranked[0], high);
  });

  it('does not take hashes/hashrate from a dual-login .fee socket (fee identity deleted)', () => {
    assert.equal(isCminerFeeLogin('anything.fee'), false);
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.equal(/CMINER_FEE_DEST|CMINER_FEE_SHE/.test(src), false);
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
    const dest = freshStealthDest(id).dest;
    assert.equal(workerKey(`${dest}.alpha`), `${dest}.alpha`);
    assert.notEqual(workerKey(`${dest}.alpha`), workerKey(`${dest}.beta`));
    assert.equal(admitClient({ version: '2.1', login: `${dest}.alpha`, client: 'ShearHash' }).workerKey, `${dest}.alpha`);
    assert.equal(admitClient({ version: '2.1', login: `${dest}.alpha`, client: 'ShearHash' }).login, dest);
  });

  it('two sockets on one worker sum; dest.other is a separate row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hon-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 10,
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
          params: { login: user, client: 'ShearHash', version: '2.1', name: 'ShearK-Miner', threads, cpuThreads, cpuCores: cpuThreads },
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
    const dest = freshStealthDest(id).dest;
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
            name: 'ShearK-Miner',
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
