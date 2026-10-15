/**
 * The posted admit proof must not carry the blind. This file does not skip.
 * The walker itself is wallet/test/posted_admit_proof_test.dart (1, 2, 4, 8).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('posted admit proof', () => {
  it('ledger does not copy blind t onto the wire', () => {
    const ledger = fs.readFileSync(path.join(root, 'wallet/lib/shear_ledger.dart'), 'utf8');
    assert.doesNotMatch(ledger, /admitProof\['t'\]/);
    assert.doesNotMatch(ledger, /'t': blind/);
    assert.match(ledger, /postedAdmitProofKeys/);
    assert.match(ledger, /postedValueProofKeys/);
    assert.match(ledger, /postedMemberKeys/);
    assert.match(ledger, /postedVoutKeys/);
    assert.match(ledger, /postedFlowBody/);
    assert.match(ledger, /workerAdmitProof/);
    assert.match(ledger, /function postedAdmitProof|Map<String, dynamic> postedAdmitProof/);
    assert.doesNotMatch(ledger, /_stripSecretKeys|_wipeSecret|_secretProofKeys/);
    const keys = ledger.slice(
      ledger.indexOf('postedAdmitProofKeys'),
      ledger.indexOf('postedValueProofKeys'),
    );
    for (const secret of ['t', 'r', 'opening', 'seed', 'blind', 'alpha', 'gamma']) {
      assert.doesNotMatch(keys, new RegExp(`'${secret}'`));
    }
    assert.match(keys, /'spendTag'/);
    assert.match(keys, /'cTilde'/);
    assert.match(ledger, /postedValueProofKeys = <String>\{'v', 'R', 'z'\}/);
  });

  it('the 1, 2, 4 and 8 input walker is present and not skipped', () => {
    const test = fs.readFileSync(path.join(root, 'wallet/test/posted_admit_proof_test.dart'), 'utf8');
    assert.match(test, /\[1, 2, 4, 8\]/);
    assert.match(test, /admit_proof/);
    assert.match(test, /admit_proofs/);
    assert.match(test, /blind/);
    assert.match(test, /alpha/);
    assert.match(test, /gamma/);
    assert.match(test, /shared spendSeed/);
    assert.match(test, /_hasRun/);
    assert.doesNotMatch(test, /\bskip\s*:/);
    assert.doesNotMatch(test, /markTestSkipped|skip:\s*true/);
  });
});
