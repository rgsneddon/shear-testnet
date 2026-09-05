import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { createPullBook, PULL_COOLDOWN_MS, potCreditNanos } from '../src/pull_book.js';
import { publicMinerTag } from '../src/pool.js';

describe('pool pull book', () => {
  it('credits 0.99 by work, withdraws confirmed only, then cools down 24h', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pull-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(id.paymentCode);
    assert.equal(potCreditNanos(), Math.floor(0.99 * NANOS_PER_SHE));
    assert.equal(PULL_COOLDOWN_MS, 24 * 60 * 60 * 1000);
    assert.notEqual(PULL_COOLDOWN_MS, 90 * 60 * 60 * 1000);
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
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'cooldown');
    const tooSoon = book.takeConfirmed(tag, { tipHeight: 40, need: 30, now: 1_000 + PULL_COOLDOWN_MS - 1 });
    assert.equal(tooSoon.reason, 'cooldown');
    const later = book.takeConfirmed(tag, { tipHeight: 40, need: 30, now: 1_000 + PULL_COOLDOWN_MS });
    assert.equal(later.ok, true);
    assert.equal(later.nanos, half);
  });
});
