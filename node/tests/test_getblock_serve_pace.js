import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GETBLOCK_SERVE_IBD,
  GETBLOCK_SERVE_PER_TURN,
  GETBLOCK_WAIT_IBD_MS,
  GETBLOCK_WAIT_MS,
  getblockServeCap,
  getblockWaitMs,
  shouldEnqueueGetblock,
} from '../src/p2p.js';

describe('getblock serve pace', () => {
  it('a tip node with a peer behind serves a catch-up window, not one block', () => {
    assert.equal(getblockServeCap({ ibd: false, midChain: false, behind: false }), GETBLOCK_SERVE_PER_TURN);
    assert.equal(GETBLOCK_SERVE_PER_TURN, 1);
    const cap = getblockServeCap({ ibd: false, midChain: false, behind: true });
    assert.equal(cap, GETBLOCK_SERVE_IBD);
    assert.ok(cap >= 8 && cap <= 32);
    const ibd = getblockServeCap({ ibd: true, midChain: false, behind: false });
    const mid = getblockServeCap({ ibd: false, midChain: true, behind: false });
    assert.equal(ibd, GETBLOCK_SERVE_IBD);
    assert.equal(mid, GETBLOCK_SERVE_IBD);
    assert.ok(ibd >= 8 && ibd <= 32);
    assert.ok(mid >= 8 && mid <= 32);
    assert.notEqual(ibd, GETBLOCK_SERVE_PER_TURN);
    assert.notEqual(mid, GETBLOCK_SERVE_PER_TURN);
  });

  it('a repeat getblock for the same socket and hash is not encoded again', () => {
    assert.equal(shouldEnqueueGetblock({ queued: true, now: 1000 }), false);
    assert.equal(shouldEnqueueGetblock({ servedAt: 1000, now: 2000 }), false);
    assert.equal(shouldEnqueueGetblock({ servedAt: 1000, now: 1000 + 3000 }), true);
    assert.equal(shouldEnqueueGetblock({ now: 1000 }), true);
  });

  it('IBD waits for a fat body; a one-block tip still retries quickly', () => {
    assert.equal(getblockWaitMs({ localHeight: 265, peerHeight: 321 }), GETBLOCK_WAIT_IBD_MS);
    assert.ok(GETBLOCK_WAIT_IBD_MS > GETBLOCK_WAIT_MS);
    assert.equal(getblockWaitMs({ localHeight: 320, peerHeight: 321 }), GETBLOCK_WAIT_MS);
    assert.equal(GETBLOCK_WAIT_MS, 250);
  });
});
