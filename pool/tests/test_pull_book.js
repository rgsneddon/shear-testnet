import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { createPullBook, PULL_COOLDOWN_MS, potCreditNanos, attributedPoolFeeNanos } from '../src/pull_book.js';
import { publicMinerTag } from '../src/pool.js';

describe('pool pull book', () => {
  it('credits 0.99 by work, withdraws confirmed only, no 24h cooldown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pull-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(id.paymentCode);
    assert.equal(potCreditNanos(), Math.floor(0.99 * NANOS_PER_SHE));
    assert.equal(PULL_COOLDOWN_MS, 0);
    assert.equal(book.creditRound([
      { tag, dest, count: 10 },
    ], { height: 1, now: 1 }).ok, true);
    assert.equal(book.creditRound([
      { tag, dest, count: 10 },
    ], { height: 2, now: 2 }).ok, true);
    const young = book.view(tag, { tipHeight: 2, need: 30 });
    assert.equal(young.confirmedNanos, 0);
    assert.equal(young.unconfirmedNanos, 2 * potCreditNanos());
    const ripe = book.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(ripe.confirmedNanos, 2 * potCreditNanos());
    const half = potCreditNanos();
    const taken = book.takeConfirmed(tag, { tipHeight: 40, need: 30, now: 1_000, amountNanos: half });
    assert.equal(taken.ok, true);
    assert.equal(taken.nanos, half);
    const after = book.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(after.confirmedNanos, half);
    const again = book.takeConfirmed(tag, { tipHeight: 40, need: 30, now: 1_000 + 60_000 });
    assert.equal(again.ok, true, again.reason);
    assert.equal(again.nanos, half);
    const disk = fs.readFileSync(path.join(dir, 'pull-book.json'), 'utf8');
    assert.doesNotMatch(disk, /ssa1/);
    assert.doesNotMatch(disk, /"dest"/);
    assert.equal(JSON.parse(disk).credits.every((c) => c.dest == null), true);
  });

  it('ledger groups pot and hash bonus per height and attributes 1% fee on pot only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ledger-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(dest);
    const pot = potCreditNanos();
    const hashN = 256;
    assert.equal(book.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 7, nanos: pot, hashByDest: new Map([[dest, hashN]]) },
    ).ok, true);
    const rows = book.ledger(tag);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].height, 7);
    assert.equal(rows[0].blockRwdNanos, pot);
    assert.equal(rows[0].hashBonusNanos, hashN);
    assert.equal(rows[0].poolFeeNanos, attributedPoolFeeNanos(pot));
    assert.equal(rows[0].totalNanos, pot + hashN);
    assert.equal(rows[0].poolFeeNanos, Math.floor(NANOS_PER_SHE * 0.01));
    assert.equal(rows[0].dest, undefined);
  });

  it('bindDest records ssa1 before any found block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bind-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(dest);
    assert.equal(book.view(tag).dest, '');
    assert.equal(book.bindDest(tag, dest), true);
    assert.equal(book.view(tag).dest, dest);
    const again = createPullBook(dir);
    assert.ok(again.view(tag).dest);
    assert.equal(
      Buffer.from(hash20FromAddress(again.view(tag).dest)).equals(Buffer.from(hash20FromAddress(dest))),
      true,
    );
  });

  it('books work for a dest-less login so admin can pay the tag later', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-nodest-'));
    const book = createPullBook(dir);
    const tag = publicMinerTag('not-a-dest.worker');
    assert.equal(book.creditRound(
      [{ tag, dest: '', count: 10 }],
      { height: 3, nanos: potCreditNanos() },
    ).ok, true);
    const v = book.view(tag, { tipHeight: 3, need: 30 });
    assert.ok(v.pendingNanos > 0);
    assert.equal(v.dest, '');
    const rows = book.ledger(tag);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].blockRwdNanos > 0);
    const due = book.dueAuto({ tipHeight: 40, need: 30 });
    assert.equal(due.some((d) => d.tag === tag), false);
  });

  it('splits one pot across dest and dest-less work; finder without dest is still counted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-split-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const paid = publicMinerTag(dest);
    const held = publicMinerTag('ssa1qincomplete.ubuntu-noel');
    const pot = potCreditNanos();
    assert.equal(book.creditRound([
      { tag: paid, dest, count: 70 },
      { tag: held, dest: '', count: 30 },
    ], { height: 5, nanos: pot, finderTag: held }).ok, true);
    const a = book.view(paid, { tipHeight: 5, need: 30 });
    const b = book.view(held, { tipHeight: 5, need: 30 });
    assert.equal(a.pendingNanos + b.pendingNanos, pot);
    assert.equal(b.pendingNanos, Math.floor(pot * 30 / 100));
    assert.equal(a.pendingNanos, pot - b.pendingNanos);
    assert.equal(b.foundBlocks, 1);
    assert.equal(a.foundBlocks, 0);
    assert.equal(book.dueAuto({ tipHeight: 40, need: 30 }).some((d) => d.tag === held), false);
    const rec = book.reconcile({ potAfterFeeNanos: pot });
    assert.equal(rec.sealsLifetime, 1);
    assert.equal(rec.potCreditsNanos, pot);
    assert.equal(rec.ok, true);
  });

  it('sentNanos is all-time pulled, not 30-conf after the payout height', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-sent-all-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(dest);
    const pot = potCreditNanos();
    assert.equal(book.creditRound([{ tag, dest, count: 10 }], { height: 1, nanos: pot }).ok, true);
    const ripe = book.view(tag, { tipHeight: 40, need: 30 });
    const taken = book.takeConfirmed(tag, { tipHeight: 40, need: 30, skipCooldown: true });
    assert.equal(taken.ok, true);
    const sameTip = book.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(sameTip.sentNanos, taken.nanos);
    assert.equal(sameTip.confirmedNanos, 0);
  });
});
