import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress, spendDestOf, destOpeningFromView } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { createPullBook, PULL_COOLDOWN_MS, potCreditNanos, attributedPoolFeeNanos } from '../src/pull_book.js';
import { publicMinerTag } from '../src/pool.js';
import { handleWalletApi, owedPiFromPullBook } from '../src/wallet_api.js';
import { AUTO_PAYOUT_MIN_NANOS } from '../src/auto_payout.js';

describe('pool pull book', () => {
  it('v12 refuses a custodial pot credit for any amount', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pull-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(id.paymentCode);
    assert.equal(potCreditNanos(), Math.floor(0.99 * NANOS_PER_SHE));
    assert.equal(PULL_COOLDOWN_MS, 0);
    const amounts = [1, AUTO_PAYOUT_MIN_NANOS - 1, AUTO_PAYOUT_MIN_NANOS, potCreditNanos(), potCreditNanos() * 2];
    for (const nanos of amounts) {
      const credited = book.creditRound([{ tag, dest, count: 10 }], { height: 1, nanos, now: 1 });
      assert.equal(credited.ok, false, String(nanos));
      assert.equal(credited.reason, 'custodial_pull');
    }
    const young = book.view(tag, { tipHeight: 2, need: 30 });
    assert.equal(young.confirmedNanos, 0);
    assert.equal(young.unconfirmedNanos, 0);
    assert.equal(young.pendingNanos, 0);
    assert.equal(young.sentNanos, 0);
    const taken = book.takeConfirmed(tag, { tipHeight: 40, need: 30, now: 1_000, amountNanos: 1 });
    assert.equal(taken.ok, false);
    assert.equal(taken.reason, 'none_confirmed');
    const file = path.join(dir, 'pull-book.json');
    if (fs.existsSync(file)) {
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal((disk.credits || []).length, 0);
      assert.doesNotMatch(JSON.stringify(disk), /ssa1/);
    }
  });

  it('v12 ledger stays empty and the fee helper is unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ledger-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(dest);
    const pot = potCreditNanos();
    const hashN = 256;
    assert.equal(attributedPoolFeeNanos(pot), Math.floor(NANOS_PER_SHE * 0.01));
    const credited = book.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 7, nanos: pot, hashByDest: new Map([[dest, hashN]]) },
    );
    assert.equal(credited.reason, 'custodial_pull');
    assert.equal(book.ledger(tag).length, 0);
    assert.equal(book.view(tag, { tipHeight: 40, need: 30 }).hashPaidNanos, 0);
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
    assert.equal(again.view(tag).pendingNanos, 0);
  });

  it('a dest-less login is not credited on v12', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-nodest-'));
    const book = createPullBook(dir);
    const tag = publicMinerTag('not-a-dest.worker');
    const credited = book.creditRound(
      [{ tag, dest: '', count: 10 }],
      { height: 3, nanos: potCreditNanos() },
    );
    assert.equal(credited.reason, 'custodial_pull');
    const v = book.view(tag, { tipHeight: 3, need: 30 });
    assert.equal(v.pendingNanos, 0);
    assert.equal(v.dest, '');
    assert.equal(book.ledger(tag).length, 0);
    assert.equal(book.dueAuto({ tipHeight: 40, need: 30 }).length, 0);
  });

  it('a split across several miners does not land in the pull book', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-split-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const paid = publicMinerTag(dest);
    const held = publicMinerTag('ssa1qincomplete.ubuntu-noel');
    const pot = potCreditNanos();
    const credited = book.creditRound([
      { tag: paid, dest, count: 70 },
      { tag: held, dest: '', count: 30 },
    ], { height: 5, nanos: pot, finderTag: held });
    assert.equal(credited.reason, 'custodial_pull');
    const a = book.view(paid, { tipHeight: 5, need: 30 });
    const b = book.view(held, { tipHeight: 5, need: 30 });
    assert.equal(a.pendingNanos, 0);
    assert.equal(b.pendingNanos, 0);
    assert.equal(a.foundBlocks, 0);
    assert.equal(b.foundBlocks, 0);
    assert.equal(book.dueAuto({ tipHeight: 40, need: 30 }).length, 0);
    const rec = book.reconcile({ potAfterFeeNanos: pot });
    assert.equal(rec.sealsLifetime, 0);
    assert.equal(rec.potCreditsNanos, 0);
  });

  it('sentNanos stays zero when nothing was credited', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-sent-all-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(dest);
    const pot = potCreditNanos();
    assert.equal(book.creditRound([{ tag, dest, count: 10 }], { height: 1, nanos: pot }).reason, 'custodial_pull');
    const ripe = book.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(ripe.sentNanos, 0);
    assert.equal(ripe.confirmedNanos, 0);
    const taken = book.takeConfirmed(tag, { tipHeight: 40, need: 30, skipCooldown: true });
    assert.equal(taken.reason, 'none_confirmed');
  });

  it('viewByDest and GET /api/wallet/balance emit zero owedPi on v12', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-owed-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = spendDestOf(id.spendPub);
    const tag = publicMinerTag(dest);
    const pot = potCreditNanos();
    assert.ok(pot > 0);
    assert.equal(book.creditRound([{ tag, dest, count: 10 }], { height: 1, nanos: pot, now: 1 }).reason, 'custodial_pull');
    const byDest = book.viewByDest(dest, { tipHeight: 2, need: 30 });
    const byTag = book.view(tag, { tipHeight: 2, need: 30 });
    assert.equal(byDest.pendingNanos, 0);
    assert.equal(byTag.pendingNanos, 0);
    assert.equal(byDest.unconfirmedNanos, 0);
    const store = { tip: () => ({ height: 2 }), getpolicy: () => ({ operational: { pool_merchant: 30 } }) };
    const bareUrl = new URL(`http://127.0.0.1/api/wallet/balance?address=${dest}`);
    const bare = handleWalletApi(bareUrl, 'GET', {}, { store, miners: new Map(), pullBook: book, queueSend: () => ({}) });
    assert.equal(bare.status, 401);
    assert.equal(bare.json.reason, 'dest_hold');
    assert.equal(bare.json.balance, undefined);
    assert.equal(bare.json.owedPi, undefined);
    const open = destOpeningFromView(id.viewKey, id.spendPub);
    const url = new URL(`http://127.0.0.1/api/wallet/balance?address=${dest}&open=${open}`);
    const a = handleWalletApi(url, 'GET', {}, { store, miners: new Map(), pullBook: book, queueSend: () => ({}) });
    const b = handleWalletApi(url, 'GET', {}, { store, miners: new Map(), pullBook: book, queueSend: () => ({}) });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const fields = owedPiFromPullBook(book, dest, { tipHeight: 2, need: 30 });
    assert.equal(fields.owedPi, 0);
    assert.equal(fields.confirmingPot, 0);
    assert.equal(a.json.owedPi, 0);
    assert.equal(a.json.confirmingPot, 0);
    assert.equal(b.json.owedPi, 0);
    assert.equal(b.json.confirmingPot, 0);
  });
});
