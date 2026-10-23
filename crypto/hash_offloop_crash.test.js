import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.SHEAR_HASH_LANE_TEST = '1';
process.env.SHEAR_TEST_CRASH_ON_START = '1';

const { hashHeaderOffLoop, p2pHashSpawns, P2P_VERIFY_CAP } = await import('./hash_offloop.js');

describe('hash lane startup crash', { timeout: 20_000 }, () => {
  it('does not respawn a child that exits at startup', async () => {
    const err = await hashHeaderOffLoop(Buffer.alloc(128, 1)).then(() => null, (e) => e);
    assert.ok(err instanceof Error);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(p2pHashSpawns(), P2P_VERIFY_CAP);
  });
});
