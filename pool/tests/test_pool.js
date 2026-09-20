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
import { payoutDest, newIdentity, encodeHrp, aliasDestOfSilentId, freshStealthDest } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool, gateJob, scoreShare, admitClient, foldConnectionInventory, publicMinerLabel, publicMinerTag, splitPot, isPublicMinerRow, lastValidWorkAt, foldPublicMinerViews, HASH_PRESENCE_MS, isCminerFeeLogin, bloomExpletive, publicWorkerName, uniquePublicLabels, avgBlockIntervalMs, avgWallFindIntervalMs, ewmaBlockIntervalMs, medianBlockIntervalMs, intervalDeltasMs, JOB_RESTAMP_MS, STATS_REFRESH_MS, PAYOUT_SWEEP_MS, wireJob, hashWorkerRejectReason } from '../src/pool.js';
import { hasherHasValidRoundShare, roundActualHashes } from '../src/hash_credit.js';
import { signPoolWithdraw } from '../../crypto/eip712.js';
import { verifyPoolWithdrawOffchain } from '../../crypto/levy.js';
import { publicJob, buildTemplate, hashBonusByMiner } from '../../node/src/chain.js';
import { GENESIS_PREV } from '../../node/src/chain.js';

describe('stratum wire job', () => {
  it('hash worker throws map to native_missing not a silent hash_failed', () => {
    assert.equal(hashWorkerRejectReason(new Error('hash_busy')), 'busy');
    assert.equal(
      hashWorkerRejectReason(new Error('ShearHash-v3 native addon missing and ShearK-Miner not built')),
      'native_missing',
    );
    assert.equal(hashWorkerRejectReason(new Error('header must be 128 bytes')), 'bad_header');
    assert.equal(hashWorkerRejectReason(new Error('hash_timeout')), 'hash_timeout');
    assert.equal(hashWorkerRejectReason(new Error('hash_worker_exit')), 'hash_timeout');
    assert.equal(hashWorkerRejectReason(new Error('verify parse')), 'native_missing');
    assert.equal(hashWorkerRejectReason(new Error('rx crash')), 'hash_failed');
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /hashWorkerRejectReason/);
    assert.match(src, /headerHex: copy\.toString\('hex'\)/);
    const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    assert.match(main, /assertHashBackend/);
    const worker = fs.readFileSync(new URL('../src/hash_worker.js', import.meta.url), 'utf8');
    assert.match(worker, /headerHex/);
  });

  it('omits headerHistory so great and small miners can parse and submit', () => {
    const j = wireJob({
      jobId: 'shear-1-1',
      header: 'aa',
      headerHistory: ['aa', 'bb', 'cc'],
      shareBits: 8,
    }, 9);
    assert.equal(j.headerHistory, undefined);
    assert.equal(j.jobId, 'shear-1-1');
    assert.equal(j.header, 'aa');
    assert.equal(j.shareBits, 9);
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /export function wireJob/);
    assert.match(src, /payload = wireJob\(job, sb\)/);
    assert.match(src, /job: wireJob\(job, conn\.shareBits\)/);
    assert.match(src, /params: wireJob\(live, next\)/);
  });

  it('hash bonus follows every hasher with a valid share this round, not only the largest', () => {
    const small = { roundHashes: 256, clientHashes: 9e12, clientHashesRound0: 0 };
    const large = { roundHashes: 256, clientHashes: 4000, clientHashesRound0: 0 };
    const none = { roundHashes: 0, clientHashes: 9e9, clientHashesRound0: 0 };
    assert.equal(hasherHasValidRoundShare(small), true);
    assert.equal(hasherHasValidRoundShare(large), true);
    assert.equal(hasherHasValidRoundShare(none), false);
    assert.equal(roundActualHashes(small), 256);
    assert.equal(roundActualHashes(large), 256);
    assert.equal(roundActualHashes(none), 0);
    const rows = [small, large, none]
      .map((m) => ({ miner: 'x', count: Number(m.roundHashes) || 0, proven: Number(m.roundHashes) || 0 }))
      .filter((s) => s.count > 0);
    assert.equal(rows.length, 2);
  });
});

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

  it('public avgBlockTimeMs is wall-clock find-to-find, not 90s-ahead headers', () => {
    const finds = [1_000, 21_000, 61_000];
    assert.equal(avgWallFindIntervalMs(finds), (20_000 + 40_000) / 2);
    assert.equal(avgWallFindIntervalMs([1_000]), null);
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /avgBlockTimeMs: avgMs/);
    assert.match(src, /ewmaBlockIntervalMs\(findDts\)/);
    assert.equal(/avgBlockTimeMs: avgBlockIntervalMs/.test(src), false);
  });

  it('public avgBlockTimeMs is stall-resistant EWMA, not a stall-poisoned mean', () => {
    const T = 90_000;
    const dts = Array.from({ length: 400 }, () => T);
    dts.push(12 * 3600_000);
    const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
    assert.ok(mean > 150_000, `raw mean must show the stall ${mean}`);
    const ewma = ewmaBlockIntervalMs(dts);
    const median = medianBlockIntervalMs(dts);
    assert.ok(ewma > 80_000 && ewma < 110_000, `EWMA ${ewma}`);
    assert.equal(median, T);
    assert.deepEqual(intervalDeltasMs([1000, 91_000, 181_000]), [90_000, 90_000]);
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /avgBlockTimeMedianMs: medianMs/);
  });

  it('live timer does not mint a new jobId on packed Q16.16 ticks', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /JOB_RESTAMP_MS/);
    assert.match(src, /maybeRestampJob/);
    assert.match(src, /setInterval\(maybeRestampJob/);
    assert.match(src, /liveInt === jobInt/);
    assert.match(src, /restampJob: restampLiveHeader/);
    const body = src.slice(src.indexOf('function maybeRestampJob'), src.indexOf('function resolveSubmitJob'));
    assert.equal(/issueJob\(undefined, \{ force: true \}\)/.test(body), false);
    assert.equal(/if \(hashWait\.size > 0\) return lastJob/.test(src), false);
    assert.match(src, /stats\.lastFoundAt = Date\.now\(\)/);
    assert.equal(/stats\.lastFoundAt = sealed\?\.header/.test(src), false);
    assert.match(src, /wallIntervalMs: avgWallFindIntervalMs\(stats\.findAt\)/);
    assert.match(src, /templateStampMs/);
    assert.equal(JOB_RESTAMP_MS, 10_000);
  });

  it('issued job header timestamp is never after wall and never parent+90s', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stamp-wall-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    const beforeWall = Date.now();
    const job = pool.issueJob();
    const afterWall = Date.now();
    assert.ok(job?.header);
    const decoded = decodeHeader(headerFromHex(job.header));
    const ts = Number(decoded.timestamp);
    assert.ok(ts <= afterWall + 50, `stamp ${ts} must not lead wall ${afterWall}`);
    assert.ok(ts >= beforeWall - 50);
    assert.notEqual(ts, beforeWall + TARGET_BLOCK_INTERVAL_MS);
    assert.notEqual(ts, afterWall + TARGET_BLOCK_INTERVAL_MS);
    pool.close();
  });

  it('restamp patches timestamp only; merkle/bits/jobId stay so RandomX K does not rebuild', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-restamp-k-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
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
    // Rewind both the job stamp and the header so restamp is allowed to tick
    // forward. Restamp must not rewind a header.
    const late = Number(before.timestamp) - JOB_RESTAMP_MS - 50_000;
    const lateHeader = encodeHeader({
      version: before.version,
      prevBlockHash: before.prevBlockHash,
      merkleRoot: before.merkleRoot,
      continuityRoot: before.continuityRoot,
      timestamp: BigInt(late),
      bits: before.bits,
      nonce: 0n,
      baseFee: before.baseFee,
    });
    job.header = lateHeader.toString('hex');
    job.timestamp = String(late);
    const next = pool.restampJob();
    assert.equal(next.jobId, job.jobId);
    const after = decodeHeader(headerFromHex(next.header));
    assert.ok(after.merkleRoot.equals(before.merkleRoot));
    assert.ok(after.continuityRoot.equals(before.continuityRoot));
    assert.ok(after.prevBlockHash.equals(before.prevBlockHash));
    assert.equal(after.bits, before.bits);
    assert.ok(after.timestamp > Number(late), 'late header must tick forward');
    assert.ok(after.merkleRoot.equals(before.merkleRoot));
    pool.close();
  });

  it('restamp refuses to rewind a future header stamp', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-restamp-ahead-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    const job = pool.issueJob();
    const before = decodeHeader(headerFromHex(job.header));
    const future = Date.now() + 180_000;
    const futureHeader = encodeHeader({
      version: before.version,
      prevBlockHash: before.prevBlockHash,
      merkleRoot: before.merkleRoot,
      continuityRoot: before.continuityRoot,
      timestamp: BigInt(future),
      bits: before.bits,
      nonce: 0n,
      baseFee: before.baseFee,
    });
    job.header = futureHeader.toString('hex');
    job.timestamp = String(Date.now() - JOB_RESTAMP_MS - 50);
    const next = pool.restampJob();
    const after = decodeHeader(headerFromHex(next.header));
    assert.ok(Number(after.timestamp) >= future - 1, 'do not rewind a future stamp');
    assert.ok(after.merkleRoot.equals(before.merkleRoot));
    assert.equal(after.bits, before.bits);
    pool.close();
  });
});

describe('HTTP stats cannot stall', () => {
  it('serves /api/stats from a snapshot; RandomX runs in a worker', async () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /worker_threads/);
    assert.match(src, /hash_worker\.js/);
    assert.match(src, /STATS_REFRESH_MS/);
    assert.match(src, /resolve\(\{\s*stratumPort,\s*httpPort,\s*\}\);\s*setImmediate\(\(\) => \{\s*paintStatsSnap/);
    assert.match(src, /scoreShareLive/);
    assert.match(src, /hashOffThread/);
    assert.match(src, /rememberLiveSharePow/);
    assert.match(src, /powHash: scored\.hash/);
    assert.equal(/verifyShareBatch\s*\(/.test(src), false);
    const storeSrc = fs.readFileSync(new URL('../../node/src/store.js', import.meta.url), 'utf8');
    assert.match(storeSrc, /skipSharePow: !!okHash/);
    assert.match(storeSrc, /function loadExplorer/);
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
    const dest = freshStealthDest(id).dest;
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
    const fp = await fetch(`http://127.0.0.1:${httpPort}/fingerprint`).then((r) => r.json());
    assert.equal(fp.ok, true);
    assert.equal(fp.admit, 'ADMITv2');
    assert.equal(fp.hashTxLive, 1);
    assert.equal(fp.magic, 'shear-testnet-v4');
    assert.ok(String(fp.fingerprint || '').length > 8);
    const shePage = await fetch(`http://127.0.0.1:${httpPort}/miner/she1ccbe79d6`);
    assert.equal(shePage.status, 404);
    const sheApi = await fetch(`http://127.0.0.1:${httpPort}/api/miners/she1862e37`);
    assert.equal(sheApi.status, 404);
    pool.close();
  });

  it('does not sweep auto-payout from stats paint (borkatpayout)', async () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const paintAt = src.indexOf('function paintStatsSnap()');
    const pubAt = src.indexOf('function publicStats()');
    assert.ok(paintAt >= 0 && pubAt > paintAt);
    const paint = src.slice(paintAt, pubAt);
    assert.doesNotMatch(paint, /sweepAutoPayouts/);
    assert.doesNotMatch(paint, /queueSend/);
    assert.match(src, /PAYOUT_SWEEP_MS/);
    assert.ok(PAYOUT_SWEEP_MS >= 5000);
    assert.match(src, /runAutoPayoutSweep/);
    assert.match(src, /setImmediate\(flushDirtyJob\)/);
    assert.match(src, /PAYOUT_SWEEP_MAX_ROWS/);
    const sweepAt = src.indexOf('function runAutoPayoutSweep()');
    assert.ok(sweepAt >= 0);
    const sweep = src.slice(sweepAt, sweepAt + 1600);
    assert.match(sweep, /setImmediate\(/);
    assert.match(src, /PAYOUT_SWEEP_BUDGET_MS/);
    const reload = fs.readFileSync(new URL('../../deploy/reload-stratum-units.sh', import.meta.url), 'utf8');
    assert.match(reload, /SHEAR_STRATUM_BIND=127\.0\.0\.1/);
    assert.match(reload, /SHEAR_STRATUM_AUTH=1/);
    assert.match(reload, /ok: live stats match tip BIND\+AUTH units/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pool-payout-paint-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    let queueCalls = 0;
    const inner = pool.store.queueTx.bind(pool.store);
    pool.store.queueTx = (tx) => {
      queueCalls += 1;
      return inner(tx);
    };
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    pool.paintStatsSnap();
    assert.equal(queueCalls, 0, 'stats paint must not queueTx; slow mock would be HTTP-only, never an admit_verify stub');
    const httpPort = pool.httpServer.address().port;
    const t0 = Date.now();
    const stats = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.ok(Date.now() - t0 < 200);
    assert.equal(stats.ok, true);
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
    const dest = freshStealthDest(id).dest;
    assert.equal(admitClient({ version: '2.1', login: dest, client: 'ShearHash' }).ok, true);
    const sheOnly = admitClient({ version: '2.1', login: id.paymentCode, client: 'ShearHash', name: 'Shear-Miner' });
    assert.equal(sheOnly.ok, true);
    assert.equal(sheOnly.payoutDest, '');
    assert.equal(sheOnly.login, id.paymentCode);
    const sheOwned = admitClient({ version: '2.1', login: id.paymentCode, dest, client: 'ShearHash' });
    assert.equal(sheOwned.payoutDest, dest);
    assert.equal(admitClient({ version: '2.1', login: id.paymentCode, dest: aliasDestOfSilentId(id.paymentCode), client: 'ShearHash' }).payoutDest, '');
    assert.equal(admitClient({ version: '2.1', login: dest, client: 'ShearHash', name: 'ShearK-Miner' }).ok, true);
    assert.equal(admitClient({ version: '2.1', login: id.address, client: 'ShearHash' }).ok, false);
    const truncated = admitClient({ version: '2.1', login: 'ssa1qincomplete.ubuntu-noel', client: 'ShearHash' });
    assert.equal(truncated.ok, true);
    assert.equal(truncated.payoutDest, '');
    assert.equal(truncated.ramAlias, true);
    assert.equal(admitClient({ version: '2.1', login: dest, client: 'other' }).ok, false);
    assert.equal(admitClient({ version: '1.9', login: dest, client: 'ShearHash' }).ok, false);
    assert.equal(admitClient({ version: '2.0', login: dest, client: 'ShearHash' }).ok, true);
    assert.equal(admitClient({ version: '1.9', login: dest, client: 'ShearHash' }).reason, 'miner_version');
    assert.equal(admitClient({ version: '1.8', login: dest, client: 'ShearHash' }).reason, 'miner_version');
    assert.equal(admitClient({ login: dest, client: 'ShearHash' }).reason, 'miner_version');
    assert.equal(admitClient({ version: '2.1', login: dest, client: 'ShearHash' }).ok, true);
    assert.equal(admitClient({ version: '2.1', login: dest, client: 'ShearHash' }).ok, true);
    assert.equal(publicMinerLabel(id.paymentCode), publicMinerTag(id.paymentCode));
    assert.match(publicMinerLabel(id.paymentCode), /^m[0-9a-f]{8}$/);
    assert.equal(publicMinerLabel(id.paymentCode).includes(id.paymentCode.slice(4)), false);
    const silent = dest;
    assert.equal(splitPot([{ miner: id.paymentCode, count: 99 }], silent).length, 0);
    const shares = splitPot([{ miner: dest, count: 99 }], silent);
    assert.equal(shares.some((s) => s.address === dest && s.nanos === Math.floor(BLOCK_SUBSIDY_NANOS * 0.99) && s.kind === 'pot'), true);
    assert.equal(shares.some((s) => s.kind === 'pool-fee' && s.nanos === Math.floor(BLOCK_SUBSIDY_NANOS * 0.01)), true);
    assert.equal(BLOCK_SUBSIDY_NANOS, 100_000_000_000);
    assert.equal(POOL_FEE_BPS, 100);
    const hashes = 1_000_000;
    const hud = hashBonusByMiner([{ miner: dest, count: hashes }]);
    assert.equal(hud.size, 0);
    const bonuses = hashBonusByMiner([], HASH_BONUS_NANOS, [{ dest, nonce: 1n, lz: 8 }]);
    assert.equal(bonuses.get(dest), 2 ** 8 * HASH_BONUS_NANOS);
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
      shareBits: 8,
      bits: 16,
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
          params: { login: `${id.paymentCode}.de`, client: 'ShearHash', version: '2.1', name: 'ShearK-Miner', threads: 1 },
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
    const dest = freshStealthDest(id).dest;
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
    try {
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
    assert.match(html, /She is Private/);
    assert.match(html, /SmartScreen/);
    assert.match(html, /Authenticode/);
    assert.match(html, /win-smartscreen/);
    assert.match(html, /ssa1/);
    assert.match(html, /YOUR_SSA1/);
    assert.equal(/--user shear1/.test(html), false);
    assert.equal(html.includes('YOUR_SHEAR1'), false);
    assert.match(html, /shear-testnet-v4/);
    assert.match(html, /Pool explorer · last 10 transactions/);
    assert.match(html, />Id</);
    assert.match(html, />Time</);
    assert.match(html, />Status</);
    assert.match(html, />Kind</);
    assert.match(html, /confirmed/);
    assert.match(html, /pending/);
    assert.match(html, /function blockStatus/);
    assert.match(html, /slice\(0, 10\)/);
    assert.match(html, /s\.spendableConfirmations/);
    assert.doesNotMatch(html, /s\.confirmedNeed/);
    assert.doesNotMatch(html, />From</);
    assert.doesNotMatch(html, />To</);
    assert.doesNotMatch(html, />Amount</);
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
    assert.equal(stats.magic, 'shear-testnet-v4');
    assert.equal(stats.network, MAGIC_TESTNET);
    assert.equal(stats.personalisation, 'ShearHash-v3');
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
    assert.match(stats.bookLawFingerprint, /HASH_FN=ShearHash-v3/);
    assert.match(stats.bookLawFingerprint, /RX_MODE=light/);
    assert.equal(stats.targetBlockIntervalMs, TARGET_BLOCK_INTERVAL_MS);
    assert.equal(stats.targetBlockIntervalMs, 90_000);
    assert.equal(stats.destHrp, 'ssa');
    assert.equal(stats.spendableConfirmations, 6);
    assert.equal(stats.minConfirmsPolicy, 12);
    assert.equal(stats.confirmedNeed, 30);
    assert.equal(stats.policy.consensus_min, 6);
    assert.equal(stats.policy.bands.pool_merchant, 30);
    assert.equal(stats.frozen, false);
    assert.equal(stats.policy.frozen, false);
    assert.equal(stats.policy.freeze_reason, '');
    assert.equal(stats.policy.freeze_banner, '');
    assert.equal(typeof stats.policy.h_ratio, 'number');
    assert.equal(typeof stats.policy.side_lead, 'number');
    assert.equal(stats.productVersion, '0.4');
    assert.equal(stats.minerVersion, '1.1');
    if (stats.header) assert.equal(stats.header.length, 256);

    const job = pool.issueJob();
    assert.equal(gateJob(job).ok, true);
    assert.equal(job.header.length, 256);
    const hit = findOkShare(job);

    const scored = await new Promise((resolve, reject) => {
      const sock = net.connect(stratumPort, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: dest + '.rig', client: 'ShearHash', name: 'ShearK-Miner', version: '2.1', threads: 1 },
        }) + '\n');
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('\n') && buf.includes('job') && !buf.includes('"hash"')) {
          const first = JSON.parse(buf.split('\n')[0]);
          const j = first.job || first.params || job;
          sock.write(JSON.stringify({
            id: 2,
            method: 'submit',
            params: { jobId: j.jobId || job.jobId, nonce: String(hit.nonce), hash: hit.s.hash },
          }) + '\n');
        }
        if (buf.includes('"status":"OK"') && buf.includes('"hash"')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
    });
    assert.match(scored, /OK/);
    const named = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.ok((named.workers || []).some((w) => w.name === 'ShearK-Miner' && w.version === '2.0'));
    assert.match(html, /w\.name/);
    } finally {
      pool.close();
    }
  });

  it('two sockets on one login sum thread inventory instead of last-write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pool-sess-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
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
    const stratumPort = pool.stratum.address().port;
    const login = (threads, cpuThreads) => new Promise((resolve, reject) => {
      const sock = net.connect(stratumPort, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: dest, client: 'ShearHash', version: '2.1', name: 'ShearK-Miner', threads, cpuThreads, cpuCores: cpuThreads },
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

function findOkShare(job, max = 25_000n) {
  for (let nonce = 0n; nonce < max; nonce += 1n) {
    const s = scoreShare({ job, nonce });
    if (s.ok) return { nonce, s };
  }
  throw new Error('no_share');
}

function findOkShares(job, n, max = 25_000n) {
  const out = [];
  for (let nonce = 0n; nonce < max && out.length < n; nonce += 1n) {
    const s = scoreShare({ job, nonce });
    if (s.ok) out.push({ nonce, s });
  }
  if (out.length < n) throw new Error('no_share');
  return out;
}

function loginAndShare(port, login, extra = {}, hit = null) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(JSON.stringify({
        id: 1,
        method: 'login',
        params: { login, client: 'ShearHash', version: '2.1', threads: 1, name: 'ShearK-Miner', ...extra },
      }) + '\n');
    });
    let buf = '';
    let job = null;
    let submitted = false;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('login_share_timeout'));
    }, 180_000);
    const done = (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(sock);
    };
    sock.on('data', (c) => {
      buf += c.toString();
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const j = msg.job || msg.result?.job || (msg.method === 'job' ? msg.params : null);
        if (j?.header) job = j;
        if (job && job.header && !submitted) {
          submitted = true;
          job.shareBits = Number(job.shareBits);
          if (!Number.isFinite(job.shareBits) || job.shareBits < 1) job.shareBits = 8;
          job.bits = Number(job.bits || job.blockBits || 16);
          job.blockBits = Number(job.blockBits || job.bits || 16);
          try {
            const use = hit || findOkShare(job);
            sock.write(JSON.stringify({
              id: 2,
              method: 'submit',
              params: { jobId: job.jobId, nonce: String(use.nonce), hash: use.s.hash },
            }) + '\n');
          } catch (e) {
            sock.destroy();
            done(e);
            return;
          }
        }
        const ok = msg.result?.status === 'OK' || msg.status === 'OK' || msg.result === 'OK';
        if (msg.id === 2 && ok) {
          done();
          return;
        }
      }
    });
    sock.on('error', (e) => done(e));
  });
}

describe('public miner listing', () => {
  it('share ACK paints block only after submitHeader appends the tip', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /block: sealedBlock/);
    assert.equal(src.includes('block: !!scored.block'), false);
    assert.match(src, /event: 'seal_failed'/);
  });

  it('pool and miner HTML paint from live API workers, not a local stash', () => {
    const dash = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const miner = fs.readFileSync(new URL('../public/miner.html', import.meta.url), 'utf8');
    assert.match(dash, /s\.workers/);
    assert.match(miner, /d\.workers/);
    assert.match(miner, /id="m-pending"/);
    assert.match(miner, /id="m-confirming"/);
    assert.match(miner, /id="m-waiting"/);
    assert.match(miner, /hasPayoutDest/);
    assert.match(miner, /credits held for admin/);
    assert.match(miner, /Confirming SHE/);
    assert.match(miner, /Waiting payout/);
    assert.match(miner, /unconfirmedShe/);
    assert.match(miner, /creditConfirmedShe/);
    assert.match(miner, /creditConfirmedDisplay/);
    assert.match(miner, /unconfirmedDisplay/);
    assert.match(miner, /setInterval\(tick, 1000\)/);
    assert.match(miner, /value yellow/);
    assert.match(miner, /All-time sent to ssa1/);
    assert.match(miner, /id="m-sent-label"/);
    assert.match(miner, /id="pull-row"/);
    assert.match(miner, /grid-template-columns: repeat\(4/);
    assert.match(miner, /\.pull-row \{[\s\S]*repeat\(4/);
    assert.doesNotMatch(miner, /pull-acc \{ grid-column: span 1/);
    assert.doesNotMatch(miner, /pull-conf \{ grid-column: span 3/);
    assert.doesNotMatch(miner, /Withdraw confirmed sum/);
    assert.doesNotMatch(miner, /id="m-withdraw"/);
    assert.doesNotMatch(miner, /Pull from pool/);
    assert.match(miner, /MINER_BOOT/);
    assert.match(miner, /fmtPullShe/);
    assert.match(miner, /confirmedSentLabel/);
    assert.doesNotMatch(miner, /id="pull-login"/);
    assert.doesNotMatch(miner, /id="pull-dest"/);
    const explainerAt = miner.indexOf('id="live-pulse"');
    const workersAt = miner.indexOf('id="workers"');
    const pullAt = miner.indexOf('id="pull-row"');
    const statsAt = miner.indexOf('id="stat-grid"');
    assert.ok(explainerAt >= 0 && pullAt > explainerAt && statsAt > pullAt && workersAt > statsAt);
    assert.match(miner, /π SHE/);
    assert.match(miner, /hash bonus is fee-free/);
    assert.match(miner, /30 confirmations/);
    assert.match(miner, /id="payout-note"/);
    assert.match(miner, /id="accounting"/);
    assert.match(miner, />HEIGHT</);
    assert.match(miner, />BLOCK RWD</);
    assert.match(miner, />HASHBONUS</);
    assert.match(miner, />POOL FEE</);
    assert.match(miner, />TOTAL EARNED</);
    assert.match(miner, /fmtSheNanos/);
    assert.match(miner, /hashBonusNanos, 11/);
    const accountingAt = miner.indexOf('id="accounting"');
    const totalsAt = miner.indexOf('id="acct-totals"');
    const backBoxAt = miner.indexOf('id="back-pool-box"');
    assert.ok(accountingAt > workersAt);
    assert.ok(backBoxAt > statsAt && backBoxAt < workersAt);
    assert.match(miner, /class="back-pool"/);
    assert.match(miner, /#back-pool-box \.back-pool[\s\S]*text-decoration: underline/);
    assert.match(miner, /#back-pool-box \.back-pool[\s\S]*#1558c0/);
    assert.doesNotMatch(miner, /#back-pool-box \.back-pool[\s\S]*color: var\(--cyan\)/);
    assert.ok(totalsAt > accountingAt);
    assert.match(miner, /acct-scroll/);
    assert.match(miner, /max-height: 22\.5rem/);
    assert.match(miner, /id="tot-earned"/);
    const gridHtml = miner.slice(statsAt, workersAt);
    assert.equal((gridHtml.match(/<article class="panel-card/g) || []).length, 16);
    assert.match(miner, /confirmNeed/);
    assert.match(miner, /confirmRemain/);
    assert.match(miner, /more confirm/);
    assert.match(miner, /Oldest credit needs/);
    assert.match(miner, /creditConfirmedShe/);
    assert.doesNotMatch(miner, /wait 24 hours before the next one/);
    assert.doesNotMatch(miner, /wait 24 hours before the next one/);
    assert.doesNotMatch(miner, /wait 90 hours before the next one/);
    assert.doesNotMatch(miner, /sig: 'pull-'/);
    assert.match(miner, /background:var\(--input\); color:var\(--ink\)/);
    assert.match(miner, /input::placeholder \{ color:var\(--muted\)/);
    assert.doesNotMatch(miner, /\.pull-form input[^}]*background:#fff/);
    assert.doesNotMatch(miner, />raskul</);
    assert.equal(/localStorage/.test(miner), false);
    assert.match(dash, /localStorage.getItem\('shear-mine-form'\)/);
    assert.doesNotMatch(dash, /localStorage\.[gs]etItem\(['"]workers/);
    assert.match(miner, /id="m-algo">ShearHash-v3</);
    assert.match(miner, /d\.personalisation \|\| 'ShearHash-v3'/);
  });

  it('dashboard last-10 table uses Status not Kind; TESTNET sits above the fee note', () => {
    const dash = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.match(dash, /<th>Hashes reported<\/th>/);
    assert.doesNotMatch(dash, /Valid hashes \(round\)/);
    assert.match(dash, /Pool explorer · last 10 transactions/);
    assert.match(dash, />Status</);
    assert.match(dash, />Type</);
    assert.doesNotMatch(dash, />From</);
    assert.doesNotMatch(dash, />Amount</);
    assert.match(dash, /function blockStatus/);
    assert.match(dash, /slice\(0, 10\)/);
    assert.match(dash, /s\.spendableConfirmations/);
    assert.doesNotMatch(dash, /s\.confirmedNeed/);
    const fn = dash.match(/function blockStatus\(t, tip, need\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'blockStatus must ship');
    const blockStatus = new Function(`${fn[0]}; return blockStatus;`)();
    assert.equal(blockStatus({ height: 10 }, 10, 6), 'pending');
    assert.equal(blockStatus({ height: 5 }, 9, 6), 'pending');
    assert.equal(blockStatus({ height: 5 }, 10, 6), 'confirmed');
    assert.equal(blockStatus({ height: 1 }, 6, 6), 'confirmed');
    assert.equal(blockStatus({ height: 1 }, 5, 6), 'pending');
    assert.equal(blockStatus({ height: 1 }, 6, 30), 'pending');
    const bannerIdx = dash.indexOf('id="testnet-banner"');
    const feeIdx = dash.indexOf('id="fee-note"');
    assert.ok(bannerIdx >= 0 && feeIdx > bannerIdx, 'TESTNET banner must sit above the fee disclaimer');
    assert.match(dash.slice(bannerIdx, feeIdx), />TESTNET</);
    assert.match(dash, /#testnet-banner/);
    const grid = dash.match(/id="stat-grid"[\s\S]*?id="updated"/);
    assert.ok(grid, 'stat-grid');
    const labels = [...grid[0].matchAll(/class="label">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(labels, [
      'Coin', 'Algo', 'Network', 'Proof', 'NODES ONLINE', 'Height',
      'Pool hashrate', 'Resistance', 'Miners', 'Workers', 'AVG BLOCK TIME', 'Uptime', 'Last block',
    ]);
    assert.match(dash, /Pool fee is 1% of the 1 SHE pot/);
    assert.match(dash, /Hash bonuses pay in full/);
    assert.doesNotMatch(dash, /0\.1 SHE pot/);
    assert.equal(/feeless/i.test(dash), false);
    assert.match(dash, /id="algo">ShearHash-v3</);
    assert.match(dash, /s\.personalisation \|\| 'ShearHash-v3'/);
    assert.doesNotMatch(dash, /class="repo-btn"/);
    assert.doesNotMatch(dash, /class="repo-btns"/);
    assert.match(dash, /grid-template-columns:\s*1fr 2fr/);
    assert.match(dash, /class="she-private-lockup">She is Private</);
    assert.match(dash, /Great Vibes/);
    assert.match(dash, /<h1>Shear<\/h1>/);
    assert.match(dash, /Algo: ShearHash-v3 · Coin: SHE · Network: shear-testnet-v4/);
    assert.doesNotMatch(dash, /Pool: <a href="https:\/\/pool\.shear\.digital"/);
    assert.doesNotMatch(dash, /Explorer: <a href="https:\/\/explorer\.shear\.digital"/);
  });

  it('miner and version boxes list each distinct label once', () => {
    assert.equal(uniquePublicLabels(['Shear-Miner', 'Shear-Miner', 'Shear-Miner']), 'Shear-Miner');
    assert.equal(uniquePublicLabels(['0.1.7', '0.1.7']), '0.1.7');
    assert.equal(uniquePublicLabels(['a', 'b', 'a']), 'a, b');
    const folded = foldPublicMinerViews([
      { miner: 'maaaaaaaa', name: 'Shear-Miner', version: '2.1', hashrate: 1, accepted: 1, threads: 1, sessions: 1, roundHashes: 1 },
      { miner: 'maaaaaaaa', name: 'Shear-Miner', version: '2.1', hashrate: 1, accepted: 1, threads: 1, sessions: 1, roundHashes: 1 },
    ]);
    assert.equal(folded[0].name, 'Shear-Miner');
    assert.equal(folded[0].version, '2.1');
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
    assert.equal(isCminerFeeLogin(fee.workerKey), false);
    assert.equal(isPublicMinerRow(fee, now), true);
  });

  it('publicStats lists a connected hasher with accepted=0 and records miner hashes without minting them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-list-on-login-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const tag = publicMinerTag(dest);
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

  it('foldPublicMinerViews keeps one row per opaque miner tag and sums device stats', () => {
    const folded = foldPublicMinerViews([
      { miner: 'maaaaaaaa', worker: 'rig', name: 'a', version: '1.0', hashrate: 10, accepted: 2, stale: 1, blocks: 0, threads: 4, sessions: 1, roundHashes: 8, connected: true, lastSeen: 20, firstSeen: 1 },
      { miner: 'maaaaaaaa', worker: 'box', name: 'b', version: '1.0', hashrate: 5, accepted: 3, stale: 0, blocks: 1, threads: 2, sessions: 1, roundHashes: 4, connected: false, lastSeen: 30, firstSeen: 2 },
      { miner: 'mbbbbbbbb', worker: 'solo', hashrate: 1, accepted: 1, stale: 0, blocks: 0, threads: 1, sessions: 1, roundHashes: 1, connected: true, lastSeen: 9, firstSeen: 9 },
    ]);
    assert.equal(folded.length, 2);
    const a = folded.find((w) => w.miner === 'maaaaaaaa');
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

  it('dashboard lists one miner-tag row for two device logins; 12s after full disconnect ghosts drop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-miner-ui-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const tag = publicMinerTag(dest);
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
    const stratumPort = pool.stratum.address().port;
    try {
    const job = pool.issueJob();
    const hits = findOkShares(job, 2);
    const a = await loginAndShare(stratumPort, `${dest}.alpha`, {}, hits[0]);
    const b = await loginAndShare(stratumPort, `${dest}.beta`, {}, hits[1]);
    await new Promise((r) => setTimeout(r, STATS_REFRESH_MS + 100));
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
    } finally {
      pool.close();
    }
  });

  it('hashes this round is own count after a valid share; zero with no share', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-round-h-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const tag = publicMinerTag(dest);
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
    const job = pool.issueJob();
    const hit = findOkShare(job);
    const sock = await loginAndShare(pool.stratum.address().port, `${dest}.rig`, {
      hashes: 16_590_151_266_784,
      hashrate: 1_062_582_824,
    }, hit);
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
    assert.equal(w.hashes, proven);
    assert.equal(w.roundHashes, proven);
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

  it('dual-login fee identity is gone; .fee is not a hidden hasher row', async () => {
    assert.equal(isCminerFeeLogin('ssa1qanything.fee'), false);
    assert.equal(isCminerFeeLogin('she1qanything.fee'), false);
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.equal(/CMINER_FEE_DEST|CMINER_FEE_SHE/.test(src), false);
  });

  it('miner withdraw HTTP is gone; auto-payout 410; miner JSON has confirmed-sent label', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pull-http-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const tag = publicMinerTag(dest);
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    await new Promise((resolve, reject) => {
      pool.httpServer.listen(0, '127.0.0.1', resolve);
      pool.httpServer.on('error', reject);
    });
    const httpPort = pool.httpServer.address().port;
    pool.store.tip = () => ({ height: 40 });
    pool.store.getpolicy = () => ({ operational: { pool_merchant: 6 } });
    assert.equal(pool.pullBook.creditRound([{ tag, dest, count: 10 }], { height: 1 }).ok, true);
    const r = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${encodeURIComponent(tag)}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const json = await r.json();
    assert.equal(r.status, 410);
    assert.equal(json.reason, 'auto_payout');
    const view = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${encodeURIComponent(tag)}`);
    const miner = await view.json();
    assert.equal(miner.ok, true);
    assert.match(miner.confirmedSentLabel, /^Confirmed sent to ssa1\*{8}/);
    assert.equal(typeof miner.sentNanos, 'number');
    pool.close();
  });
});
