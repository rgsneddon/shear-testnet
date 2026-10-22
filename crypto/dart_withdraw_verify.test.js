/**
 * A withdraw built by the Dart wallet verifies in JS: a real FS-1 spend,
 * retire proofs, principal openings, the spend signature, and the v3 digest.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAGIC_TESTNET, PI_SHE_NANOS } from './asert.js';
import { destCommitFromSpendPub, ed25519PrivateFromSeed, ed25519RawPub } from './address.js';
import { txDigestV3 } from './admit_v3.js';
import { verifySealedNote } from './note.js';
import { reserveMagicBytes, verifyPrincipalOpen, verifyRewardAuth, withdrawOwnerMessage } from './reserve_vault.js';
import { verifyLeafRetire } from './vault_reward_fs1.js';
import { fs1VerifySpend, txBodyDigestFs1 } from './fs1_spend.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wallet = path.join(root, 'wallet');

const BYTE_KEYS = new Set([
  'dest20', 'spendPub', 'sig', 'withdrawNonce', 'excess', 'fs1',
  'commit', 'blob', 'cTilde', 'spendTag', 'R', 'z', 'note',
  'r', 'noteCommit', 'admitPub', 'rangeProof',
]);

/** Same bytes as withdrawPayoutDest20 in the Dart wallet. */
function payoutDest20(seed, portalHex, nonce) {
  const one = createHash('sha256').update(Buffer.concat([
    Buffer.from('shear-withdraw-payout-v1'),
    Buffer.from(seed),
    Buffer.from(portalHex, 'hex'),
    Buffer.from(nonce),
  ])).digest();
  return Buffer.from(destCommitFromSpendPub(ed25519RawPub(ed25519PrivateFromSeed(one))));
}

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
    // flutter_tester compiles the wallet. A plain `dart run` has no dart:ui.
    const ran = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'flutter', 'test', 'test/emit_proved_withdraw_test.dart'], {
        cwd: wallet,
        encoding: 'utf8',
        timeout: 300_000,
      })
      : spawnSync('flutter', ['test', 'test/emit_proved_withdraw_test.dart'], {
        cwd: wallet,
        encoding: 'utf8',
        timeout: 300_000,
      });
    assert.equal(ran.status, 0, ran.stderr || ran.stdout || 'dart withdraw');
    const line = String(ran.stdout || '').split(/\r?\n/).map((row) => row.trim()).filter((row) => row.startsWith('{')).pop();
    assert.ok(line, ran.stdout || ran.stderr || 'no withdraw json');
    const tx = revive(JSON.parse(line));
    assert.equal(tx.kind, 'withdraw');
    assert.equal(tx.from, undefined);
    assert.equal(tx.to, undefined);
    assert.equal(tx.payoutPortalId, undefined);
    assert.equal(tx.nanos, PI_SHE_NANOS * 2);
    const fs1 = Buffer.from(tx.fs1);
    assert.equal(fs1[0], 0xf1);
    assert.ok(fs1.length > 35, 'fs1 blob is a proof, not a filler byte');
    const records = Buffer.concat(tx.admit_proofs.map((p) => Buffer.from(p.blob)));
    assert.equal(fs1VerifySpend({
      fs1,
      records,
      root: fs1.subarray(3, 35),
      digest: txBodyDigestFs1(tx, MAGIC_TESTNET),
      anchor: tx.anchor,
    }), true, 'fs1 spend');
    assert.equal(Buffer.from(tx.excess).length, 32);
    assert.equal(tx.vin.length, 2);
    assert.equal(tx.admit_proofs.length, 2);
    assert.equal(Buffer.from(tx.dest20).length, 20);
    assert.equal(tx.spendPub, undefined);
    assert.equal(tx.sig, undefined);
    assert.equal(Buffer.from(tx.withdrawNonce).length, 32);
    assert.equal(tx.retireProofs.length, 2);
    assert.equal(tx.principalProofs.length, 2);
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
    const rewardHex = String(tx.rewardSig || '');
    assert.match(rewardHex, /^[0-9a-f]{128}$/);
    assert.match(String(tx.ownerPub || ''), /^[0-9a-f]{64}$/);
    const destHex = Buffer.from(tx.dest20).toString('hex');
    const seed = Buffer.alloc(32);
    seed[0] = 9;
    const nonce = Buffer.alloc(32);
    nonce[31] = 7;
    const want = payoutDest20(seed, tx.portalId, nonce);
    assert.equal(destHex, want.toString('hex'));
    assert.equal(tx.vout.length, 1);
    assert.equal(tx.vout[0].kind, 'withdraw');
    assert.equal(verifySealedNote(tx.vout[0], tx.nanos), true);
    assert.equal(Buffer.from(tx.vout[0].dest20).equals(want), true);
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
