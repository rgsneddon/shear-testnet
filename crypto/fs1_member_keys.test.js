/**
 * The wallet's FS-1 membership-row allow-list stays equal to spend.js
 * MEMBER_KEYS. That export is the single source for the public names.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMBER_KEYS } from './spend.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function dartMemberKeys() {
  const ledger = fs.readFileSync(path.join(root, 'wallet/lib/shear_ledger.dart'), 'utf8');
  const match = ledger.match(/postedMemberKeys = <String>\{([^}]+)\}/);
  assert.ok(match, 'postedMemberKeys missing');
  return new Set(match[1].match(/'([^']+)'/g).map((quoted) => quoted.slice(1, -1)));
}

describe('FS-1 member keys', () => {
  it('wallet postedMemberKeys matches spend.js MEMBER_KEYS', () => {
    assert.deepEqual(dartMemberKeys(), MEMBER_KEYS);
    for (const secret of ['t', 'r', 'opening', 'seed', 'spendSeed', 'blind', 'alpha', 'gamma']) {
      assert.equal(MEMBER_KEYS.has(secret), false, secret);
    }
  });
});
