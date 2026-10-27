/**
 * The FS-1 verify cache and root cache never let a stale "valid" through.
 *
 * A verify result is cached by every input of the native check, each one
 * length-prefixed. A root is cached under its (n, jroot) label only when the
 * row's notes hash to that jroot. Each case below is one where a cache that
 * missed an input would return a stale pass; each must be refused.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { admitScalarFromSeed, attachAdmitPub, jroot } from './admit.js';
import { sealCoinbaseNote } from './note.js';
import { fs1NativeLoaded } from './native_admit.js';
import { verifyFlowAdmitFs1 } from './admit_v3.js';
import {
  fs1ProveSpend,
  fs1RootAt,
  fs1VerifyCount,
  fs1VerifySpend,
  resetFs1Tree,
  resetFs1VerifyCache,
  txBodyDigestFs1,
} from './fs1_spend.js';

const ANCHOR = 8;
const HEIGHT = 80;

/** Twelve fresh admit-set notes. `owned` are spendable with `seed`; `salt` changes the others' keys. */
function book(seed, owned, salt = 0) {
  const pubs = [];
  const commits = [];
  const keys = [];
  for (let i = 0; i < 12; i += 1) {
    const mine = owned.includes(i);
    const note = attachAdmitPub(
      sealCoinbaseNote(1000 + i + (mine ? 0 : salt), { dest20: Buffer.alloc(20, i + 1), kind: 'pot' }),
      { spendSeed: mine ? seed : Buffer.alloc(32, 0x40 + i + salt) },
    );
    pubs.push(Buffer.from(note.admitPub));
    commits.push(Buffer.from(note.commit));
    if (mine) keys.push({ index: i, x: admitScalarFromSeed(seed, note) });
  }
  return { live: { n: 12, jroot: Buffer.from(jroot({ pubs, commits })), pubs, commits }, keys };
}

/** A two-input send proven in `live`, as it is posted. */
function send(live, keys) {
  const draft = {
    kind: 'send',
    anchor: ANCHOR,
    fee: 1,
    vin: keys.map(() => ({ commit: Buffer.alloc(32) })),
    vout: [{ kind: 'send', commit: Buffer.alloc(32, 3), dest20: Buffer.alloc(20, 9) }],
  };
  const proven = fs1ProveSpend({ live, anchor: ANCHOR, indices: keys.map((k) => k.index), xs: keys.map((k) => k.x), tx: draft });
  assert.ok(proven, 'prove');
  return {
    tx: {
      ...draft,
      vin: proven.proofs.map((p) => ({ commit: Buffer.from(p.cTilde) })),
      fs1: proven.fs1,
      admit_proofs: proven.proofs,
    },
    proven,
  };
}

describe('FS-1 verify cache refuses stale passes', () => {
  beforeEach(() => {
    assert.ok(fs1NativeLoaded(), 'the FS-1 addon is built');
    resetFs1Tree();
    resetFs1VerifyCache();
  });

  it('a cached pass is not reused when bytes move between the blob and the records', () => {
    const seed = Buffer.alloc(32, 5);
    const { live, keys } = book(seed, [3, 9]);
    const { tx, proven } = send(live, keys);
    const root = fs1RootAt(live);
    const records = Buffer.concat(proven.proofs.map((p) => p.blob));
    const digest = txBodyDigestFs1(tx);
    assert.equal(fs1VerifySpend({ fs1: proven.fs1, records, root, digest, anchor: ANCHOR }), true);
    const ran = fs1VerifyCount();
    // Same concatenated bytes, split one record later. Without length
    // prefixes this is the cached key of the pass above.
    const shifted = {
      fs1: Buffer.concat([proven.fs1, proven.proofs[0].blob]),
      records: Buffer.from(proven.proofs[1].blob),
    };
    assert.equal(fs1VerifySpend({ ...shifted, root, digest, anchor: ANCHOR }), false);
    assert.equal(fs1VerifyCount(), ran + 1, 'the shifted split ran the native check');
  });

  it('after a reorg changes the notes at the anchor, the proof cached on the old notes is refused', () => {
    const seed = Buffer.alloc(32, 6);
    const before = book(seed, [2, 7]);
    const { tx } = send(before.live, before.keys);
    const first = verifyFlowAdmitFs1(tx, { height: HEIGHT, noteAtAnchor: () => before.live });
    assert.equal(first.ok, true, first.reason);
    const ran = fs1VerifyCount();
    const again = verifyFlowAdmitFs1(tx, { height: HEIGHT, noteAtAnchor: () => before.live });
    assert.equal(again.ok, true, again.reason);
    assert.equal(fs1VerifyCount(), ran, 'the same proof on the same notes is a cache hit');

    // The reorged chain holds other notes at the same anchor height.
    const after = book(seed, [2, 7], 50);
    assert.equal(after.live.jroot.equals(before.live.jroot), false);
    const oldRoot = Buffer.from(tx.fs1.subarray(3, 35));
    const newRoot = fs1RootAt(after.live);
    assert.equal(newRoot.equals(oldRoot), false);
    const stale = verifyFlowAdmitFs1(tx, { height: HEIGHT, noteAtAnchor: () => after.live });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'admit_anchor_root');

    // Re-pointing the blob at the new root does not reach the old pass.
    const repointed = { ...tx, fs1: Buffer.from(tx.fs1) };
    newRoot.copy(repointed.fs1, 3);
    const counted = fs1VerifyCount();
    const moved = verifyFlowAdmitFs1(repointed, { height: HEIGHT, noteAtAnchor: () => after.live });
    assert.equal(moved.ok, false);
    assert.equal(moved.reason, 'admit_membership');
    assert.equal(fs1VerifyCount(), counted + 1, 'the new root ran the native check');
  });

  it('a row whose jroot names other notes cannot poison that label', () => {
    const seed = Buffer.alloc(32, 7);
    const honest = book(seed, [1, 4]);
    const forged = book(seed, [1, 4], 90);
    const honestRoot = fs1RootAt(honest.live);
    resetFs1Tree();
    // A send proven in the forged notes, posted against the honest label.
    const { tx } = send(forged.live, forged.keys);
    const mislabeled = { ...forged.live, jroot: honest.live.jroot };
    // The root of the row's own notes, as before. It is not cached under the
    // honest label.
    assert.equal(fs1RootAt(mislabeled).equals(honestRoot), false);
    assert.equal(fs1RootAt(honest.live).equals(honestRoot), true);
    const refused = verifyFlowAdmitFs1(tx, { height: HEIGHT, noteAtAnchor: () => honest.live });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'admit_anchor_root');
  });
});
