import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function loadBlockStatus(rel) {
  const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const fn = src.match(/function blockStatus\(t, tip, need\) \{[\s\S]*?\n    \}/);
  assert.ok(fn, `blockStatus missing in ${rel}`);
  return new Function(`${fn[0]}; return blockStatus;`)();
}

describe('mined-block pending uses consensus 6, not pool_merchant 30', () => {
  for (const rel of ['../public/index.html', '../public/explorer.html']) {
    it(`${rel} confirms height 1 at tip 6; 30-conf band is not the mined gate`, () => {
      const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
      assert.match(src, /spendableConfirmations/);
      assert.doesNotMatch(src, /confirmedNeed/);
      assert.doesNotMatch(src, /pool_merchant/);
      const blockStatus = loadBlockStatus(rel);
      assert.equal(blockStatus({ height: 1 }, 6, 6), 'confirmed');
      assert.equal(blockStatus({ height: 1 }, 5, 6), 'pending');
      assert.equal(blockStatus({ height: 1 }, 1, 6), 'pending');
      assert.equal(blockStatus({ height: 1 }, 6, 30), 'pending');
      assert.equal(blockStatus({ height: 5 }, 10, 6), 'confirmed');
    });
  }

  it('wallet Continuum settle is already spendableConfirmations 6', () => {
    const src = fs.readFileSync(new URL('../../wallet/lib/shear_ledger.dart', import.meta.url), 'utf8');
    assert.match(src, /static const spendableConfirmations = 6/);
    assert.match(src, /confirmationsOf\(row\.height, tip\) >= spendableConfirmations/);
    assert.match(src, /confirmationsOf\(h, tip\) >= spendableConfirmations/);
  });
});
