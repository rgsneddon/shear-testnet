/**
 * Issue 122: the pool fee dest must be one a pool-fee note can pay under
 * v12 poolFeeNoteBound (crypto/address.js): a payable ssa (dest20 plus admit
 * base) or the pool-fee sink. A short ssa is refused at config time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeDest,
  hash20FromAddress,
  isDestAddress,
  isPayableDest,
  newIdentity,
  poolFeeDest,
} from '../../crypto/address.js';
import {
  THIS_POOL_DIRECT_FEE_DEST,
  configuredFeeIdentity,
  feeIdentityCheck,
} from '../src/pool.js';
import { POOL_FEE_DEST_NOT_PAYABLE_ERROR } from '../src/posture.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function payableDest() {
  const id = newIdentity();
  return encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
}

function shortDest() {
  return encodeDest(hash20FromAddress(payableDest()));
}

describe('v12 pool fee dest is payable or the sink', () => {
  it('short is refused, payable and sink are accepted, the shipped dest still passes', () => {
    const short = shortDest();
    assert.equal(isDestAddress(short), true);
    assert.equal(isPayableDest(short), false);
    for (const ident of [
      configuredFeeIdentity({ env: { SHEAR_FEE_DEST: short } }),
      configuredFeeIdentity({ env: { SHEAR_POOL_FEE_PAYOUT_DEST: short } }),
      configuredFeeIdentity({ env: { SHEAR_FEE_DEST: short, SHEAR_ADMIN_SPEND_DEST: short } }),
      feeIdentityCheck({ feeDest: short, adminSpendDest: short }),
      // The lab flag skips the fee/admin match only. It does not make a
      // short dest mine valid blocks.
      feeIdentityCheck({ feeDest: short, adminSpendDest: '', labOverride: true }),
    ]) {
      assert.equal(ident.ok, false);
      assert.equal(ident.reason, 'fee_dest_not_payable');
      assert.equal(ident.error, POOL_FEE_DEST_NOT_PAYABLE_ERROR);
    }

    const pay = payableDest();
    assert.equal(isPayableDest(pay), true);
    const okPay = configuredFeeIdentity({ env: { SHEAR_FEE_DEST: pay } });
    assert.equal(okPay.ok, true, okPay.reason);
    assert.equal(okPay.feeDest, pay);
    assert.equal(okPay.adminSpendDest, pay);

    const sink = poolFeeDest();
    assert.equal(isPayableDest(sink), false);
    const okSink = configuredFeeIdentity({ env: { SHEAR_FEE_DEST: sink } });
    assert.equal(okSink.ok, true, okSink.reason);
    assert.equal(okSink.feeDest, sink);

    assert.equal(isPayableDest(THIS_POOL_DIRECT_FEE_DEST), true);
    const shipped = configuredFeeIdentity({ env: {} });
    assert.equal(shipped.ok, true, shipped.reason);
    assert.equal(shipped.feeDest, THIS_POOL_DIRECT_FEE_DEST);

    // A mismatch keeps its own reason ahead of the payable check.
    const clash = configuredFeeIdentity({ env: { SHEAR_FEE_DEST: short, SHEAR_ADMIN_SPEND_DEST: pay } });
    assert.equal(clash.ok, false);
    assert.equal(clash.reason, 'fee_dest_mismatch');
  });

  it('pool startup exits on a short fee dest with the error', { timeout: 60_000 }, () => {
    const short = shortDest();
    const main = path.join(here, '..', 'src', 'main.js');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fee-payable-'));
    try {
      const run = spawnSync(process.execPath, [main], {
        env: {
          PATH: process.env.PATH,
          HOME: dataDir,
          SHEAR_DATA: dataDir,
          SHEAR_FEE_DEST: short,
          SHEAR_ADMIN_SPEND_DEST: short,
        },
        encoding: 'utf8',
        timeout: 45_000,
      });
      assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
      assert.match(run.stderr, /"event":"fee_dest_not_payable"/);
      assert.match(run.stderr, /"reason":"fee_dest_not_payable"/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
