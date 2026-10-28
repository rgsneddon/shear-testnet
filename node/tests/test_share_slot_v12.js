// A share's proofSlot (0 = the parent's header, 1 = the grandparent's) is
// bound by the block's share root: a flipped, stripped or out-of-range slot
// is refused on append, wire and IPC, and the honest block is accepted and
// reloads byte for byte. R28: shares are BluNotes frames (one-time key, the
// nonce bound to it on the header it names); the slot byte is the frame's
// second-to-last, before the view tag. Digests are stashed as the prepared
// RandomX output for each header and nonce (the batch-scale cases run to the
// 2 MiB byte cap); verify still checks the target, the lz and the binding
// against them. Real-ShearHash coverage of the same rules is in
// test_r28_share_rules.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  SAMPLE_PRUNE_CONFIRMATIONS,
  shareFloorBits,
  asertNextBits,
} from '../../crypto/asert.js';
import { pruneSamples } from '../../crypto/chronoflux.js';
import { decodeHeader, setNonce } from '../../crypto/header.js';
import {
  packShareBatchBytes,
  shareSlotCommitment,
  shareSlotRoot,
  unpackShareBatchBytes,
} from '../../crypto/pack.js';
import { leadingZeroBits, meetsTarget, shearHash } from '../../crypto/shear_hash.js';
import { clearLiveSharePow, stashSharePow } from '../../crypto/share_batch.js';
import { SHARE_BYTES_MAX, bindNonce, oneTimeKey } from '../../crypto/blunote.js';
import { GENESIS_PREV, buildTemplate, verifyBlock } from '../src/chain.js';
import { encodeWireBlock, decodeWireBlock } from '../src/p2p.js';
import { applyVerifiedIpcBlock } from '../src/p2p_ipc.js';
import { createStore } from '../src/store.js';
import { bluWallet } from './support/blunote_mine.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-slot-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
// R39: the floor a block at genesis bits accepts.
const BITS = shareFloorBits(GENESIS_BITS_PACKED);
const BLU_FRAME = 89;
const SLOT_FROM_END = 2;

let powTag = 1;
function easyPow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  powTag += 1;
  assert.equal(meetsTarget(h, GENESIS_BITS_PACKED), true);
  return h;
}

/** A digest that meets BITS and misses BITS + 1, so its lz is exactly BITS. */
function exactRx(seed) {
  for (let i = 0; i < 1 << 20; i += 1) {
    const rx = Buffer.alloc(32);
    rx.writeUInt32LE(seed, 8);
    rx.writeUInt32LE(i, 0);
    rx.writeUInt32LE((i * 2654435761) >>> 0, 4);
    if (meetsTarget(rx, BITS) && !meetsTarget(rx, BITS + 1)) return rx;
  }
  throw new Error('no digest');
}
const RX = exactRx(7);
assert.equal(leadingZeroBits(RX), BITS);

/** count one-time keys spread over `miners` wallets; nonces are bound later, per header. */
function rowsFor(miners, count, slot = 0) {
  const owners = Array.from({ length: miners }, () => bluWallet());
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const k = oneTimeKey(owners[i % owners.length]);
    rows.push({ shareR: k.R, shareP: k.P, viewTag: k.tag, lz: BITS, shareBits: BITS, proofSlot: slot });
  }
  return rows;
}

/** Bind each row's nonce to the header it proves on and stash its digest. */
function plant(header, row) {
  row.nonce = bindNonce(header, row.shareR, row.shareP, 0, BITS);
  stashSharePow(setNonce(Buffer.from(header), row.nonce), RX);
}

function quoteFor(store, now) {
  const tip = store.tip();
  const parent = decodeHeader(tip.header);
  const genesis = decodeHeader(store.blocks[0].header);
  const parentIsGenesis = parent.prevBlockHash.equals(GENESIS_PREV);
  return asertNextBits({
    anchorBits: parentIsGenesis ? parent.bits : GENESIS_BITS_PACKED,
    anchorTimeMs: parentIsGenesis ? Number(parent.timestamp) : Number(genesis.timestamp),
    anchorHeight: parentIsGenesis ? Number(tip.height) : 1,
    blockTimeMs: now,
    blockHeight: tip.height + 1,
    parentTimeMs: Number(parent.timestamp),
  });
}

function asBlock(tpl, hash) {
  return {
    header: Buffer.from(tpl.header),
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: (tpl.shareBatch || []).map((s) => ({ ...s })),
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hash,
    height: tpl.height,
  };
}

function freshStore(childCount = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-slot-'));
  const store = createStore(dir);
  // Every child is 90s after its parent and still behind HEADER_AHEAD.
  const now = Date.now() - (childCount + 3) * 90_000;
  const tpl = buildTemplate({ prev: GENESIS_PREV, height: 1, miner: MINER, bits: GENESIS_BITS_PACKED, now });
  const pow = easyPow();
  const got = store.append(asBlock(tpl, pow), { trustedPowHash: pow, skipSharePow: true });
  assert.equal(got.ok, true, got.reason || 'height 1');
  assert.equal(store.tip().height, 1);
  return { dir, store, now };
}

function childOf(store, rows, now) {
  const tip = store.tip();
  const quote = quoteFor(store, now);
  assert.equal(quote.ok, true, quote.reason || 'asert');
  clearLiveSharePow();
  const prior = store.blocks.length >= 2 ? store.blocks[store.blocks.length - 2].header : null;
  for (const row of rows) plant(row.proofSlot === 1 ? prior : tip.header, row);
  const tpl = buildTemplate({
    prev: tip.hash,
    prevHeader: tip.header,
    prevBlock: tip,
    height: tip.height + 1,
    miner: MINER,
    bits: quote.packed,
    now,
    shareBatch: rows,
    parentBlocks: store.blocks,
  });
  assert.equal(tpl.shareBatch.length, rows.length, 'the template seats every row');
  assert.ok(Buffer.from(tpl.txs[0].shareSlotRoot).equals(shareSlotRoot(tpl.shareBatch)));
  return tpl;
}

function appendBlock(store, block, pow) {
  return store.append(block, { trustedPowHash: pow, poolDest: block.miner });
}

/** Rewrite every frame of a packed batch with `edit(frame)`. */
function eachFrame(packed, edit) {
  const n = packed.readUInt32LE(0);
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(n, 0);
  let o = 4;
  for (let i = 0; i < n; i += 1) {
    const len = packed.readUInt16LE(o);
    o += 2;
    const body = edit(Buffer.from(packed.subarray(o, o + len)));
    o += len;
    const l = Buffer.alloc(2);
    l.writeUInt16LE(body.length, 0);
    parts.push(l, body);
  }
  return Buffer.concat(parts);
}

describe('v12 proofSlot is bound by the block', () => {
  it('rejects a flipped, stripped, or wrong slot and still accepts the honest block', () => {
    const atCap = Math.floor(SHARE_BYTES_MAX / BLU_FRAME);
    const widths = [
      { miners: 1, count: 1 },
      { miners: 3, count: 1 },
      { miners: 17, count: 1 },
      { miners: 1, count: 4 },
      { miners: 3, count: 4 },
      { miners: 17, count: 4 },
      { miners: 1, count: atCap },
    ];
    const { dir, store, now } = freshStore(widths.length);
    let clock = now;
    for (const width of widths) {
      clock += 90_000;
      const rows = rowsFor(width.miners, width.count, 0);
      const tpl = childOf(store, rows, clock);
      const honestHeader = Buffer.from(tpl.header);
      // The honest block claims its own ShearHash. Every attack keeps that
      // header and claim, so the share slot is the only thing that differs.
      const honest = asBlock(tpl, Buffer.from(shearHash(honestHeader)));
      const tipBefore = store.tip().height;
      const label = `${width.miners}x${width.count}`;
      const attacks = [
        { name: 'flip', batch: honest.shareBatch.map((row) => ({ ...row, proofSlot: row.proofSlot === 0 ? 1 : 0 })) },
        {
          name: 'strip',
          batch: honest.shareBatch.map((row) => {
            const copy = { ...row };
            delete copy.proofSlot;
            return copy;
          }),
        },
        { name: 'wrong', batch: honest.shareBatch.map((row) => ({ ...row, proofSlot: 2 })) },
      ];
      for (const attack of attacks) {
        const bad = { ...honest, header: Buffer.from(honestHeader), shareBatch: attack.batch };
        const got = appendBlock(store, bad, honest.hash);
        assert.equal(got.ok, false, `${label} ${attack.name} ${got.reason}`);
        assert.equal(got.reason, 'share_slot', `${label} ${attack.name}`);
        assert.ok(Buffer.from(bad.header).equals(honestHeader));
        assert.equal(store.tip().height, tipBefore);
        const wire = encodeWireBlock({ ...honest, shareBatch: tpl.shareBatch });
        const packed = Buffer.from(wire.sharePacked, 'hex');
        if (attack.name === 'flip') {
          const flipped = eachFrame(packed, (f) => {
            f[f.length - SLOT_FROM_END] ^= 1;
            return f;
          });
          const decoded = decodeWireBlock({ ...wire, sharePacked: flipped.toString('hex') });
          const wireGot = appendBlock(store, { ...decoded, hash: honest.hash }, honest.hash);
          assert.equal(wireGot.reason, 'share_slot', `wire ${label}`);
          const ipc = applyVerifiedIpcBlock(store, {
            type: 'ipc_block',
            magic: MAGIC_TESTNET,
            block: { ...wire, sharePacked: flipped.toString('hex') },
            powHash: honest.hash.toString('hex'),
          });
          assert.equal(ipc.ok, false);
          assert.equal(ipc.reason, 'share_slot', `ipc ${label}`);
        } else {
          // strip drops the slot byte; wrong writes slot 2. Neither decodes.
          const mangled = eachFrame(packed, (f) => {
            if (attack.name === 'strip') return Buffer.concat([f.subarray(0, f.length - SLOT_FROM_END), f.subarray(f.length - 1)]);
            f[f.length - SLOT_FROM_END] = 2;
            return f;
          });
          assert.throws(() => unpackShareBatchBytes(mangled), /bad_share_blu/);
          const broken = { ...wire, sharePacked: mangled.toString('hex') };
          assert.throws(() => decodeWireBlock(broken), /bad_share_blu/);
          const ipc = applyVerifiedIpcBlock(store, {
            type: 'ipc_block',
            magic: MAGIC_TESTNET,
            block: broken,
            powHash: honest.hash.toString('hex'),
          });
          assert.equal(ipc.reason, 'decode', `ipc ${attack.name} ${label}`);
        }
        assert.equal(store.tip().height, tipBefore);
        assert.ok(Buffer.from(honest.header).equals(honestHeader));
      }
      const emptyBatch = { ...honest, header: Buffer.from(honestHeader), shareBatch: [] };
      const emptied = appendBlock(store, emptyBatch, honest.hash);
      assert.equal(emptied.reason, 'share_slot');
      assert.equal(store.tip().height, tipBefore);
      const again = childOf(store, rows, clock);
      const pow = easyPow();
      const ok = appendBlock(store, asBlock(again, pow), pow);
      assert.equal(ok.ok, true, `${label} honest ${ok.reason}`);
      assert.equal(store.tip().height, tipBefore + 1);
      const opened = unpackShareBatchBytes(packShareBatchBytes(store.tip().shareBatch));
      assert.equal(opened.length, width.count);
      assert.equal(opened.filter((row) => row.proofSlot === 0).length, width.count);
    }
    const reloaded = createStore(dir);
    assert.equal(reloaded.blocks.length, store.blocks.length);
    for (let i = 0; i < store.blocks.length; i += 1) {
      const want = packShareBatchBytes(store.blocks[i].shareBatch || []);
      const got = packShareBatchBytes(reloaded.blocks[i].shareBatch || []);
      assert.ok(want.equals(got), `reload block ${i}`);
    }
    const tip = reloaded.tip();
    assert.equal(tip.samplesPruned, false);
    const parent = reloaded.blocks[reloaded.blocks.length - 2];
    const pruned = pruneSamples(tip);
    // R28: the payout record survives pruning; the frames do not.
    assert.equal(pruned.blunoteRecord, tip.blunoteRecord);
    assert.equal(pruned.shareBatch.length, 0);
    assert.throws(() => pruneSamples({ ...tip, blunoteRecord: undefined, txs: [{ ...tip.txs[0], vout: [] }] }), /prune_refuses_empty_coinbase/);
    const buried = verifyBlock(pruned, {
      hash: parent.hash,
      header: parent.header,
      height: parent.height,
      txs: parent.txs,
      shareBatch: parent.shareBatch,
      blunoteRecord: parent.blunoteRecord,
    }, {
      loadReplay: true,
      tipHeight: tip.height + SAMPLE_PRUNE_CONFIRMATIONS,
      trustedPowHash: tip.hash,
      skipSharePow: true,
      nowMs: Date.now(),
      magic: MAGIC_TESTNET,
    });
    assert.notEqual(buried.reason, 'share_slot');
    const unburied = shareSlotCommitment(tip.txs[0], [], { samplesPruned: false, buried: false });
    assert.equal(unburied, 'share_slot');
  });

  it('a share binds only the header its slot names', () => {
    const { store, now } = freshStore();
    const first = rowsFor(1, 1, 0);
    const midTpl = childOf(store, first, now + 90_000);
    const midPow = easyPow();
    assert.equal(appendBlock(store, asBlock(midTpl, midPow), midPow).ok, true, 'parent seal');
    assert.equal(store.tip().shareBatch[0].proofSlot, 0);
    // A share bound on the tip header but claiming slot 1 (the grandparent):
    // its nonce does not bind there.
    const tip = store.tip();
    const misnamed = rowsFor(1, 1, 0);
    clearLiveSharePow();
    plant(tip.header, misnamed[0]);
    const prior = store.blocks[store.blocks.length - 2].header;
    stashSharePow(setNonce(Buffer.from(prior), misnamed[0].nonce), RX);
    const quote = quoteFor(store, now + 180_000);
    const tpl = buildTemplate({
      prev: tip.hash,
      prevHeader: tip.header,
      prevBlock: tip,
      height: tip.height + 1,
      miner: MINER,
      bits: quote.packed,
      now: now + 180_000,
      shareBatch: [{ ...misnamed[0], proofSlot: 1 }],
      parentBlocks: store.blocks,
    });
    assert.equal(tpl.shareBatch.length, 1);
    const pow = easyPow();
    const got = appendBlock(store, asBlock(tpl, pow), pow);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'share_bind');
    // Named as slot 0, the same share binds and is paid.
    const named = childOf(store, misnamed, now + 180_000);
    const pow2 = easyPow();
    const ok = appendBlock(store, asBlock(named, pow2), pow2);
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(store.tip().shareBatch[0].proofSlot, 0);
  });
});
