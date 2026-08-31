import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from './address.js';
import { destForLogin } from './flow_sheet.js';
import { NANOS_PER_SHE } from './asert.js';
import { levyNanos } from './levy.js';
import { verifyPoolWithdrawOffchain } from './levy.js';
import {
  EIP712_CHAIN_ID,
  poolWithdrawDigest,
  signPoolWithdraw,
  verifyPoolWithdrawSig,
} from './eip712.js';

describe('EIP-712 PoolWithdraw', () => {
  it('chainId 2701; valid seed sig verifies; empty/wrong/unsigned fail; 1 SHE empty L is 0.0002', () => {
    assert.equal(EIP712_CHAIN_ID, 2701);
    assert.equal(levyNanos(NANOS_PER_SHE), 20_000_000);
    assert.equal(levyNanos(NANOS_PER_SHE) / NANOS_PER_SHE, 0.0002);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const seed = Buffer.alloc(32, 7);
    const nanos = Math.floor(0.05 * NANOS_PER_SHE);
    const digest = poolWithdrawDigest({ login: id.paymentCode, dest, nanos });
    assert.equal(digest.length, 32);
    const sig = signPoolWithdraw({ seed, login: id.paymentCode, dest, nanos });
    assert.match(sig, /^[0-9a-f]{196}$/);
    assert.equal(verifyPoolWithdrawSig({ login: id.paymentCode, dest, nanos, sig }), true);
    const ok = verifyPoolWithdrawOffchain({ login: id.paymentCode, dest, nanos, sig });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(verifyPoolWithdrawOffchain({ login: id.paymentCode, dest, nanos, sig: '' }).reason, 'unsigned');
    assert.equal(verifyPoolWithdrawOffchain({ login: '', dest, nanos, sig }).reason, 'need_she1');
    const tampered = verifyPoolWithdrawOffchain({
      login: id.paymentCode,
      dest,
      nanos: nanos + 1,
      sig,
    });
    assert.equal(tampered.ok, false);
    const other = destForLogin(newIdentity().address, { viewKey: newIdentity().viewKey, height: 1 });
    assert.equal(verifyPoolWithdrawOffchain({ login: id.paymentCode, dest: other, nanos, sig }).ok, false);
    assert.equal(verifyPoolWithdrawOffchain({ login: id.paymentCode, dest: id.paymentCode, nanos, sig: 'ab' }).reason, 'she1');
  });
});
