/**
 * The wallet's FS-1 membership-row allow-list stays equal to spend.js.
 * This file does not skip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMBER_KEYS, unsignedBodyField } from './spend.js';

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
    for (const key of ['commit', 'hash', 'side', 'anchor', 'root']) {
      assert.equal(MEMBER_KEYS.has(key), true, key);
    }
    for (const secret of ['t', 'r', 'opening', 'seed', 'spendSeed', 'blind', 'alpha', 'gamma']) {
      assert.equal(MEMBER_KEYS.has(secret), false, secret);
    }
  });

  it('an unknown member key is unsigned and the allow-listed row is not', () => {
    assert.equal(unsignedBodyField({
      members: [{ commit: 'aa', hash: 'bb', side: 'L', anchor: 'cc', root: 'dd' }],
    }), null);
    const nested = unsignedBodyField({
      admit_proof: { v: 3, members: [{ commit: 'aa', blind: 'ee' }] },
    });
    assert.equal(nested && nested.reason, 'unsigned');
    const top = unsignedBodyField({
      members: [{ side: 'L', hash: 'bb', gamma: 'ff' }],
    });
    assert.equal(top && top.reason, 'unsigned');
  });
});
