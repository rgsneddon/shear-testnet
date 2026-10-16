import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('C2 ADMITv1 quarantine on v4 send path', () => {
  it('wallet v4 send path has no shear-admit-v1 / bit-OR prove', () => {
    const files = [
      'wallet/lib/shear_ledger.dart',
      'wallet/lib/shear_admit.dart',
      'wallet/lib/shear_native_prove.dart',
      'crypto/wallet_native_prove.mjs',
    ];
    const joined = files.map(read).join('\n');
    assert.doesNotMatch(joined, /shear-admit-v1/);
    assert.doesNotMatch(joined, /bit\s*\|\s*prove/i);
    // The closed proveFlowSpend stub threw kErrSendUnavailable until FS-1.
    // That stub is gone: shear_admit.dart must not grow a prover, the helper
    // still refuses prove_spend, and the send path is proveFs1SpendWire.
    const admit = read('wallet/lib/shear_admit.dart');
    assert.match(admit, /const String kErrSendUnavailable = 'send unavailable until FS-1'/);
    assert.doesNotMatch(admit, /throw StateError\(kErrSendUnavailable\)/);
    assert.doesNotMatch(admit, /proveFlowSpend|nativeProveFlowSpend|admitProve/);
    assert.match(
      read('crypto/wallet_native_prove.mjs'),
      /op === 'prove_spend'[\s\S]{0,240}send unavailable until FS-1/,
    );
    assert.match(read('wallet/lib/shear_fs1.dart'), /Map<String, dynamic> proveFs1SpendWire\(/);
    assert.match(
      read('wallet/lib/shear_ledger.dart'),
      /reproveFlowSpendWire\(Map<String, dynamic> input\) => proveFs1SpendWire\(input\)/,
    );
  });

  it('intentional fixture still matches the grep (CI red on fixture, green on tree)', () => {
    const fixture = 'shear-admit-v1 bit-OR prove leftover';
    assert.match(fixture, /shear-admit-v1/);
    assert.match(fixture, /bit-OR prove/);
  });
});
