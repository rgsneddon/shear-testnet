/**
 * Leaf cost after the vartime public multiply and the per-output cache.
 * The old constant-time path was about 12.4 ms/output, about 23.5 s at the
 * weight cap. Measured here: ~3.0 ms/output, 0.56 s at the live payee cap
 * (171) and 3.08 s at the 36,000 weight-unit cap (1,028). The second pass
 * adds no derives. The ceilings below leave room for a slower CI host.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { MAX_BLOCK_VERIFY_WEIGHT, W_PAYEE, payeeCapLive } from '../../crypto/block_budget.js';
import { fs1LeafDeriveCount, resetFs1LeafDerives } from '../../crypto/fs1_leaf.js';
import { chainNoteRuleRejected } from '../../crypto/n1.js';

const BASE = RistrettoPoint.BASE;

function point(i) {
  return Buffer.from(BASE.multiplyUnsafe(BigInt(i)).toRawBytes());
}

function blockOf(n) {
  const vout = [];
  for (let i = 1; i <= n; i += 1) {
    vout.push({ kind: 'pot', admitPub: point(i), commit: point(n + i) });
  }
  return { txs: [{ kind: 'coinbase', coinbase: true, vout }] };
}

function timeNotes(n) {
  const block = blockOf(n);
  resetFs1LeafDerives();
  const t0 = performance.now();
  assert.equal(chainNoteRuleRejected([block]), null, `n=${n}`);
  const ms = performance.now() - t0;
  const derives = fs1LeafDeriveCount();
  const t1 = performance.now();
  assert.equal(chainNoteRuleRejected([block]), null, `n=${n} cached`);
  const cachedMs = performance.now() - t1;
  assert.equal(fs1LeafDeriveCount(), derives, `n=${n} second pass`);
  return { n, ms, derives, cachedMs, per: ms / n };
}

describe('N-1 leaf cost', () => {
  it('derives each output once, under the old per-output cost, at the live cap and the weight cap', () => {
    const live = payeeCapLive();
    const weightCap = Math.floor(MAX_BLOCK_VERIFY_WEIGHT / W_PAYEE);
    assert.ok(live > 0);
    assert.equal(weightCap, 1028);
    const rows = [timeNotes(live), timeNotes(weightCap)];
    for (const row of rows) {
      console.log(JSON.stringify({
        event: 'n1_leaf_cost',
        outputs: row.n,
        ms: Number(row.ms.toFixed(2)),
        msPerOutput: Number(row.per.toFixed(4)),
        derives: row.derives,
        cachedMs: Number(row.cachedMs.toFixed(2)),
        weightCap: MAX_BLOCK_VERIFY_WEIGHT,
      }));
      assert.equal(row.derives, row.n);
      assert.ok(row.per < 8, `${row.n} outputs took ${row.per.toFixed(3)} ms each`);
    }
    assert.ok(rows[1].ms < 20_000, `weight-cap block took ${rows[1].ms.toFixed(0)} ms`);
  });
});
