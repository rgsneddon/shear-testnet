import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { GENESIS_BITS_PACKED, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { newIdentity, freshStealthDest, hash20FromAddress, ed25519SeedOf } from '../../crypto/address.js';
import { sealNote } from '../../crypto/note.js';
import { signSpendTx, verifySpendSig } from '../../crypto/spend.js';
import { compactLockLeakRejected } from '../../crypto/reserve_vault.js';
import {
  ANCHOR_QUANTUM,
  anchorRejectReason,
  checkAdmitAnchor,
} from '../../crypto/admit_v3.js';

function mine(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
  };
}

function box() {
  const id = newIdentity();
  const pay = freshStealthDest(id);
  return {
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
  };
}

describe('ADMITv3 anchor on queue and verify', () => {
  it('a presented anchor is judged at the next height, and a missing anchor is not remapped', { timeout: 180_000 }, async () => {
    const who = box();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-anchor-'));
    const store = createStore(dir);
    const Q = ANCHOR_QUANTUM;
    const amounts = [1, 1_000_000_000];
    // A lock names its owner by dest20 only. `from`, `to`, and an ssa1 address
    // on a lock are vote_leak, which runs before the anchor gate.
    const d20 = Buffer.from(hash20FromAddress(who.dest));
    const anchors = [0, 1, Q - 1, Q + 1, -Q, Q, Q * 2, Q * (SPENDABLE_CONFIRMATIONS + 1)];
    try {
      for (const nanos of amounts) {
        for (const A of anchors) {
          const tx = {
            id: `lock-${nanos}-${A}`,
            kind: 'lock',
            nanos,
            anchor: A,
            vin: [{}],
            vout: [{ kind: 'lock', nanos, dest20: d20 }],
          };
          assert.equal(compactLockLeakRejected(tx), null, `${nanos} ${A} leak`);
          const queued = store.queueTx(tx);
          assert.equal(queued.ok, false, `${nanos} ${A} ${queued.reason}`);
          assert.equal(queued.reason, anchorRejectReason(A, 1), `${nanos} ${A}`);
        }
        const split = {
          id: `split-${nanos}`,
          kind: 'lock',
          nanos,
          anchor: Q,
          vin: [{ anchor: Q * 2 }],
          vout: [{ kind: 'lock', nanos, dest20: d20 }],
        };
        assert.equal(compactLockLeakRejected(split), null, `${nanos} split leak`);
        // `anchor` is not a signed vin key. queueTx and verifyBlock reject
        // that key as unsigned before checkAdmitAnchor. Reordering those
        // gates would change the consensus reason. The quantum split is
        // still the pure rule.
        assert.equal(checkAdmitAnchor(split, 1).reason, 'admit_anchor_quantum');
        const queuedSplit = store.queueTx(split);
        assert.equal(queuedSplit.ok, false, String(nanos));
        assert.equal(queuedSplit.reason, 'unsigned', String(nanos));
        const note = sealNote(nanos, { dest20: d20, kind: 'lock' });
        const unanchored = {
          id: `plain-${nanos}`,
          kind: 'lock',
          nanos,
          vin: [{ commit: note.commit, dest20: d20 }],
          vout: [{ ...note, kind: 'lock', dest20: d20 }],
        };
        // The spend signature binds vin dest20. This lock has no FS-1 blob,
        // so spendPub and sig are not the FS-1 identity leak.
        signSpendTx(unanchored, who.key);
        assert.equal(verifySpendSig(unanchored), true, `${nanos} sig`);
        assert.equal(compactLockLeakRejected(unanchored), null, `${nanos} plain leak`);
        const queuedPlain = store.queueTx(unanchored);
        assert.equal(queuedPlain.reason, 'admit_membership', `${nanos} ${queuedPlain.reason}`);
      }
      const later = SPENDABLE_CONFIRMATIONS + Q;
      const mature = { kind: 'lock', anchor: Q, vin: [{}], vout: [] };
      assert.equal(checkAdmitAnchor(mature, later).ok, true);
      // No top-level nanos: with no lock row to open, a stated amount is
      // amount_field (reserveNanosRejected) before the anchor window.
      assert.equal(store.queueTx({ ...mature, id: 'later' }).reason, 'admit_anchor_window');
      for (const A of [1, Q]) {
        const tx = {
          id: `block-${A}`,
          kind: 'lock',
          nanos: 1,
          anchor: A,
          vin: [{}],
          vout: [{ kind: 'lock', nanos: 1, dest20: d20 }],
        };
        const tpl = buildTemplate({
          prev: GENESIS_PREV,
          height: 1,
          miner: who.dest,
          bits: GENESIS_BITS_PACKED,
          now: 1_700_000_000_000,
          txs: [tx],
        });
        const got = await Promise.resolve(verifyBlock(mine(tpl), null, {
          trustedPowHash: Buffer.from(`${'00'.repeat(31)}01`, 'hex'),
        }));
        assert.equal(got.ok, false, String(A));
        assert.equal(got.reason, anchorRejectReason(A, 1), `${A} ${got.reason}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
