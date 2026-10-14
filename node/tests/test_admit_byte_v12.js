import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { sealHiddenNote } from '../../crypto/note.js';

const KINDS = ['send', 'transfer'];
const VERSIONS = [0, 1, 2, 4, 255];
const AMOUNTS = [1, 1_000_000_000, 50_000_000_000];

function tagFor(version, lane) {
  const tag = Buffer.alloc(32, 0);
  tag[0] = version & 0xff;
  tag[1] = lane & 0xff;
  return tag;
}

function oneProof(version, lane) {
  const tag = tagFor(version, lane);
  const cTilde = Buffer.alloc(32, lane + 3);
  const blob = Buffer.alloc(33, 0);
  blob[0] = version & 0xff;
  tag.copy(blob, 1);
  return { tag, cTilde, proof: { blob, spendTag: tag, cTilde } };
}

const hiddenByAmount = new Map();
/** The amount rides as C and a range proof. A plaintext nanos is amount_field. */
function hiddenOut(kind, amount) {
  if (!hiddenByAmount.has(amount)) {
    const note = sealHiddenNote(amount, { dest20: Buffer.alloc(20, 6) });
    delete note.r;
    hiddenByAmount.set(amount, note);
  }
  return { ...hiddenByAmount.get(amount), kind };
}

function flowTx({ kind, amount, version, anchor = undefined, proofs = null, id }) {
  const built = proofs || [oneProof(version, 1)];
  const tx = {
    id: id || `${kind}-${amount}-${version}-${anchor == null ? 'na' : anchor}`,
    kind,
    fee: 0,
    vin: built.map((row) => ({ commit: row.cTilde })),
    vout: [hiddenOut(kind, amount)],
    admit_proof: built.length === 1 ? built[0].proof : undefined,
    admit_proofs: built.length === 1 ? undefined : built.map((row) => row.proof),
  };
  if (built.length === 1) tx.admit_proof = built[0].proof;
  if (anchor != null) tx.anchor = anchor;
  return tx;
}

function mine(tpl) {
  return {
    header: tpl.header,
    height: tpl.height,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
  };
}

function blockVerdict(tx, height, prev) {
  const who = freshStealthDest(newIdentity()).dest;
  const tpl = buildTemplate({
    prev: prev ? prev.hash : GENESIS_PREV,
    prevHeader: prev ? prev.header : undefined,
    prevBlock: prev || null,
    height,
    miner: who,
    bits: GENESIS_BITS_PACKED,
    now: 1_700_000_000_000 + (height - 1) * 90_000,
    txs: [tx],
  });
  return verifyBlock(mine(tpl), prev, { trustedPowHash: Buffer.alloc(32) });
}

describe('v12 flow spends reject a non-v3 byte before the v2 verifier', () => {
  it('any other version byte is admit_version, and a byte-3 send with or without an anchor is send_unavailable, on queue, mempool, and verify', { timeout: 180_000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-byte-'));
    const store = createStore(dir);
    const who = freshStealthDest(newIdentity()).dest;
    try {
      for (const kind of KINDS) {
        for (const amount of AMOUNTS) {
          for (const version of VERSIONS) {
            const tx = flowTx({ kind, amount, version });
            const queued = store.queueTx(tx);
            assert.equal(queued.ok, false, `${kind} ${amount} v${version} ${queued.reason}`);
            assert.equal(queued.reason, 'admit_version', `${kind} ${amount} v${version} queue`);
            assert.equal(store.mempool.some((m) => m.id === tx.id), false);
            const parked = admitMempool(emptyMempool(), tx, { fluxset: { pubs: [1], commits: [Buffer.alloc(32)], jroot: Buffer.alloc(32) } });
            assert.equal(parked.reason, 'admit_version', `${kind} ${amount} v${version} mempool`);
            const bare = admitMempool(emptyMempool(), { ...tx, id: `${tx.id}-bare` });
            assert.equal(bare.reason, 'admit_version', `${kind} ${amount} v${version} empty-set`);
          }
        }
      }
      const blockSpread = [
        { kind: 'send', amount: AMOUNTS[0], version: 2 },
        { kind: 'transfer', amount: AMOUNTS[1], version: 2 },
        { kind: 'send', amount: AMOUNTS[2], version: 0 },
        { kind: 'transfer', amount: AMOUNTS[0], version: 4 },
      ];
      for (const spec of blockSpread) {
        const got = blockVerdict(flowTx(spec), 1, null);
        assert.equal(got.ok, false, `${spec.kind} ${spec.version} ${got.reason}`);
        assert.equal(got.reason, 'admit_version', `${spec.kind} v${spec.version} block`);
      }
      const parentGot = blockVerdict(flowTx({ kind: 'send', amount: 1, version: 2, id: 'parent-skip' }), 1, null);
      assert.equal(parentGot.reason, 'admit_version');
      const parent = mine(buildTemplate({
        prev: GENESIS_PREV,
        height: 1,
        miner: who,
        bits: GENESIS_BITS_PACKED,
        now: 1_700_000_000_000,
      }));
      const sealed = verifyBlock(parent, null, { trustedPowHash: Buffer.alloc(32) });
      assert.equal(sealed.ok, true, sealed.reason);
      parent.hash = sealed.hash;
      const later = blockVerdict(flowTx({ kind: 'send', amount: AMOUNTS[1], version: 2, id: 'h2' }), 2, parent);
      assert.equal(later.reason, 'admit_version', later.reason);
      const mixed = flowTx({
        kind: 'send',
        amount: AMOUNTS[2],
        version: 2,
        id: 'mixed',
        proofs: [oneProof(2, 1), oneProof(3, 2)],
      });
      assert.equal(store.queueTx(mixed).reason, 'send_unavailable');
      assert.equal(admitMempool(emptyMempool(), mixed).reason, 'send_unavailable');
      assert.equal(blockVerdict(mixed, 1, null).reason, 'send_unavailable');
      const noAnchor = flowTx({ kind: 'transfer', amount: 1, version: 3, id: 'v3-open' });
      assert.equal(store.queueTx(noAnchor).reason, 'send_unavailable');
      assert.equal(admitMempool(emptyMempool(), noAnchor).reason, 'send_unavailable');
      assert.equal(blockVerdict(noAnchor, 1, null).reason, 'send_unavailable');
      const anchored = flowTx({ kind: 'send', amount: AMOUNTS[1], version: 2, anchor: 8, id: 'anchored-v2' });
      assert.equal(store.queueTx(anchored).reason, 'admit_version', 'a v2 byte is not saved by an anchor');
      const v3anchor = flowTx({ kind: 'send', amount: 1, version: 3, anchor: 8, id: 'v3-anchor' });
      const v3q = store.queueTx(v3anchor);
      assert.equal(v3q.reason, 'send_unavailable');
      assert.equal(v3q.ok, false);
      const refused = flowTx({ kind: 'vortice-register', amount: 1, version: 2, id: 'refused' });
      assert.equal(store.queueTx(refused).reason, 'kind');
      const tag = Buffer.alloc(32, 7);
      const blob = Buffer.alloc(33, 2);
      tag.copy(blob, 1);
      const lock = {
        id: 'lock-v2',
        kind: 'lock',
        nanos: AMOUNTS[0],
        anchor: 8,
        vin: [{ commit: Buffer.alloc(32, 4) }],
        vout: [{ kind: 'lock', nanos: AMOUNTS[0] }],
        admit_proof: { blob, spendTag: tag, cTilde: Buffer.alloc(32, 4) },
      };
      assert.equal(store.queueTx(lock).reason, 'admit_membership');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stub blob starting with 2 is admit_version on queue, mempool, and verify', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-byte-stub-'));
    const store = createStore(dir);
    try {
      const tx = flowTx({ kind: 'send', amount: 1, version: 2, id: 'stub-byte-2' });
      assert.equal(tx.admit_proof.blob[0], 2);
      assert.equal(store.queueTx(tx).reason, 'admit_version');
      assert.equal(admitMempool(emptyMempool(), tx, {
        fluxset: { pubs: [1], commits: [Buffer.alloc(32)], jroot: Buffer.alloc(32) },
      }).reason, 'admit_version');
      assert.equal(blockVerdict(tx, 1, null).reason, 'admit_version');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
