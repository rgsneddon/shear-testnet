/**
 * No custodial pull on any book. Miners are paid from the coinbase (R14a):
 * the pool holds no miner money, builds no payout, runs no sweep. There is
 * no magic switch left to turn it back on; the path is gone, not gated.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_SHE_NANOS } from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { RESERVE_BOOKS, MAGIC_TESTNET, MAGIC_MAINNET } from '../../crypto/reserve_books.js';
import { MAGIC_REGTEST } from '../../crypto/regtest_bits.js';
import { signSpendTx } from '../../crypto/spend.js';
import * as autoPayout from '../src/auto_payout.js';
import { createPullBook } from '../src/pull_book.js';
import { configuredFeeIdentity, createPool, publicMinerTag } from '../src/pool.js';
import { spendBox } from '../../tests/spend_box.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const POOL_FILES = ['pool/src/auto_payout.js', 'pool/src/pull_book.js', 'pool/src/pool.js', 'pool/src/wallet_api.js'];
const FEE = configuredFeeIdentity().feeDest;

/** Every book this tree knows: each testnet, mainnet, regtest. */
const MAGICS = [...new Set([...RESERVE_BOOKS.map((b) => b.magic), MAGIC_TESTNET, MAGIC_MAINNET, MAGIC_REGTEST])];

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

describe('no custodial pull on any book', () => {
  it('there is no magic switch: custodialPullAllowed is gone from the pool', () => {
    assert.ok(MAGICS.length >= 3, 'testnet, mainnet and regtest at least');
    assert.equal(autoPayout.custodialPullAllowed, undefined);
    for (const file of POOL_FILES) {
      assert.doesNotMatch(read(file), /custodialPullAllowed/, file);
    }
  });

  it('the pool builds no custodial payout and runs no sweep', () => {
    assert.equal(autoPayout.buildAutoPayoutTx, undefined);
    assert.equal(autoPayout.buildPoolFeeSweepTx, undefined);
    assert.equal(autoPayout.poolFeeSweepNanos, undefined);
    for (const file of POOL_FILES) {
      assert.doesNotMatch(
        read(file),
        /poolWithdrawTx|buildAutoPayoutTx|buildPoolFeeSweepTx|sweepAutoPayouts|runAutoPayoutSweep|dueAuto|sweepAuto\b|refreshOperatorSpendKey/,
        file,
      );
    }
    assert.equal(fs.existsSync(path.join(ROOT, 'pool/src/operator_wallet.js')), false, 'no operator balance view');
    const api = read('pool/src/wallet_api.js');
    assert.doesNotMatch(api, /if \(false && path === '\/api\/pool\/withdraw'/, 'no dead withdraw route');
    assert.doesNotMatch(api, /verifyPoolWithdrawOffchain/, 'no off-chain withdraw verifier in the API');
  });

  it('the pull book credits nothing and owes nothing, whatever is offered', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-no-pull-'));
    const book = createPullBook(dir);
    const dest = minerDest();
    const tag = publicMinerTag(dest);
    for (const nanos of [1, PI_SHE_NANOS - 1, PI_SHE_NANOS, PI_SHE_NANOS * 17]) {
      const credited = book.creditRound(
        [{ tag, dest, count: 10 }],
        { height: 1, nanos, hashByDest: new Map([[dest, 9]]), finderTag: tag },
      );
      assert.equal(credited.ok, false, String(nanos));
      assert.equal(credited.reason, 'custodial_pull');
    }
    const v = book.view(tag, { tipHeight: 80, need: 1 });
    assert.equal(v.pendingNanos, 0);
    assert.equal(v.confirmedNanos, 0);
    assert.equal(v.sentNanos, 0);
    assert.equal(v.foundBlocks, 0);
    assert.equal(book.ledger(tag).length, 0);
    assert.equal(book.unpaidPotNanos({ tipHeight: 80, need: 1 }), 0);
    assert.equal(book.takeConfirmed(tag, { tipHeight: 80, need: 1 }).ok, false);
    assert.equal(book.dueAuto, undefined, 'no payout due list');
    assert.equal(book.sweepAuto, undefined, 'no payout sweep');
    const file = path.join(dir, 'pull-book.json');
    if (fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /ssa1/);
  });

  it('a signed pool-withdraw is refused at the pool queue; the pool exposes no sweep', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-no-pull-q-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
    try {
      const box = spendBox(newIdentity());
      const to = minerDest();
      const tx = {
        id: 'pull-any-book',
        kind: 'pool-withdraw',
        from: box.dest,
        to,
        nanos: PI_SHE_NANOS,
        fee: 0,
        sponsor: box.dest,
        vin: [{ address: box.dest }],
        vout: [{ address: to, nanos: PI_SHE_NANOS, kind: 'pool-withdraw' }],
      };
      signSpendTx(tx, box.key);
      const queued = pool.store.queueTx(tx);
      assert.equal(queued.ok, false);
      assert.equal(queued.reason, 'custodial_pull');
      assert.equal(pool.sweepAutoPayouts, undefined);
      assert.equal(pool.runAutoPayoutSweep, undefined);
      const ids = (pool.store.template({ miner: FEE, now: 1_700_000_000_000 }).txs || []).map((t) => t.id);
      assert.equal(ids.includes('pull-any-book'), false);
    } finally {
      pool.close();
    }
  });
});
