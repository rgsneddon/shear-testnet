import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashBackendKind } from '../../crypto/shear_hash.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

describe('mine worker faults', () => {
  it('a missed slice returns null and a worker error fails at once', async () => {
    if (hashBackendKind()) {
      const header = Buffer.alloc(128, 9);
      const missed = await mineHeaderParallel(header, 200, 1, 1, 10_000);
      assert.equal(missed, null);
    }
    const t0 = Date.now();
    await assert.rejects(
      () => mineHeaderParallel(Buffer.alloc(4), 1, 8, 1, 20_000),
      /mine_worker/,
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5_000, `worker fault took ${elapsed}ms`);
    await closeMineWorkers();
  });
});
