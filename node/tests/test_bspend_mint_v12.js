/**
 * L-1: a b-spend mints only the leaf the chain committed.
 * Any amount, any output split. The tx does not choose the header.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import {
  buildTemplate,
  GENESIS_PREV,
  retarget,
} from '../src/chain.js';
import { decodeHeader, encodeHeader, VERSION } from '../../crypto/header.js';
import { bProof, buildDualTree } from '../../crypto/clearing.js';
import { GENESIS_BITS_PACKED, SPENDABLE_CONFIRMATIONS, hashBonusUnitNanos } from '../../crypto/asert.js';
import { openedCoinbaseNanos, sealNote } from '../../crypto/note.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { attachAdmitPub } from '../../crypto/admit.js';
import { V12_VALUE_KINDS } from '../../crypto/spend.js';
import { admitBaseFromAddress, freshStealthDest, hash20FromAddress, newIdentity, ed25519SeedOf } from '../../crypto/address.js';

const T0 = 1_700_000_000_000;
const AMOUNTS = [1, 2 ** 20, 2 ** 40];

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function identityDest() {
  const id = newIdentity();
  const pay = freshStealthDest(id);
  return { dest: pay.dest, spendSeed: id.spendSeed || ed25519SeedOf(id.privateKey) };
}

function sealOut(amount, dest, kind) {
  const d20 = hash20FromAddress(dest);
  assert.ok(d20 && Buffer.from(d20).length === 20);
  let note = sealNote(amount, { dest20: Buffer.from(d20), kind });
  note.address = dest;
  note = attachAdmitPub(note, { admitBase: admitBaseFromAddress(dest) });
  assert.equal(openedCoinbaseNanos(note), amount);
  return note;
}

function asBlock(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples || [],
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

describe('v12 b-spend mint is the chain leaf', () => {
  it('rejects a missing kind, a foreign header, and an output above the leaf, for any amount', async () => {
    assert.ok(AMOUNTS.length >= 3);
    assert.ok(AMOUNTS.every((n) => Number.isSafeInteger(n) && n > 0));
    assert.ok(new Set(AMOUNTS).size === AMOUNTS.length);
    const { dest } = identityDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-l1-'));
    const store = createStore(dir);
    const leaves = AMOUNTS.map((unit, i) => ({
      dest20: Buffer.from(hash20FromAddress(dest)),
      unit,
      nonce: i + 1,
      memoH: Buffer.alloc(32),
      tag: 'b-extra',
    }));
    try {
      const commitTpl = buildTemplate({
        prev: GENESIS_PREV,
        height: 1,
        miner: dest,
        now: T0,
        bLeaves: leaves,
        shareBatch: [],
      });
      const committed = await Promise.resolve(store.append(asBlock(commitTpl), {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
      }));
      assert.equal(committed.ok, true, `${committed.reason || ''} ${committed.error || ''}`);
      assert.equal(store.tip().height, 1);
      const commit = store.blocks[0];
      assert.equal(commit.height, 1);
      assert.ok(commit.header && commit.rootA && commit.rootB);

      for (let n = 0; n < SPENDABLE_CONFIRMATIONS - 2; n += 1) {
        const parentTs = Number(decodeHeader(Buffer.from(store.tip().header)).timestamp);
        const { tpl } = store.template({
          miner: dest,
          shareBits: 4,
          now: parentTs + 90_000,
        });
        const got = await Promise.resolve(store.append(asBlock(tpl), {
          trustedPowHash: easyPowHash(),
          skipSharePow: true,
        }));
        assert.equal(got.ok, true, `filler ${n} ${got.reason || ''} ${got.error || ''}`);
      }
      const parentHeight = store.tip().height;
      assert.equal(parentHeight, SPENDABLE_CONFIRMATIONS - 1);
      const matureTip = parentHeight + 1;
      assert.ok(matureTip - 1 + 1 >= SPENDABLE_CONFIRMATIONS);

      const nextBlock = (txs) => {
        const t = store.tip();
        const parentTs = Number(decodeHeader(Buffer.from(t.header)).timestamp);
        const now = parentTs + 90_000;
        const built = buildTemplate({
          prev: t.hash,
          prevHeader: t.header,
          prevBlock: t,
          parentWeight: t.weight,
          height: t.height + 1,
          miner: dest,
          txs,
          now,
          bits: retarget(store.blocks, now),
          parentBlocks: store.blocks,
          parentFluxset: store.fluxset(),
          hashBonusNanos: hashBonusUnitNanos(store.reserveVault.liveHashBonusNanos),
          shareBatch: [],
        });
        return asBlock(built);
      };
      const probe = (txs) => Promise.resolve(store.probeBlock(nextBlock(txs)));

      const hidden = sealOut(AMOUNTS[0], dest, 'b-spend');
      const missing = {
        id: 'l1-missing-kind',
        from: dest,
        to: dest,
        nanos: AMOUNTS[0],
        fee: 0,
        vin: [{}],
        vout: [hidden],
      };
      assert.equal(missing.kind, undefined);
      assert.equal(missing.vout[0].kind, 'b-spend');
      const queuedMissing = store.queueTx(missing);
      assert.equal(queuedMissing.ok, false);
      assert.equal(queuedMissing.reason, 'kind');
      const parked = admitMempool(emptyMempool(), missing, { baseFee: 1 });
      assert.equal(parked.ok, false);
      assert.equal(parked.reason, 'kind');
      const missingBlock = await probe([missing]);
      assert.equal(missingBlock.ok, false, missingBlock.reason);
      assert.equal(missingBlock.reason, 'kind');

      const disagreed = {
        id: 'l1-kind-disagree',
        kind: 'b-spend',
        from: dest,
        to: dest,
        nanos: AMOUNTS[1],
        fee: 0,
        vin: [{ address: dest }],
        vout: [sealOut(AMOUNTS[1], dest, 'send')],
      };
      const queuedDisagree = store.queueTx(disagreed);
      assert.equal(queuedDisagree.ok, false);
      assert.equal(queuedDisagree.reason, 'kind');

      const spendOf = (leaf, index, outs, extra = {}) => ({
        id: `l1-${leaf.unit}-${extra.id || 'spend'}`,
        kind: 'b-spend',
        from: dest,
        to: dest,
        nanos: leaf.unit,
        fee: 0,
        commitHeight: 1,
        leaf,
        proof: bProof(leaves, index),
        index,
        vin: [{ address: dest }],
        vout: outs,
        ...extra,
      });

      for (let i = 0; i < AMOUNTS.length; i += 1) {
        const amount = AMOUNTS[i];
        const fakeLeaf = {
          dest20: Buffer.from(hash20FromAddress(dest)),
          unit: amount,
          nonce: 50_000 + i,
          memoH: Buffer.alloc(32, i + 1),
          tag: 'forged',
        };
        const dual = buildDualTree({ aLeaves: [], bLeaves: [fakeLeaf] });
        const fakeHeader = encodeHeader({
          version: VERSION,
          prevBlockHash: GENESIS_PREV,
          merkleRoot: Buffer.alloc(32),
          continuityRoot: dual.continuityRoot,
          timestamp: T0,
          bits: GENESIS_BITS_PACKED,
          nonce: 0n,
          baseFee: 1n,
        });
        const forged = {
          id: `l1-forged-${amount}`,
          kind: 'b-spend',
          from: dest,
          to: dest,
          nanos: amount,
          fee: 0,
          commitHeight: 1,
          commitHeader: fakeHeader,
          commitRootA: dual.rootA,
          commitRootB: dual.rootB,
          leaf: fakeLeaf,
          proof: bProof([fakeLeaf], 0),
          index: 0,
          vin: [{ address: dest }],
          vout: [sealOut(amount, dest, 'b-spend')],
        };
        const forgedBlock = await probe([forged]);
        assert.equal(forgedBlock.ok, false, `${amount} ${forgedBlock.reason}`);
        assert.ok(
          forgedBlock.reason === 'proof' || forgedBlock.reason === 'continuity',
          `${amount} forged ${forgedBlock.reason}`,
        );
        const forgedQueue = store.queueTx(forged);
        assert.equal(forgedQueue.ok, false, amount);
        assert.ok(
          forgedQueue.reason === 'proof' || forgedQueue.reason === 'continuity',
          forgedQueue.reason,
        );

        const overOut = sealOut(amount + amount, dest, 'b-spend');
        const over = spendOf(leaves[i], i, [overOut], {
          id: 'over',
          commitHeader: commit.header,
          commitRootA: commit.rootA,
          commitRootB: commit.rootB,
          nanos: amount + amount,
        });
        const overBlock = await probe([over]);
        assert.equal(overBlock.ok, false, `${amount} ${overBlock.reason}`);
        assert.equal(overBlock.reason, 'commit_sum', `${amount} ${overBlock.reason}`);
        const overQueue = store.queueTx(over);
        assert.equal(overQueue.ok, false, amount);
        assert.equal(overQueue.reason, 'commit_sum', overQueue.reason);
      }

      const honest = AMOUNTS.map((amount, i) => {
        const outs = amount === AMOUNTS[AMOUNTS.length - 1] && amount > 1
          ? [sealOut(1, dest, 'b-spend'), sealOut(amount - 1, dest, 'b-spend')]
          : [sealOut(amount, dest, 'b-spend')];
        const opened = outs.reduce((sum, o) => sum + openedCoinbaseNanos(o), 0);
        assert.equal(opened, amount);
        return spendOf(leaves[i], i, outs, {
          id: 'honest',
          commitHeader: Buffer.alloc(128, 3),
          commitRootA: Buffer.alloc(32, 4),
          commitRootB: Buffer.alloc(32, 5),
        });
      });
      const honestProbe = await probe(honest);
      assert.equal(honestProbe.ok, true, honestProbe.reason);
      const sealed = await Promise.resolve(store.append(nextBlock(honest), {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
      }));
      assert.equal(sealed.ok, true, `${sealed.reason || ''} ${sealed.error || ''}`);
      assert.equal(store.tip().height, matureTip);
      const again = await probe([honest[0]]);
      assert.equal(again.ok, false);
      assert.equal(again.reason, 'double_open');

      const parkedForged = {
        id: 'l1-parked-forged',
        kind: 'b-spend',
        from: dest,
        to: dest,
        nanos: AMOUNTS[0],
        fee: 0,
        commitHeight: 1,
        commitHeader: Buffer.alloc(128, 9),
        leaf: {
          dest20: Buffer.from(hash20FromAddress(dest)),
          unit: AMOUNTS[0],
          nonce: 77,
          memoH: Buffer.alloc(32, 7),
          tag: 'parked',
        },
        proof: [],
        index: 0,
        vin: [{ address: dest }],
        vout: [sealOut(AMOUNTS[0], dest, 'b-spend')],
      };
      store.mempool.push(parkedForged);
      const parentTs = Number(decodeHeader(Buffer.from(store.tip().header)).timestamp);
      const { tpl } = store.template({ miner: dest, shareBits: 4, now: parentTs + 90_000 });
      assert.ok(!(tpl.txs || []).some((row) => row && row.id === parkedForged.id));
      assert.ok(!store.mempool.some((row) => row && row.id === parkedForged.id));

      for (const kind of V12_VALUE_KINDS) {
        if (kind === 'b-spend') continue;
        const tx = {
          id: `l1-over-${kind}-${AMOUNTS[2]}`,
          kind,
          from: dest,
          to: dest,
          nanos: AMOUNTS[2],
          fee: 0,
          vin: [{ address: dest }],
          vout: [sealOut(AMOUNTS[2], dest, kind)],
        };
        const got = store.queueTx(tx);
        assert.equal(got.ok, false, `${kind} ${got.reason || 'accepted'}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
