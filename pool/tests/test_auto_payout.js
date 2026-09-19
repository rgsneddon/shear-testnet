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
    const pool = ssa1();
    const built = buildAutoPayoutTx({
      from: pool,
      to: dest,
      nanos: PI_SHE_NANOS,
      fee: 100,
    });
    assert.equal(built.ok, true, built.reason);
    assert.equal(built.tx.nanos, PI_SHE_NANOS);
    assert.equal(built.tx.fee, 100);
    assert.equal(built.tx.sponsor, pool);
    assert.equal(built.tx.poolPaysFee, true);
    assert.equal(built.tx.to, dest.split('.')[0]);
    assert.equal(built.tx.from, pool);
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

  it('bound auto-pay credits pulled only after successful queueTx; unsigned is refused', () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const unsigned = buildAutoPayoutTx({ from: poolBox.dest, to: dest, nanos: PI_SHE_NANOS, fee: 100 });
    assert.equal(unsigned.ok, true);
    assert.equal(verifyPoolWithdrawBound(unsigned.tx).reason, 'unsigned');
    assert.equal(admitMempool(emptyMempool(), unsigned.tx).reason, 'unsigned');
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
    pool.store.queueTx = () => ({ ok: false, reason: 'forced' });
    assert.equal(pool.runAutoPayoutSweep().length, 0);
    assert.equal(pool.pullBook.view(tag, { tipHeight: 40, need: 30 }).sentNanos, before);
    pool.store.queueTx = (tx) => {
      assert.equal(verifyPoolWithdrawBound(tx).ok, true);
      return { ok: true, tx };
    };
    const sent = pool.runAutoPayoutSweep();
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
});
