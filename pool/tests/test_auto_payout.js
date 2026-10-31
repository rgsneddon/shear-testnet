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
  potCreditAfterFeeNanos,
  hashCreditNanos,
} from '../src/auto_payout.js';
import { createPullBook } from '../src/pull_book.js';
import { publicMinerTag } from '../src/pool.js';

function ssa1() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

/**
 * Miners are paid from the coinbase (R14a). What is left here are the pure
 * figures the pool pages and the coinbase split share; no payout is built
 * (pool/tests/test_no_custodial_pull.js).
 */
describe('miner payout figures', () => {
  it('the π SHE figure stands; she1 dests are never miner payout dests', () => {
    assert.equal(AUTO_PAYOUT_MIN_NANOS, PI_SHE_NANOS);
    const dest = ssa1();
    assert.equal(isMinerSsa1(dest), true);
    assert.equal(isMinerSsa1('she1qqqq'), false);
    assert.equal(isMinerSsa1(''), false);
    assert.match(redactSsa1(dest), /^ssa1\*{8}/);
    assert.equal(redactSsa1('she1qqqq'), 'ssa1********');
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
    // A voted unit of 0 is bonus off (cfe93bf5). Only a malformed unit clamps to 1.
    assert.equal(hashCreditNanos(256, 0), 0);
    assert.equal(hashCreditNanos(256, 0n), 0);
    assert.equal(hashCreditNanos(256, -1), 256);
    assert.equal(hashCreditNanos(256, undefined), 256);
  });

  it('the pull book credits no pot or hash leg', () => {
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
    assert.equal(book.ledger(tag).length, 0);
    const file = path.join(dir, 'pull-book.json');
    if (fs.existsSync(file)) {
      const disk = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(disk, /ssa1/);
      assert.equal(disk.includes(String(potShare)), false);
    }
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
