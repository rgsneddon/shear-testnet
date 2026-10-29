/**
 * shear-dev node plumbing and the #128 PASS fixes, re-cut on b3efdc26.
 * - A chain load that omits the book throws unknown_magic (fc600180).
 * - The supply audit worker uses the store magic it is given; a missing
 *   magic is an error, not the v12 clock (b6419b17).
 * - Header time rules and the day-0 seed follow the dev row only on shear-dev.
 *
 * Fails on b3efdc26: verifyLoadedChain defaults a missing magic to v12, the
 * worker hard-codes MAGIC_TESTNET, and rootHeaderReason/retarget have no dev seed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MAGIC_TESTNET, MAGIC_MAINNET, MAGIC_DEV, GENESIS_BITS_PACKED, genesisSeedPacked } from '../../crypto/asert.js';
import { verifyLoadedChain, retarget } from '../src/chain.js';

function auditOnce(start) {
  return new Promise((resolve) => {
    const w = new Worker(new URL('../src/supply_audit_worker.js', import.meta.url));
    w.on('message', (msg) => {
      w.terminate();
      resolve(msg);
    });
    w.postMessage({ id: 1, type: 'start', length: 0, ...start });
    w.postMessage({ id: 1, type: 'end' });
  });
}

describe('shear-dev book plumbing', () => {
  it('a chain load with no book throws unknown_magic', () => {
    assert.throws(() => verifyLoadedChain([{}]), (e) => e.code === 'unknown_magic');
    assert.throws(() => verifyLoadedChain([{}], { magic: '' }), (e) => e.code === 'unknown_magic');
    assert.equal(verifyLoadedChain([{}], { magic: MAGIC_TESTNET }).reason, 'no_header');
    assert.equal(verifyLoadedChain([{}], { magic: MAGIC_DEV }).reason, 'no_header');
    assert.equal(verifyLoadedChain([]).ok, true);
  });

  it('the supply audit worker refuses a job with no magic and runs the given book', async () => {
    const missing = await auditOnce({});
    assert.equal(missing.error, 'unknown_magic');
    const dev = await auditOnce({ magic: MAGIC_DEV });
    assert.equal(dev.error, undefined);
    assert.ok(dev.audit);
    const v12 = await auditOnce({ magic: MAGIC_TESTNET });
    assert.equal(v12.error, undefined);
  });

  it('an empty retarget falls back to the book seed', () => {
    assert.equal(retarget([], 0, MAGIC_DEV), genesisSeedPacked(MAGIC_DEV));
    assert.equal(retarget([], 0, MAGIC_TESTNET), GENESIS_BITS_PACKED);
    assert.equal(retarget([], 0, MAGIC_MAINNET), GENESIS_BITS_PACKED);
    assert.equal(retarget([], 0), GENESIS_BITS_PACKED);
  });
});
