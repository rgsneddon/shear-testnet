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
  it('credits 0.99 by work, withdraws confirmed only, then cools down 90h', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pull-'));
    const book = createPullBook(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tag = publicMinerTag(id.paymentCode);
    assert.equal(potCreditNanos(), Math.floor(0.99 * NANOS_PER_SHE));
    assert.equal(book.creditRound([
      { tag, dest, count: 10 },
    ], { height: 1, now: 1 }).ok, true);
    const young = book.view(tag, { tipHeight: 2, need: 30 });
    assert.equal(young.confirmedNanos, 0);
    assert.equal(young.unconfirmedNanos, potCreditNanos());
    const ripe = book.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(ripe.confirmedNanos, potCreditNanos());
    const taken = book.takeConfirmed(tag, { tipHeight: 40, need: 30, now: 1_000 });
    assert.equal(taken.ok, true);
    assert.equal(taken.nanos, potCreditNanos());
    const after = book.view(tag, { tipHeight: 40, need: 30 });
    assert.equal(after.confirmedNanos, 0);
    assert.equal(after.pendingNanos, 0);
    const again = book.takeConfirmed(tag, { tipHeight: 40, need: 30, now: 1_000 + 60_000 });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'cooldown');
    assert.equal(PULL_COOLDOWN_MS, 90 * 60 * 60 * 1000);
    const later = book.takeConfirmed(tag, { tipHeight: 40, need: 30, now: 1_000 + PULL_COOLDOWN_MS });
    assert.equal(later.reason, 'none_confirmed');
  });
});
