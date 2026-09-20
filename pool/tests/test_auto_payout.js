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
  isMinerSsa1,
  redactSsa1,
  shouldAutoPayout,
  buildAutoPayoutTx,
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
    assert.equal(built.ok, true, built.reason);
    assert.equal(built.tx.nanos, PI_SHE_NANOS);
    assert.equal(built.tx.fee, 100);
    assert.equal(built.tx.sponsor, poolBox.dest);
    assert.equal(built.tx.poolPaysFee, true);
    assert.equal(built.tx.to, dest.split('.')[0]);
    assert.equal(built.tx.from, poolBox.dest);
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
    assert.equal(skipped.reason, 'need_spend_key');
    const unsigned = poolWithdrawTx({
      from: poolBox.dest,
      to: dest.split('.')[0],
      nanos: PI_SHE_NANOS,
      fee: 100,
    });
    assert.equal(verifyPoolWithdrawBound(unsigned).reason, 'unsigned');
    assert.equal(admitMempool(emptyMempool(), unsigned).reason, 'unsigned');
  });

  it('credits pot after fee plus hash bonus; auto-pays at π; sentNanos is all-time pulled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-auto-'));
    const book = createPullBook(dir);
    const dest = ssa1();
    const tag = publicMinerTag(dest);
    const potShare = potCreditAfterFeeNanos(BLOCK_SUBSIDY_NANOS);
    const hashN = 256;
    assert.equal(book.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: potShare, hashByDest: new Map([[dest, hashN]]) },
    ).ok, true);
    const young = book.view(tag, { tipHeight: 1, need: 30 });
    assert.equal(young.confirmedNanos, 0);
    assert.equal(young.hashPaidNanos, hashN);
    assert.equal(young.sentNanos, hashN);
    const ripe = book.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(ripe.confirmedNanos, potShare);
    assert.equal(ripe.confirmedHashNanos, hashN);
    assert.equal(ripe.hashPaidNanos, hashN);
    assert.ok(ripe.confirmedPotNanos <= potShare);
    assert.equal(ripe.sentNanos, hashN);
    const wouldFeeHash = Math.floor(hashN * POOL_FEE_BPS / 10000);
    assert.ok(wouldFeeHash > 0);
    assert.equal(ripe.confirmedHashNanos, hashN);
    const due = book.dueAuto({ tipHeight: 40, need: 30 });
    if (ripe.confirmedNanos >= PI_SHE_NANOS) {
      assert.equal(due.length, 1);
      assert.equal(due[0].dest, dest.split('.')[0]);
      const taken = book.takeConfirmed(tag, {
        tipHeight: 40,
        need: 30,
        amountNanos: due[0].nanos,
        skipCooldown: true,
      });
      assert.equal(taken.ok, true);
      const after = book.view(tag, { tipHeight: 40, need: 30 });
      assert.equal(after.sentNanos, taken.nanos + hashN);
      assert.match(after.destRedacted, /^ssa1\*{8}/);
    } else {
      assert.equal(due.length, 0);
      book.creditRound(
        [{ tag, dest, count: 10 }],
        { height: 2, nanos: PI_SHE_NANOS, hashByDest: new Map() },
      );
      const later = book.view(tag, { tipHeight: 40, need: 30 });
      assert.ok(later.confirmedNanos >= PI_SHE_NANOS);
      const pay = book.dueAuto({ tipHeight: 40, need: 30 });
      assert.equal(pay.length, 1);
      const taken = book.takeConfirmed(tag, {
        tipHeight: 40,
        need: 30,
        amountNanos: pay[0].nanos,
        skipCooldown: true,
      });
      assert.equal(taken.ok, true);
      const sent = book.view(tag, { tipHeight: 40, need: 30 });
      assert.equal(sent.sentNanos, taken.nanos + hashN);
    }
    const disk = fs.readFileSync(path.join(dir, 'pull-book.json'), 'utf8');
    assert.doesNotMatch(disk, /ssa1/);
  });

  it('bound auto-pay credits pulled only after successful queueTx; unsigned is refused', async () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const unsigned = poolWithdrawTx({
      from: poolBox.dest,
      to: dest.split('.')[0],
      nanos: PI_SHE_NANOS,
      fee: 100,
    });
    assert.equal(verifyPoolWithdrawBound(unsigned).reason, 'unsigned');
    assert.equal(admitMempool(emptyMempool(), unsigned).reason, 'unsigned');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-auto-sweep-'));
    const pool = createPool({
      dataDir: dir,
      miner: poolBox.dest,
      operatorSpendKey: poolBox.key,
      stratumPort: 0,
      httpPort: 0,
    });
    const tag = publicMinerTag(dest);
    pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    pool.store.tip = () => ({ height: 40 });
    const before = pool.pullBook.view(tag, { tipHeight: 40, need: 30 }).sentNanos;
    assert.equal(typeof pool.sweepAutoPayouts, 'function');
    pool.store.queueTx = () => ({ ok: false, reason: 'forced' });
    assert.equal((await pool.runAutoPayoutSweep()).length, 0);
    assert.equal((await pool.sweepAutoPayouts({ maxRows: 1 })).length, 0);
    assert.equal(pool.pullBook.view(tag, { tipHeight: 40, need: 30 }).sentNanos, before);
    pool.store.queueTx = (tx) => {
      assert.equal(verifyPoolWithdrawBound(tx).ok, true);
      return { ok: true, tx };
    };
    const sent = await pool.runAutoPayoutSweep();
    assert.equal(sent.length, 1);
    assert.ok(pool.pullBook.view(tag, { tipHeight: 40, need: 30 }).sentNanos > before);
    pool.close();
  });

  it('compact pool-withdraw keeps operator dest20; a foreign spendPub is rejected', () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const built = buildAutoPayoutTx({
      from: poolBox.dest,
      to: dest,
      nanos: PI_SHE_NANOS,
      fee: 100,
      spendKey: poolBox.key,
    });
    assert.equal(built.ok, true, built.reason);
    const sealed = compactTx(built.tx);
    assert.equal(sealed.from, undefined);
    assert.equal(sealed.vin[0].address, undefined);
    assert.ok(sealed.vin[0].dest20);
    assert.ok(sealed.spendPub);
    assert.equal(verifyPoolWithdrawBound(sealed).ok, true, 'sealed operator bind');
    assert.equal(admitMempool(emptyMempool(), sealed).ok, true);
    const stolen = { ...sealed, spendPub: undefined, sig: undefined, vin: sealed.vin.map((v) => ({ ...v })) };
    signSpendTx(stolen, spendBox(newIdentity()).key);
    assert.equal(verifyPoolWithdrawBound(stolen).ok, false);
    assert.equal(admitMempool(emptyMempool(), stolen).reason, 'unsigned');
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
    assert.equal(built.ok, true, built.reason);
    const sealed = compactTx(built.tx);
    assert.equal(verifyPoolWithdrawBound(sealed).ok, true);
    assert.equal(admitMempool(emptyMempool(), sealed).ok, true);
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
    pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    pool.store.tip = () => ({ height: 40 });
    const bound = [];
    pool.store.queueTx = (tx) => {
      const ok = verifyPoolWithdrawBound(tx).ok === true;
      bound.push(ok);
      return { ok, tx };
    };
    assert.equal((await pool.runAutoPayoutSweep()).length, 0);
    assert.deepEqual(bound, []);
    const skipped = pool.publicStats().autoPayoutLastError;
    assert.equal(skipped?.reason, 'unsigned');
    assert.equal(skipped?.tag, tag);
    assert.match(skipped.fromRedacted, /^ssa1\*{8}/);
    assert.equal(JSON.stringify(skipped).includes(boot.miner), false);
    fs.writeFileSync(seedPath, seedHex, { mode: 0o600 });
    const sent = await pool.runAutoPayoutSweep();
    assert.equal(sent.length, 1);
    assert.deepEqual(bound, [true]);
    assert.equal(pool.publicStats().autoPayoutLastError, null);
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
    assert.equal(built.ok, true, built.reason);
    assert.equal(built.tx.vin?.[0]?.commit, undefined);
    const queued = store.queueTx(built.tx);
    assert.equal(queued.ok, true, queued.reason);
    assert.notEqual(queued.reason, 'insufficient');
  });

  it('sweep takeConfirmed after a funded custody queue; lastPullMs advances', async () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const hasherA = spendDestOf(newIdentity().spendPub);
    const hasherB = spendDestOf(newIdentity().spendPub);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-custody-sweep-'));
    const pool = createPool({
      dataDir: dir,
      miner: poolBox.dest,
      operatorSpendKey: poolBox.key,
      stratumPort: 0,
      httpPort: 0,
    });
    injectMatureCustody(pool.store, poolBox.dest, [hasherA, hasherB], { pots: 4, tipHeight: 40 });
    const tag = publicMinerTag(dest);
    pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    const before = pool.pullBook.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(before.lastPullMs, 0);
    assert.ok(before.confirmedNanos >= PI_SHE_NANOS);
    const sent = await pool.runAutoPayoutSweep();
    assert.equal(sent.length, 1, JSON.stringify(sent));
    const after = pool.pullBook.view(tag, { tipHeight: 40, need: 30 });
    assert.ok(after.lastPullMs > 0);
    assert.ok(after.sentNanos >= PI_SHE_NANOS);
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
    pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    pool.store.tip = () => ({ height: 40 });
    const httpPort = await listenHttp(pool);
    pool.store.queueTx = () => ({
      ok: false,
      reason: 'insufficient',
      have: 1,
      need: PI_SHE_NANOS,
    });
    assert.equal((await pool.runAutoPayoutSweep()).length, 0);
    const statsErr = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.equal(statsErr.autoPayoutLastError?.reason, 'insufficient');
    assert.equal(statsErr.autoPayoutLastError?.tag, tag);
    assert.equal(typeof statsErr.autoPayoutLastError?.at, 'number');
    assert.match(statsErr.autoPayoutLastError.fromRedacted, /^ssa1\*{8}/);
    assert.equal(JSON.stringify(statsErr.autoPayoutLastError).includes(poolBox.dest), false);
    assert.equal(JSON.stringify(statsErr.autoPayoutLastError).includes('spend'), false);
    const minerErr = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${tag}`).then((r) => r.json());
    assert.equal(minerErr.autoPayoutLastError?.reason, 'insufficient');
    dumpScratch('stats-error.json', statsErr);
    pool.store.queueTx = (tx) => {
      assert.equal(verifyPoolWithdrawBound(tx).ok, true);
      return { ok: true, tx };
    };
    assert.equal((await pool.runAutoPayoutSweep()).length, 1);
    const statsOk = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
    assert.equal(statsOk.autoPayoutLastError, null);
    const minerOk = await fetch(`http://127.0.0.1:${httpPort}/api/miners/${tag}`).then((r) => r.json());
    assert.equal(minerOk.autoPayoutLastError, undefined);
    dumpScratch('stats-ok.json', statsOk);
    pool.close();
  });

  it('yields so /api/stats progresses under a slow queueTx', async () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const hasherA = spendDestOf(newIdentity().spendPub);
    const hasherB = spendDestOf(newIdentity().spendPub);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-payout-yield-'));
    const pool = createPool({
      dataDir: dir,
      miner: poolBox.dest,
      operatorSpendKey: poolBox.key,
      stratumPort: 0,
      httpPort: 0,
    });
    injectMatureCustody(pool.store, poolBox.dest, [hasherA, hasherB], { pots: 4, tipHeight: 40 });
    const tag = publicMinerTag(dest);
    pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    const httpPort = await listenHttp(pool);
    pool.paintStatsSnap();
    const orig = pool.store.queueTx.bind(pool.store);
    pool.store.queueTx = (tx) => new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(verifyPoolWithdrawBound(tx).ok, true);
        resolve(orig(tx));
      }, 600);
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
    assert.equal(sent.length, 1, JSON.stringify(sent));
    dumpScratch('payout-yield-stats.json', { dt, stats, sent });
    pool.close();
  });

  it('miner page paints a muted auto-payout error under Waiting payout', () => {
    const html = fs.readFileSync(new URL('../public/miner.html', import.meta.url), 'utf8');
    const waiting = html.indexOf('Waiting payout');
    const errId = html.indexOf('id="m-payout-error"');
    assert.ok(waiting >= 0);
    assert.ok(errId > waiting);
    assert.match(html, /payout-err/);
    assert.match(html, /autoPayoutLastError/);
    assert.match(html, /why === 'insufficient' \|\| why === 'unsigned'/);
    assert.doesNotMatch(html, /SHEAR_POOL_SPEND_SEED/);
  });
});
