import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alertFor, tickWatch } from '../src/watch.js';

describe('shear-watch', () => {
  it('does not freeze when one of two nodes is merely gone', () => {
    const row = tickWatch({
      policy: { frozen: false, d_max: 0, h_ratio: 1, side_lead: 0 },
      tips: [{ status: 'active', hash: 'aa', height: 4 }],
      reorgs: [],
    });
    assert.equal(row.frozen, false);
    assert.equal(alertFor({ depth: 0, h_ratio: 1 }).freeze, false);
  });

  it('freezes on depth >= 10 and on h_ratio < 0.5', () => {
    assert.equal(alertFor({ depth: 12 }).freeze, true);
    assert.equal(alertFor({ h_ratio: 0.4 }).freeze, true);
    assert.equal(alertFor({ depth: 3 }).reason, 'reorg_risk');
  });
});
