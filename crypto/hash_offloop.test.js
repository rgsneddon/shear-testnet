import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.SHEAR_HASH_WORKER_TIMEOUT_MS = '20000';
process.env.SHEAR_TEST_HANG_HEADER_PREFIX = '0000000000000000';
process.env.SHEAR_TEST_DELAY_HEADER_PREFIX = '0303030303030303';
process.env.SHEAR_TEST_DELAY_MS = '3000';

const { hashHeaderOffLoop } = await import('./hash_offloop.js');
const { shearHash } = await import('./shear_hash.js');

describe('hung hash lane', { timeout: 90_000 }, () => {
  it('times out and replaces one lane while the other still answers', async () => {
    const delayed = Buffer.alloc(128, 3);
    const hung = Buffer.alloc(128, 0);
    const later = Buffer.alloc(128, 4);
    const hangP = hashHeaderOffLoop(hung);
    await new Promise((resolve) => setTimeout(resolve, 16_000));
    const delayP = hashHeaderOffLoop(delayed);
    const hangErr = await hangP.then(() => null, (err) => err);
    assert.equal(hangErr?.message, 'hash_worker_timeout');
    const got = await delayP;
    assert.equal(Buffer.from(got).equals(shearHash(delayed)), true);
    const again = await hashHeaderOffLoop(later);
    assert.equal(Buffer.from(again).equals(shearHash(later)), true);
  });
});
