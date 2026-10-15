/**
 * Claim fee presets. Low / Medium / High are mempool fee rates times this
 * claim's verify-weight. The SHE string is the exact nanos amount.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf } from './address.js';
import { selectBodyIndexes } from './block_budget.js';
import { buildRewardClaim, claimFeePresets, exactSheFromNanos } from './claim_fee.js';
import { LEVY_CAP_NANOS } from './levy.js';

function peer(fee, outs = 1) {
  return {
    kind: 'send',
    fee,
    vin: [],
    vout: Array.from({ length: outs }, () => ({})),
  };
}

function sampleClaim(extra = {}) {
  const id = newIdentity();
  return buildRewardClaim({
    to: spendDestOf(id.spendPub),
    nanos: 5_000,
    nullifier: 'ab'.repeat(32),
    proof: [],
    id: 'claim-quote',
    ...extra,
  });
}

describe('claim fee presets', () => {
  it('prices an empty mempool at the weight floor and shows that SHE exactly', () => {
    const quote = sampleClaim();
    assert.equal(quote.weight, 25);
    assert.equal(quote.floor >= 100, true);
    for (const row of quote.presets) {
      assert.equal(row.fee, quote.floor);
      assert.equal(row.she, exactSheFromNanos(quote.floor));
    }
    assert.deepEqual(quote.presets.map((row) => row.id), ['low', 'medium', 'high']);
    assert.deepEqual(quote.custom, { id: 'custom', label: 'Custom', fee: null, she: null, ok: true });
    assert.equal(quote.tx.fee, quote.floor);
  });

  it('turns mempool fee rates and the claim weight into Low, Medium, and High', () => {
    const mempool = [peer(20_000), peer(1_000), peer(5_000)];
    const quote = sampleClaim({ mempool });
    assert.equal(quote.presets[0].fee, 1_000);
    assert.equal(quote.presets[1].fee, 5_000);
    assert.equal(quote.presets[2].fee, 20_000);
    assert.equal(quote.presets[0].she, '0.00000001');
    assert.equal(quote.presets[1].she, '0.00000005');
    assert.equal(quote.presets[2].she, '0.0000002');
    const heavy = {
      ...quote.tx,
      vout: [quote.tx.vout[0], quote.tx.vout[0]],
    };
    const scaled = claimFeePresets(heavy, mempool);
    assert.equal(scaled.weight, 48);
    assert.equal(scaled.presets[0].fee, 1_920);
    assert.equal(scaled.presets[0].she, exactSheFromNanos(1_920));
    const high = sampleClaim({ mempool, preset: 'high', id: 'claim-high' });
    const low = sampleClaim({ mempool, preset: 'low', id: 'claim-low' });
    assert.equal(high.tx.fee, 20_000);
    assert.equal(low.tx.fee, 1_000);
    const order = selectBodyIndexes([low.tx, high.tx]);
    assert.equal(order[0], 1);
  });

  it('reports a custom bid as exact SHE, including a bid the levy rejects', () => {
    const quote = sampleClaim({ custom: 2_500 });
    assert.equal(quote.custom.fee, 2_500);
    assert.equal(quote.custom.she, '0.000000025');
    assert.equal(quote.custom.ok, true);
    assert.equal(quote.tx.fee, 2_500);
    const short = sampleClaim({ custom: 1 });
    assert.equal(short.custom.ok, false);
    assert.equal(short.custom.reason, 'levy');
    assert.equal(short.custom.she, exactSheFromNanos(1));
    assert.equal(short.tx.fee, short.floor);
    const whale = sampleClaim({ mempool: [{ fee: LEVY_CAP_NANOS, vin: [], vout: [] }] });
    assert.equal(whale.presets[2].fee, LEVY_CAP_NANOS);
    assert.equal(whale.presets[2].capped, true);
    assert.equal(whale.presets[2].she, exactSheFromNanos(LEVY_CAP_NANOS));
  });
});
