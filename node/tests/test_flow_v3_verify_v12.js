import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { sealHiddenNote } from '../../crypto/note.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  flowProofVerifyCount,
  resetFlowProofVerifies,
} from '../../crypto/admit_v3.js';

const KINDS = ['send', 'transfer'];
const AMOUNTS = [1, 1_000_000_000, 50_000_000_000];
const SHORT = [33, 40, 128];
const LONG = [129, 160, 258];
const T0 = 1_700_000_000_000;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function oneProof(length, lane) {
  const tag = Buffer.alloc(32, 0);
  tag[0] = 3;
  tag[1] = lane & 0xff;
  tag[2] = (lane >> 8) & 0xff;
  const cTilde = Buffer.alloc(32, (lane + 3) & 0xff);
  const blob = Buffer.alloc(length, 0);
  blob[0] = 3;
  tag.copy(blob, 1);
  return { blob, spendTag: tag, cTilde };
}

const hiddenByAmount = new Map();
const FIXTURE_ADMIT_BASE = newIdentity().admitBase;
/** The amount rides as C and a range proof. A plaintext nanos is amount_field. */
function hiddenOut(kind, amount) {
  if (!hiddenByAmount.has(amount)) {
    const note = sealHiddenNote(amount, { dest20: Buffer.alloc(20, 6), admitBase: FIXTURE_ADMIT_BASE });
    delete note.r;
    hiddenByAmount.set(amount, note);
  }
  return { ...hiddenByAmount.get(amount), kind };
}

function flowTx({ kind, amount, length, lanes, anchor, id }) {
  const built = lanes.map((lane) => oneProof(length, lane));
  const tx = {
    id,
    kind,
    fee: 0,
    anchor,
    vin: built.map((row) => ({ commit: row.cTilde })),
    vout: [hiddenOut(kind, amount)],
  };
  if (built.length === 1) tx.admit_proof = built[0];
  else tx.admit_proofs = built;
  return tx;
}

// Regtest work (bits 4, about 16 hashes). Every block carries a real nonce
// and is stored under its own ShearHash, with no trusted hash.
async function sealHeader(header, bits) {
  const found = await mineHeaderParallel(header, bits, 8_192, 1);
  assert.ok(found && found.block, 'regtest pow');
  return found.header;
}

async function grow(store, dest, n) {
  for (let i = 0; i < n; i += 1) {
    const now = T0 + i * 90_000;
    const { tpl } = store.template({ miner: dest, shareBits: 4, now });
    const block = {
      header: await sealHeader(tpl.header, tpl.bits),
      height: tpl.height,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    };
    const got = await Promise.resolve(store.append(block));
    assert.equal(got.ok, true, `height ${i + 1} ${got.reason}`);
  }
}

async function blockVerdict(store, dest, tx) {
  const tip = store.tip();
  const preview = store.template({ miner: dest, shareBits: 4, now: T0 + 16 * 90_000 });
  const stamp = Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp);
  const built = buildTemplate({
    prev: tip ? tip.hash : GENESIS_PREV,
    prevHeader: tip ? tip.header : undefined,
    prevBlock: tip || null,
    height: (tip?.height || 0) + 1,
    miner: dest,
    bits: preview.tpl.bits,
    now: stamp,
    txs: [tx],
  });
  return verifyBlock({
    header: await sealHeader(built.header, built.bits),
    height: built.height,
    txs: built.txs,
    samples: built.samples,
    shareBatch: built.shareBatch || [],
    miner: dest,
    aLeaves: built.aLeaves,
    bLeaves: built.bLeaves,
    rootA: built.rootA,
    rootB: built.rootB,
    weight: built.weight,
  }, tip, {
    noteAtAnchor: (anchor) => store.anchorNote(anchor),
    magic: store.magic,
  });
}

describe('v12 flow byte 3 is rejected before the verifier', () => {
  after(() => closeMineWorkers());

  it('a byte-3 flow proof is send_unavailable on queue, mempool, and verify', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-flow-v3-'));
    const store = createRegtestStore(dir, { bits: 4 });
    const dest = minerDest();
    resetFlowProofVerifies();
    try {
      await grow(store, dest, 16);
      const height = store.tip().height + 1;
      assert.equal(height, 17);
      const opts = {
        magic: store.magic,
        height,
        noteAtAnchor: (anchor) => store.anchorNote(anchor),
      };
      let lane = 1;
      for (const kind of KINDS) {
        for (const amount of AMOUNTS) {
          for (const length of SHORT) {
            for (const inputs of [1, 2]) {
              const tx = flowTx({
                kind,
                amount,
                length,
                lanes: Array.from({ length: inputs }, () => lane++),
                anchor: 8,
                id: `short-${kind}-${amount}-${length}-${inputs}`,
              });
              const queued = store.queueTx(tx);
              assert.equal(queued.ok, false, queued.reason);
              assert.equal(queued.reason, 'send_unavailable', `${tx.id} queue ${queued.reason}`);
              assert.equal(store.mempool.some((m) => m.id === tx.id), false);
              const parked = admitMempool(emptyMempool(), tx, opts);
              assert.equal(parked.reason, 'send_unavailable', `${tx.id} mempool ${parked.reason}`);
            }
          }
          for (const length of LONG) {
            const tx = flowTx({
              kind,
              amount,
              length,
              lanes: [lane++],
              anchor: 8,
              id: `long-${kind}-${amount}-${length}`,
            });
            const queued = store.queueTx(tx);
            assert.equal(queued.ok, false, queued.reason);
            assert.equal(queued.reason, 'send_unavailable', `${tx.id} queue ${queued.reason}`);
            const parked = admitMempool(emptyMempool(), tx, opts);
            assert.equal(parked.reason, 'send_unavailable', `${tx.id} mempool ${parked.reason}`);
          }
        }
      }
      const blockSpread = [
        { kind: 'send', amount: AMOUNTS[0], length: SHORT[0], reason: 'send_unavailable' },
        { kind: 'transfer', amount: AMOUNTS[1], length: SHORT[2], reason: 'send_unavailable' },
        { kind: 'send', amount: AMOUNTS[2], length: LONG[0], reason: 'send_unavailable' },
        { kind: 'transfer', amount: AMOUNTS[0], length: LONG[2], reason: 'send_unavailable' },
      ];
      for (const spec of blockSpread) {
        const tx = flowTx({
          kind: spec.kind,
          amount: spec.amount,
          length: spec.length,
          lanes: [lane++],
          anchor: 8,
          id: `block-${spec.kind}-${spec.length}`,
        });
        const got = await blockVerdict(store, dest, tx);
        assert.equal(got.ok, false, got.reason);
        assert.equal(got.reason, spec.reason, `${tx.id} block ${got.reason}`);
      }
      const late = flowTx({
        kind: 'send',
        amount: AMOUNTS[1],
        length: LONG[1],
        lanes: [lane++],
        anchor: 16,
        id: 'anchor-late',
      });
      assert.equal(store.queueTx(late).reason, 'send_unavailable');
      assert.equal(admitMempool(emptyMempool(), late, opts).reason, 'send_unavailable');
      assert.equal((await blockVerdict(store, dest, late)).reason, 'send_unavailable');
      const v2 = flowTx({
        kind: 'transfer',
        amount: AMOUNTS[2],
        length: 33,
        lanes: [lane],
        anchor: 8,
        id: 'still-v2',
      });
      v2.admit_proof.blob[0] = 2;
      assert.equal(store.queueTx(v2).reason, 'admit_version');
      assert.equal(admitMempool(emptyMempool(), v2, opts).reason, 'admit_version');
      assert.equal((await blockVerdict(store, dest, v2)).reason, 'admit_version');
      assert.equal(flowProofVerifyCount(), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
