/**
 * The wallet's FS-1 membership-row allow-list. Node acceptance of unknown
 * members[] keys is not decided here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const postedMemberKeys = new Set(['commit', 'hash', 'side', 'anchor', 'root']);

function dartMemberKeys() {
  const ledger = fs.readFileSync(path.join(root, 'wallet/lib/shear_ledger.dart'), 'utf8');
  const match = ledger.match(/postedMemberKeys = <String>\{([^}]+)\}/);
  assert.ok(match, 'postedMemberKeys missing');
  return new Set(match[1].match(/'([^']+)'/g).map((quoted) => quoted.slice(1, -1)));
}

describe('FS-1 member keys', () => {
  it('wallet postedMemberKeys is the public membership allow-list', () => {
    assert.deepEqual(dartMemberKeys(), postedMemberKeys);
    for (const secret of ['t', 'r', 'opening', 'seed', 'spendSeed', 'blind', 'alpha', 'gamma']) {
      assert.equal(dartMemberKeys().has(secret), false, secret);
    }
  });
});
