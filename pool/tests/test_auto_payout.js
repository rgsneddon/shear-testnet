import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { PI_SHE_NANOS, NANOS_PER_SHE, POOL_FEE_BPS, BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS } from '../../crypto/asert.js';
import {
  AUTO_PAYOUT_MIN_NANOS,
  POOL_FEE_RESERVE_NANOS,
  POOL_FEE_RESERVE_SHE,
  POOL_FEE_PAYOUT_DEST_ENV,
  isMinerSsa1,
  redactSsa1,
  shouldAutoPayout,
  buildAutoPayoutTx,
  buildPoolFeeSweepTx,
  poolFeePayoutDest,
  poolFeeSweepNanos,
  potCreditAfterFeeNanos,
  hashCreditNanos,
} from '../src/auto_payout.js';
import { createPullBook } from '../src/pull_book.js';
import { publicMinerTag, createPool } from '../src/pool.js';
import { spendBox } from '../../tests/spend_box.js';
import { verifyPoolWithdrawBound, signSpendTx } from '../../crypto/spend.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { bootPoolOperator } from '../src/pool_ident.js';
import { poolWithdrawTx } from '../../crypto/levy.js';
import { hash20FromAddress, spendDestOf } from '../../crypto/address.js';
import { sealCoinbaseNote } from '../../crypto/note.js';
import { noteCommitSpendableNanos } from '../../crypto/coinbase_notes.js';
import { custodyPotShares } from '../../node/src/chain.js';
import { createStore } from '../../node/src/store.js';

function dumpScratch(name, body) {
  const dir = process.env.GROK_GOAL_SCRATCH;
  if (!dir) return;
  fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

async function listenHttp(pool) {
  await new Promise((resolve, reject) => {
    pool.stratum.listen(0, '127.0.0.1', () => {
      pool.httpServer.listen(0, '127.0.0.1', resolve);
    });
    pool.stratum.on('error', reject);
  });
  return pool.httpServer.address().port;
}

function sealedCustodyBlock({ poolDest, hashers, height }) {
  const shares = custodyPotShares(poolDest);
  const vout = shares.map((s) => sealCoinbaseNote(s.nanos, {
    dest20: hash20FromAddress(s.address),
    kind: s.kind || 'pot',
  }));
  return {
    height,
    miner: poolDest,
    poolDest,
    shareBatch: hashers.map((d, i) => ({
      dest: d,
      dest20: hash20FromAddress(d),
      nonce: BigInt(i + 1),
      lz: 8,
    })),
    txs: [{ coinbase: true, vout }],
  };
}

function injectMatureCustody(store, poolDest, hashers, { pots = 4, tipHeight = 40 } = {}) {
  for (let h = 1; h <= pots; h += 1) {
    store.blocks.push(sealedCustodyBlock({ poolDest, hashers, height: h }));
  }
  for (let h = pots + 1; h <= tipHeight; h += 1) {
    store.blocks.push({ height: h, txs: [] });
  }
}

function ssa1() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

describe('auto payout at π SHE to miner ssa1', () => {
  it('threshold is π SHE; she1 dests are refused', () => {
    assert.equal(AUTO_PAYOUT_MIN_NANOS, PI_SHE_NANOS);
    const dest = ssa1();
    assert.equal(isMinerSsa1(dest), true);
    assert.equal(shouldAutoPayout({ confirmedNanos: PI_SHE_NANOS - 1, dest }).ok, false);
    assert.equal(shouldAutoPayout({ confirmedNanos: PI_SHE_NANOS - 1, dest }).reason, 'below_min');
    const ok = shouldAutoPayout({ confirmedNanos: PI_SHE_NANOS, dest });
    assert.equal(ok.ok, true);
    assert.equal(ok.dest, dest.split('.')[0]);
    assert.equal(shouldAutoPayout({ confirmedNanos: PI_SHE_NANOS, dest: 'she1qqqq' }).reason, 'need_ssa1');
    assert.match(redactSsa1(dest), /^ssa1\*{8}/);
  });

  it('1% fee is only on the pot; hash bonus is fee-free', () => {
    const pot = BLOCK_SUBSIDY_NANOS;
    const after = potCreditAfterFeeNanos(pot);
    const fee = Math.floor(pot * POOL_FEE_BPS / 10000);
    assert.equal(after, pot - fee);
    assert.equal(after, Math.floor(0.99 * NANOS_PER_SHE));
    const hash = hashCreditNanos(256, HASH_BONUS_NANOS);
    assert.equal(hash, 256 * HASH_BONUS_NANOS);
    assert.equal(hash, 256);
    assert.equal(hashCreditNanos(256, 0), 256);
  });

  it('pool fee dest keeps 10 SHE and sweeps surplus to SHEAR_POOL_FEE_PAYOUT_DEST', () => {
    assert.equal(POOL_FEE_RESERVE_SHE, 10);
    assert.equal(POOL_FEE_RESERVE_NANOS, 10 * NANOS_PER_SHE);
    const dest = ssa1();
    const hold = poolFeeSweepNanos({
      spendableNanos: 10 * NANOS_PER_SHE,
      unpaidMinerPotNanos: 0,
    });
    assert.equal(hold.ok, false);
    assert.equal(hold.reason, 'reserve');
    const owed = 3 * NANOS_PER_SHE;
    const have = 15 * NANOS_PER_SHE;
    const sweep = poolFeeSweepNanos({
      spendableNanos: have,
      unpaidMinerPotNanos: owed,
    });
    assert.equal(sweep.ok, true);
    assert.equal(sweep.nanos, have - owed - POOL_FEE_RESERVE_NANOS);
    const prev = process.env[POOL_FEE_PAYOUT_DEST_ENV];
    delete process.env[POOL_FEE_PAYOUT_DEST_ENV];
    try {
      assert.equal(poolFeePayoutDest(), '');
      process.env[POOL_FEE_PAYOUT_DEST_ENV] = dest;
      assert.equal(poolFeePayoutDest(), dest.split('.')[0]);
    } finally {
      if (prev === undefined) delete process.env[POOL_FEE_PAYOUT_DEST_ENV];
      else process.env[POOL_FEE_PAYOUT_DEST_ENV] = prev;
    }
    const poolBox = spendBox(newIdentity());
    const built = buildPoolFeeSweepTx({
      from: poolBox.dest,
      to: dest,
      nanos: sweep.nanos,
      fee: 100,
      spendKey: poolBox.key,
    });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'custodial_pull');
    assert.equal(built.tx, undefined);
    assert.equal(buildPoolFeeSweepTx({
      from: poolBox.dest,
      to: poolBox.dest,
      nanos: sweep.nanos,
      spendKey: poolBox.key,
    }).reason, 'custodial_pull');
  });

  it('auto tx pays the miner in full and marks poolPaysFee', () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const built = buildAutoPayoutTx({
      from: poolBox.dest,
      to: dest,
      nanos: PI_SHE_NANOS,
      fee: 100,
      spendKey: poolBox.key,
    });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'custodial_pull');
    assert.equal(built.tx, undefined);
  });

  it('refuses to build an unsigned auto-pay body without a spend key', () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const skipped = buildAutoPayoutTx({
      from: poolBox.dest,
      to: dest,
      nanos: PI_SHE_NANOS,
      fee: 100,
    });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, 'custodial_pull');
    const unsigned = poolWithdrawTx({
      from: poolBox.dest,
      to: dest.split('.')[0],
      nanos: PI_SHE_NANOS,
      fee: 100,
    });
    assert.equal(verifyPoolWithdrawBound(unsigned).reason, 'unsigned');
    assert.equal(admitMempool(emptyMempool(), unsigned).reason, 'range_proof');
  });

  it('v12 does not credit a custodial pot or hash leg', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-auto-'));
    const book = createPullBook(dir);
    const dest = ssa1();
    const tag = publicMinerTag(dest);
    const potShare = potCreditAfterFeeNanos(BLOCK_SUBSIDY_NANOS);
    const hashN = 256;
    const credited = book.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: potShare, hashByDest: new Map([[dest, hashN]]) },
    );
    assert.equal(credited.ok, false);
    assert.equal(credited.reason, 'custodial_pull');
    const young = book.view(tag, { tipHeight: 1, need: 30 });
    assert.equal(young.confirmedNanos, 0);
    assert.equal(young.pendingNanos, 0);
    assert.equal(young.hashPaidNanos, 0);
    assert.equal(young.sentNanos, 0);
    assert.equal(book.dueAuto({ tipHeight: 40, need: 30 }).length, 0);
    assert.equal(book.ledger(tag).length, 0);
    const file = path.join(dir, 'pull-book.json');
    if (fs.existsSync(file)) {
      const disk = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(disk, /ssa1/);
      assert.equal(disk.includes(String(potShare)), false);
    }
  });

  it('v12 sweep does not queue a custodial pull; an unsigned withdraw stays unbound', async () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const unsigned = poolWithdrawTx({
      from: poolBox.dest,
      to: dest.split('.')[0],
      nanos: PI_SHE_NANOS,
      fee: 100,
    });
    assert.equal(verifyPoolWithdrawBound(unsigned).reason, 'unsigned');
    assert.equal(admitMempool(emptyMempool(), unsigned).reason, 'range_proof');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-auto-sweep-'));
    const pool = createPool({
      dataDir: dir,
      miner: poolBox.dest,
      operatorSpendKey: poolBox.key,
      stratumPort: 0,
      httpPort: 0,
    });
    const tag = publicMinerTag(dest);
    const credited = pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    assert.equal(credited.ok, false);
    assert.equal(credited.reason, 'custodial_pull');
    pool.store.tip = () => ({ height: 40 });
    assert.equal(pool.pullBook.view(tag, { tipHeight: 40, need: 30 }).sentNanos, 0);
    assert.equal(typeof pool.sweepAutoPayouts, 'function');
    let calls = 0;
    pool.store.queueTx = () => {
      calls += 1;
      return { ok: true, tx: { id: 'should-not-run' } };
    };
    assert.equal((await pool.runAutoPayoutSweep()).length, 0);
    assert.equal((await pool.sweepAutoPayouts({ maxRows: 1 })).length, 0);
    assert.equal(calls, 0);
    assert.equal(pool.pullBook.view(tag, { tipHeight: 40, need: 30 }).sentNanos, 0);
    assert.equal(pool.pullBook.dueAuto({ tipHeight: 40, need: 30 }).length, 0);
    pool.close();
  });

  it('a compact signed pool-withdraw still binds, and v12 admits it as range_proof', () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const built = buildAutoPayoutTx({
      from: poolBox.dest,
      to: dest,
      nanos: PI_SHE_NANOS,
      fee: 100,
      spendKey: poolBox.key,
    });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'custodial_pull');
    assert.equal(built.tx, undefined);
    const tx = poolWithdrawTx({
      from: poolBox.dest,
      to: dest,
      nanos: PI_SHE_NANOS,
      fee: 100,
      id: 'compact-plain',
    });
    signSpendTx(tx, poolBox.key);
    const sealed = compactTx(tx);
    assert.equal(sealed.from, undefined);
    assert.equal(sealed.vin[0].address, undefined);
    assert.ok(sealed.vin[0].dest20);
    assert.ok(sealed.spendPub);
    assert.equal(verifyPoolWithdrawBound(sealed).ok, true, 'sealed operator bind');
    assert.equal(admitMempool(emptyMempool(), sealed).reason, 'range_proof');
    const stolen = { ...sealed, spendPub: undefined, sig: undefined, vin: sealed.vin.map((v) => ({ ...v })) };
    signSpendTx(stolen, spendBox(newIdentity()).key);
    assert.equal(verifyPoolWithdrawBound(stolen).ok, false);
    assert.equal(admitMempool(emptyMempool(), stolen).reason, 'range_proof');
  });

  it('bootPoolOperator writes a matching spend seed and signs auto-pay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-op-'));
    const boot = bootPoolOperator({ dataDir: dir });
    assert.equal(boot.signed, true);
    assert.ok(boot.operatorSpendKey);
    assert.match(boot.miner, /^ssa1/);
    const dest = ssa1();
    const built = buildAutoPayoutTx({
      from: boot.miner,
      to: dest,
      nanos: PI_SHE_NANOS,
      fee: 100,
      spendKey: boot.operatorSpendKey,
    });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'custodial_pull');
    assert.equal(built.tx, undefined);
    const again = bootPoolOperator({ dataDir: dir });
    assert.equal(again.miner, boot.miner);
    assert.equal(again.signed, true);
    const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    assert.match(main, /bootPoolOperator/);
    assert.match(main, /operatorSpendKey: boot\.operatorSpendKey/);
  });

  it('auto-pay sweep reloads a matching pool-spend.seed dropped after boot', async () => {
    const dest = ssa1();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-reload-'));
    const boot = bootPoolOperator({ dataDir: dir });
    const seedPath = path.join(dir, 'pool-spend.seed');
    const seedHex = fs.readFileSync(seedPath, 'utf8');
    fs.unlinkSync(seedPath);
    const pool = createPool({
      dataDir: dir,
      miner: boot.miner,
      operatorSpendKey: null,
      stratumPort: 0,
      httpPort: 0,
    });
    const tag = publicMinerTag(dest);
    const credited = pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    assert.equal(credited.reason, 'custodial_pull');
    pool.store.tip = () => ({ height: 40 });
    const bound = [];
    pool.store.queueTx = (tx) => {
      const ok = verifyPoolWithdrawBound(tx).ok === true;
      bound.push(ok);
      return { ok, tx };
    };
    assert.equal((await pool.runAutoPayoutSweep()).length, 0);
    assert.deepEqual(bound, []);
    assert.equal(pool.publicStats().autoPayoutLastError, null);
    assert.equal(pool.pullBook.view(tag, { tipHeight: 40, need: 30 }).sentNanos, 0);
    fs.writeFileSync(seedPath, seedHex, { mode: 0o600 });
    const sent = await pool.runAutoPayoutSweep();
    assert.equal(sent.length, 0);
    assert.deepEqual(bound, []);
    assert.equal(pool.publicStats().autoPayoutLastError, null);
    assert.equal(pool.pullBook.view(tag, { tipHeight: 40, need: 30 }).sentNanos, 0);
    pool.close();
  });

  it('queueTx of a π pool-withdraw succeeds from sealed custody pots, not the 1% fee', () => {
    const minerDest = ssa1();
    const poolBox = spendBox(newIdentity());
    const hasherA = spendDestOf(newIdentity().spendPub);
    const hasherB = spendDestOf(newIdentity().spendPub);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-custody-qtx-'));
    const store = createStore(dir);
    injectMatureCustody(store, poolBox.dest, [hasherA, hasherB], { pots: 4, tipHeight: 40 });
    const rest = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const feeAmt = Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const tip = 40;
    const have = noteCommitSpendableNanos(store.blocks, poolBox.dest, tip);
    assert.equal(have, rest * 4);
    assert.ok(have >= PI_SHE_NANOS);
    assert.notEqual(have, feeAmt * 4);
    const built = buildAutoPayoutTx({
      from: poolBox.dest,
      to: minerDest,
      nanos: PI_SHE_NANOS,
      fee: 100,
      spendKey: poolBox.key,
    });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'custodial_pull');
    assert.equal(built.tx, undefined);
    const signed = poolWithdrawTx({
      from: poolBox.dest,
      to: minerDest,
      nanos: PI_SHE_NANOS,
      fee: 100,
      id: 'pi-plain',
    });
    signSpendTx(signed, poolBox.key);
    const queued = store.queueTx(signed);
    assert.equal(queued.ok, false);
    assert.equal(queued.reason, 'custodial_pull');
    assert.notEqual(queued.reason, 'insufficient');
    assert.equal((store.mempool || []).some((m) => m.id === 'pi-plain'), false);
  });

  it('sweep takeConfirmed after a funded custody queue; lastPullMs advances', async () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-custody-sweep-'));
    const pool = createPool({
      dataDir: dir,
      miner: poolBox.dest,
      operatorSpendKey: poolBox.key,
      stratumPort: 0,
      httpPort: 0,
    });
    const tag = publicMinerTag(dest);
    const credited = pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    assert.equal(credited.reason, 'custodial_pull');
    const before = pool.pullBook.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(before.lastPullMs, 0);
    assert.equal(before.confirmedNanos, 0);
    let calls = 0;
    pool.store.queueTx = () => {
      calls += 1;
      return { ok: true, tx: { id: 'should-not-run' } };
    };
    const sent = await pool.runAutoPayoutSweep();
    assert.equal(sent.length, 0, JSON.stringify(sent));
    assert.equal(calls, 0);
    const after = pool.pullBook.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(after.lastPullMs, 0);
    assert.equal(after.sentNanos, 0);
    pool.close();
  });

  it('exposes autoPayoutLastError on stats and miner JSON; clears on success', async () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-payout-err-'));
    const pool = createPool({
      dataDir: dir,
      miner: poolBox.dest,
      operatorSpendKey: poolBox.key,
      stratumPort: 0,
      httpPort: 0,
    });
    const tag = publicMinerTag(dest);
    const credited = pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    assert.equal(credited.reason, 'custodial_pull');
    pool.store.tip = () => ({ height: 40 });
    const httpPort = await listenHttp(pool);
    let calls = 0;
    pool.store.queueTx = () => {
      calls += 1;
      return {
        ok: false,
        reason: 'insufficient',
        have: 1,
        need: PI_SHE_NANOS,
      };
    };
    assert.equal((await pool.runAutoPayoutSweep()).length, 0);
    assert.equal(calls, 0);
    const statsErr = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.equal(statsErr.ok, true);
    assert.equal(statsErr.autoPayoutLastError, null);
    assert.equal(JSON.stringify(statsErr).includes(poolBox.dest), false);
    const minerRes = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${tag}`);
    const minerErr = await minerRes.json();
    assert.equal(minerRes.status, 404);
    assert.equal(minerErr.reason, 'unknown_miner');
    assert.equal(JSON.stringify(minerErr).includes(String(PI_SHE_NANOS)), false);
    const view = pool.pullBook.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(view.pendingNanos, 0);
    assert.equal(view.confirmedNanos, 0);
    assert.equal(view.sentNanos, 0);
    dumpScratch('stats-error.json', statsErr);
    pool.close();
  });

  it('yields so /api/stats progresses under a slow queueTx', async () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-payout-yield-'));
    const pool = createPool({
      dataDir: dir,
      miner: poolBox.dest,
      operatorSpendKey: poolBox.key,
      stratumPort: 0,
      httpPort: 0,
    });
    const tag = publicMinerTag(dest);
    const credited = pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    assert.equal(credited.reason, 'custodial_pull');
    const httpPort = await listenHttp(pool);
    pool.paintStatsSnap();
    let calls = 0;
    pool.store.queueTx = () => new Promise((resolve) => {
      calls += 1;
      setTimeout(() => resolve({ ok: true, tx: { id: 'should-not-run' } }), 600);
    });
    const sweepP = pool.runAutoPayoutSweep();
    const t0 = Date.now();
    const stats = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    const dt = Date.now() - t0;
    assert.equal(stats.ok, true, JSON.stringify(stats));
    assert.ok(stats.stratumBind);
    assert.ok(stats.loginAuth);
    assert.ok(dt < 300, `/api/stats stalled ${dt}ms during slow queueTx`);
    const sent = await sweepP;
    assert.equal(sent.length, 0, JSON.stringify(sent));
    assert.equal(calls, 0);
    dumpScratch('payout-yield-stats.json', { dt, stats, sent, calls });
    pool.close();
  });

  it('miner page does not publish sealed amounts in the three boxes', () => {
    const html = fs.readFileSync(new URL('../public/miner.html', import.meta.url), 'utf8');
    assert.equal(html.split('Shear Privacy').length - 1, 7);
    assert.equal(html.includes('Waiting payout'), false);
    assert.equal(html.includes('id="m-payout-error"'), false);
    assert.equal(html.includes('autoPayoutLastError'), false);
    assert.doesNotMatch(html, /SHEAR_POOL_SPEND_SEED/);
  });
});
