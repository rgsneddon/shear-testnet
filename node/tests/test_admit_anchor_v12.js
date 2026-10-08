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
import { signSpendTx } from '../../crypto/spend.js';
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
    const anchors = [0, 1, Q - 1, Q + 1, -Q, Q, Q * 2, Q * (SPENDABLE_CONFIRMATIONS + 1)];
    try {
      for (const nanos of amounts) {
        for (const A of anchors) {
          const tx = {
            id: `lock-${nanos}-${A}`,
            kind: 'lock',
            from: who.dest,
            to: who.dest,
            nanos,
            anchor: A,
            vin: [{}],
            vout: [{ kind: 'lock', nanos, address: who.dest }],
          };
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
          vout: [{ kind: 'lock', nanos, address: who.dest }],
        };
        const queuedSplit = store.queueTx(split);
        assert.equal(queuedSplit.reason, 'admit_anchor_quantum', String(nanos));
        const note = sealNote(nanos, { dest20: hash20FromAddress(who.dest), kind: 'lock' });
        const unanchored = {
          id: `plain-${nanos}`,
          kind: 'lock',
          from: who.dest,
          to: who.dest,
          nanos,
          vin: [{ commit: note.commit, address: who.dest }],
          vout: [{ ...note, kind: 'lock', address: who.dest }],
        };
        signSpendTx(unanchored, who.key);
        const queuedPlain = store.queueTx(unanchored);
        assert.equal(queuedPlain.reason, 'admit_membership', `${nanos} ${queuedPlain.reason}`);
      }
      const later = SPENDABLE_CONFIRMATIONS + Q;
      const mature = { kind: 'lock', anchor: Q, vin: [{}], vout: [] };
      assert.equal(checkAdmitAnchor(mature, later).ok, true);
      assert.equal(store.queueTx({ ...mature, id: 'later', nanos: 1 }).reason, 'admit_anchor_window');
      for (const A of [1, Q]) {
        const tx = {
          id: `block-${A}`,
          kind: 'lock',
          nanos: 1,
          anchor: A,
          vin: [{}],
          vout: [{ kind: 'lock', nanos: 1, address: who.dest }],
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
          trustedPowHash: Buffer.alloc(32),
        }));
        assert.equal(got.ok, false, String(A));
        assert.equal(got.reason, anchorRejectReason(A, 1), `${A} ${got.reason}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
