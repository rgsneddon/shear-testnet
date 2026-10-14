import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_TESTNET, SPENDABLE_CONFIRMATIONS } from './asert.js';
import { admitProveV3, admitPub, jroot, jrootPoint } from './admit.js';
import { commit, pointBytes, randomScalar } from './note.js';
import {
  ANCHOR_QUANTUM,
  ANCHOR_WINDOW,
  admitV3Context,
  anchorRejectReason,
  checkAdmitAnchor,
  fundingJroot,
  readyHeight,
  txDigestV3,
  verifyTypedAdmitFunding,
  walletAnchor,
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

describe('ADMITv3 funding uses the point-leaf root', () => {
  it('verifies a point-leaf proof for every sampled set size, and rejects the v2 root', () => {
    const counts = [1, 8, 40];
    const height = K + Q + W;
    const anchor = walletAnchor(height);
    assert.equal(anchorRejectReason(anchor, height), null);
    for (const n of counts) {
      const xs = Array.from({ length: n }, () => randomScalar());
      const pubs = xs.map(admitPub);
      const commits = xs.map((_, i) => pointBytes(commit(i + 1, randomScalar())));
      const index = n === 1 ? 0 : Math.min(n - 1, 3 + (n % 7));
      const v2 = Buffer.from(jroot({ pubs, commits }));
      const live = { pubs, commits, n, jroot: v2 };
      const point = fundingJroot(live);
      assert.ok(point, `point root n=${n}`);
      assert.equal(Buffer.from(point).equals(v2), false, `books differ n=${n}`);
      assert.equal(Buffer.from(point).equals(Buffer.from(jrootPoint({ pubs, commits }))), true);
      const t = randomScalar();
      const probe = admitProveV3({
        x: xs[index], index, pubs, commits, c: commits[index], t, ctx: Buffer.alloc(64, 9),
      });
      assert.ok(probe, `probe n=${n}`);
      const tx = {
        kind: 'lock',
        anchor,
        fee: 0,
        vin: [{ commit: probe.cTilde, anchor }],
        admit_proofs: [probe],
      };
      const digest = txDigestV3(tx, MAGIC_TESTNET);
      const ctx = admitV3Context({
        magic: MAGIC_TESTNET, anchor, root: point, n, digest,
      });
      const proof = admitProveV3({
        x: xs[index], index, pubs, commits, c: commits[index], t, ctx,
      });
      assert.ok(proof, `prove n=${n}`);
      tx.admit_proofs = [proof];
      tx.vin = [{ commit: proof.cTilde, anchor }];
      const got = verifyTypedAdmitFunding(tx, {
        height,
        noteAtAnchor: () => live,
      });
      assert.equal(got.ok, true, `n=${n} ${got.reason}`);
      const v2ctx = admitV3Context({
        magic: MAGIC_TESTNET, anchor, root: v2, n, digest,
      });
      const stale = admitProveV3({
        x: xs[index], index, pubs, commits, c: commits[index], t, ctx: v2ctx,
      });
      assert.ok(stale, `v2-root prove n=${n}`);
      const staleTx = {
        ...tx,
        vin: [{ commit: stale.cTilde, anchor }],
        admit_proofs: [stale],
      };
      const rejected = verifyTypedAdmitFunding(staleTx, {
        height,
        noteAtAnchor: () => live,
      });
      assert.equal(rejected.ok, false, `v2 root must not fund n=${n}`);
      assert.equal(rejected.reason, 'admit_membership');
      const short = {
        pubs: pubs.slice(0, Math.max(1, n - 1)),
        commits: commits.slice(0, Math.max(1, n - 1)),
        n: Math.max(1, n - 1),
        jroot: v2,
      };
      if (n > 1) {
        const subset = verifyTypedAdmitFunding(tx, {
          height,
          noteAtAnchor: () => short,
        });
        assert.equal(subset.ok, false, `shorter set n=${n}`);
        assert.equal(subset.reason, 'admit_anchor_root');
      }
    }
  });
});
