/**
 * A withdraw built by the Dart wallet verifies in JS: retire proofs,
 * principal openings, the spend signature, and the v3 digest.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAGIC_TESTNET, PI_SHE_NANOS } from './asert.js';
import { txDigestV3 } from './admit_v3.js';
import { verifySpendSig } from './spend.js';
import { reserveMagicBytes, verifyPrincipalOpen, verifyRewardAuth, withdrawOwnerMessage } from './reserve_vault.js';
import { verifyLeafRetire } from './vault_reward_fs1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wallet = path.join(root, 'wallet');

const BYTE_KEYS = new Set([
  'dest20', 'spendPub', 'sig', 'withdrawNonce', 'excess', 'fs1',
  'commit', 'blob', 'cTilde', 'spendTag', 'R', 'z', 'note',
]);

function asHexBuf(raw) {
  const hex = String(raw || '');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, 'hex');
}

function revive(value, key = '') {
  if (typeof value === 'string' && BYTE_KEYS.has(key)) return asHexBuf(value) || value;
  if (Array.isArray(value)) {
    if (key === 'retireProofs' || key === 'retireProof') {
      return value.map((row) => (typeof row === 'string' ? asHexBuf(row) : revive(row, key)));
    }
    return value.map((row) => revive(row, key));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [name, row] of Object.entries(value)) out[name] = revive(row, name);
    return out;
  }
  return value;
}

describe('Dart withdraw verifies in JS', () => {
  it('checks retire, principal, spend signature, and the digest', () => {
    const ran = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'dart', 'run', 'bin/emit_proved_withdraw.dart'], {
        cwd: wallet,
        encoding: 'utf8',
        timeout: 120_000,
      })
      : spawnSync('dart', ['run', 'bin/emit_proved_withdraw.dart'], {
        cwd: wallet,
        encoding: 'utf8',
        timeout: 120_000,
      });
    assert.equal(ran.status, 0, ran.stderr || ran.stdout || 'dart withdraw');
    const tx = revive(JSON.parse(ran.stdout));
    assert.equal(tx.kind, 'withdraw');
    assert.equal(tx.from, undefined);
    assert.equal(tx.to, undefined);
    assert.equal(tx.payoutPortalId, undefined);
    assert.equal(tx.nanos, PI_SHE_NANOS * 2);
    assert.equal(Buffer.from(tx.fs1)[0], 0xf1);
    assert.equal(Buffer.from(tx.excess).length, 32);
    assert.equal(tx.vin.length, 2);
    assert.equal(tx.admit_proofs.length, 2);
    assert.equal(Buffer.from(tx.dest20).length, 20);
    assert.equal(Buffer.from(tx.spendPub).length, 32);
    assert.equal(Buffer.from(tx.sig).length, 64);
    assert.equal(Buffer.from(tx.withdrawNonce).length, 32);
    assert.equal(tx.retireProofs.length, 2);
    assert.equal(tx.principalProofs.length, 2);
    tx.sig = Buffer.from(tx.sig).toString('hex');
    tx.spendPub = Buffer.from(tx.spendPub).toString('hex');
    const digest = txDigestV3(tx, MAGIC_TESTNET);
    for (let i = 0; i < 2; i += 1) {
      const proof = Buffer.from(tx.retireProofs[i]);
      const retired = verifyLeafRetire(proof, null, MAGIC_TESTNET);
      assert.ok(retired, `retire ${i}`);
      assert.ok(proof.subarray(proof.length - 32).equals(digest), `digest ${i}`);
      const note = proof.subarray(proof.length - 96, proof.length - 32);
      const opened = verifyPrincipalOpen(
        note.subarray(32, 64),
        PI_SHE_NANOS,
        tx.principalProofs[i],
        tx,
        tx.portalId,
        MAGIC_TESTNET,
      );
      assert.equal(opened, true, `principal ${i}`);
    }
    assert.equal(verifySpendSig(tx), true);
    const rewardHex = String(tx.rewardSig || '');
    assert.match(rewardHex, /^[0-9a-f]{128}$/);
    assert.match(String(tx.ownerPub || ''), /^[0-9a-f]{64}$/);
    const destHex = Buffer.from(tx.dest20).toString('hex');
    assert.equal(destHex, '11' + '00'.repeat(19));
    const message = withdrawOwnerMessage({
      nullifier: tx.portalId,
      nanos: PI_SHE_NANOS * 2,
      dest: destHex,
      magic: reserveMagicBytes(MAGIC_TESTNET),
      chainId: 2701n,
      epoch: 0,
      trancheSet: createHash('sha256').update(Buffer.from('shear-tranche-set-v1')).digest(),
      txBind: digest,
    });
    assert.equal(verifyRewardAuth(message, tx.ownerPub, rewardHex), true);
  });
});
