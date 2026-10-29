// PR146 P2 (display only): ShearK 2.9 no longer sends `threads` (privacy),
// so applyMinerSelfRate capped every rig at 1 thread x 2500 R/s and threw
// away the self-rate of any rig above 2.5 kR/s (8 jit-full threads: ~3.3k).
// A session with no reported thread count now uses a display-only ceiling.
// Payout and credit never read clientHs (hash_credit.js); the per-thread
// 2500 R/s cap itself is unchanged.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyMinerSelfRate, SELF_RATE_UNKNOWN_THREADS } from '../src/pool.js';

describe('PR146 self-rate HUD without a reported thread count', () => {
  it('a 3.3 kR/s rig that did not report threads shows ~3.3 kR/s', () => {
    const now = 1_000_000;
    const s = { threads: 1, threadsReported: false };
    applyMinerSelfRate(s, { hashes: 0 }, now);
    applyMinerSelfRate(s, { hashes: 6600 }, now + 2000);
    assert.ok(Math.abs(s.clientHs - 3300) < 1, `clientHs ${s.clientHs}`);
  });
  it('a reported thread count keeps the per-thread cap', () => {
    const now = 1_000_000;
    const s = { threads: 1, threadsReported: true };
    applyMinerSelfRate(s, { hashes: 0 }, now);
    applyMinerSelfRate(s, { hashes: 6600 }, now + 2000);
    assert.equal(s.clientHs, undefined);
  });
  it('the unknown-threads ceiling is bounded and the cap per thread is unchanged', () => {
    assert.equal(SELF_RATE_UNKNOWN_THREADS, 256);
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /const cap = threads \* 2500;/);
    assert.match(src, /threadsReported: Number\(params\.threads\) > 0/);
  });
  it('a junk jump on an unreported session is still ignored', () => {
    const now = 1_000_000;
    const s = { threads: 1, threadsReported: false };
    applyMinerSelfRate(s, { hashes: 0 }, now);
    applyMinerSelfRate(s, { hashes: 6600 }, now + 2000);
    applyMinerSelfRate(s, { hashes: 6600 + 225_000_000 }, now + 4000);
    assert.ok(Math.abs(s.clientHs - 3300) < 1, `clientHs ${s.clientHs}`);
  });
});
