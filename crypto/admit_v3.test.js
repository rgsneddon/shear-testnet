import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SPENDABLE_CONFIRMATIONS } from './asert.js';
import {
  ANCHOR_QUANTUM,
  ANCHOR_WINDOW,
  anchorRejectReason,
  walletAnchor,
  readyHeight,
  checkAdmitAnchor,
} from './admit_v3.js';

const K = SPENDABLE_CONFIRMATIONS;
const Q = ANCHOR_QUANTUM;
const W = ANCHOR_WINDOW;

function bruteOk(A, H) {
  if (!Number.isSafeInteger(H) || H < 1) return false;
  if (!Number.isSafeInteger(A) || A < Q || A % Q !== 0) return false;
  const newest = H - K;
  return A >= newest - W && A <= newest;
}

describe('ADMITv3 anchor window', () => {
  it('accepts only multiples of Q inside H-K-W .. H-K, for many inclusion heights', () => {
    const heights = [];
    for (let step = 0; step < 48; step += 1) heights.push(K + Q + step * 3);
    heights.push(K + Q + W, K + W * 4, 10_000);
    for (const H of heights) {
      let accepted = 0;
      const lo = (H - K - W) - Q;
      const hi = (H - K) + Q;
      for (let A = lo; A <= hi; A += 1) {
        const reason = anchorRejectReason(A, H);
        const ok = bruteOk(A, H);
        assert.equal(reason == null, ok, `H=${H} A=${A} ${reason}`);
        if (ok) {
          accepted += 1;
          assert.equal(checkAdmitAnchor({ anchor: A }, H).ok, true);
        } else {
          const got = checkAdmitAnchor({ anchor: A }, H);
          assert.equal(got.ok, false);
          assert.equal(got.reason, reason);
        }
      }
      const newest = H - K;
      const span = newest >= Q + W;
      if (span && newest % Q === 0) assert.equal(accepted, W / Q + 1, `aligned H=${H}`);
      if (span && newest % Q !== 0) assert.equal(accepted, W / Q, `offset H=${H}`);
    }
  });

  it('rejects a non-multiple, a too-new anchor, and a future anchor at every sampled H', () => {
    const heights = [1, K, K + Q, K + Q + 1, K + W, 500, 9_001];
    for (const H of heights) {
      assert.equal(anchorRejectReason(Q - 1, H), 'admit_anchor_quantum');
      assert.equal(anchorRejectReason(0, H), 'admit_anchor_quantum');
      assert.equal(anchorRejectReason(-Q, H), 'admit_anchor_quantum');
      assert.equal(anchorRejectReason(H, H), H % Q === 0 ? 'admit_anchor_window' : 'admit_anchor_quantum');
      const tooNew = (H - K) + 1;
      if (Number.isSafeInteger(tooNew) && tooNew % Q === 0) {
        assert.equal(anchorRejectReason(tooNew, H), 'admit_anchor_window');
      }
      assert.equal(checkAdmitAnchor({ anchor: Q, vin: [{ anchor: Q * 2 }] }, H).reason, 'admit_anchor_quantum');
      assert.equal(checkAdmitAnchor({ kind: 'lock' }, H).ok, true);
    }
  });

  it('the wallet anchor is the newest in-window multiple, and readyHeight is the first such T', () => {
    const notes = [];
    for (let h = 1; h <= Q * 6; h += 1) notes.push(h);
    notes.push(100, 1_000, 8_192);
    for (const h of notes) {
      const T = readyHeight(h);
      assert.equal(Number.isSafeInteger(T), true);
      const chosen = walletAnchor(T);
      assert.equal(chosen != null && chosen >= h && chosen - h < Q, true, `h=${h}`);
      assert.equal(anchorRejectReason(chosen, T), null, `h=${h}`);
      const earlier = walletAnchor(T - 1);
      assert.equal(earlier == null || earlier < h, true, `h=${h}`);
    }
    for (let T = 1; T < K + Q; T += 1) assert.equal(walletAnchor(T), null);
    for (let T = K + Q; T <= K + Q + W + Q; T += 3) {
      const A = walletAnchor(T);
      assert.equal(A, Math.floor((T - K) / Q) * Q);
      assert.equal(anchorRejectReason(A, T), null);
      assert.equal(anchorRejectReason(A + Q, T), 'admit_anchor_window');
    }
  });
});
