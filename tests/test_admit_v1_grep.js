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
    assert.match(read('wallet/lib/shear_admit.dart'), /nativeProveFlowSpend/);
  });

  it('intentional fixture still matches the grep (CI red on fixture, green on tree)', () => {
    const fixture = 'shear-admit-v1 bit-OR prove leftover';
    assert.match(fixture, /shear-admit-v1/);
    assert.match(fixture, /bit-OR prove/);
  });
});
