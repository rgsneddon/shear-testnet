import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  MAX_SHARES_PER_BLOCK,
  SAMPLE_PRUNE_CONFIRMATIONS,
  SHARE_FLOOR_BITS,
  asertNextBits,
} from '../../crypto/asert.js';
import { pruneSamples } from '../../crypto/chronoflux.js';
import { decodeHeader, setNonce } from '../../crypto/header.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import {
  packShareBatchBytes,
  shareSlotCommitment,
  shareSlotRoot,
  unpackShareBatchBytes,
} from '../../crypto/pack.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  clearLiveSharePow,
  destBoundShareHash,
  nonceWithShareTarget,
  noteCommitOfShare,
  stashSharePow,
} from '../../crypto/share_batch.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  GENESIS_PREV,
  buildTemplate,
  canonicalCarry,
  potSharesFromBatch,
  verifyBlock,
} from '../src/chain.js';
import { encodeWireBlock, decodeWireBlock } from '../src/p2p.js';
import { applyVerifiedIpcBlock } from '../src/p2p_ipc.js';
import { createStore } from '../src/store.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-slot-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

let powTag = 1;
function easyPow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  powTag += 1;
  assert.equal(meetsTarget(h, GENESIS_BITS_PACKED), true);
  return h;
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function rxForBits(noteCommit, meet, miss) {
  const limit = meet <= 16 ? 250_000 : 20_000;
  for (let i = 0; i < limit; i += 1) {
    const rx = Buffer.alloc(32);
    rx.writeUInt32LE(i, 0);
    rx.writeUInt32LE((i * 17) >>> 0, 4);
    const bound = destBoundShareHash(rx, noteCommit);
    if (meetsTarget(bound, meet) && (miss == null || !meetsTarget(bound, miss))) return rx;
  }
  return null;
}

function shareRow(dest, low, slot) {
  const bits = SHARE_FLOOR_BITS;
  const row = {
    dest,
    nonce: nonceWithShareTarget(BigInt(low), bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    proofSlot: slot,
  };
  row.noteCommit = Buffer.from(noteCommitOfShare(row));
  return row;
}

function rowsFor(dests, count, slot = 0) {
  const rows = [];
  let low = 1;
  for (let i = 0; i < count; i += 1) {
    rows.push(shareRow(dests[i % dests.length], low, slot));
    low += 1;
  }
  return rows;
}

const rxByNote = new Map();
function plant(header, row) {
  const nc = noteCommitOfShare(row);
  const hex = Buffer.from(nc).toString('hex');
  let rx = rxByNote.get(hex);
  if (!rx) {
    rx = rxForBits(nc, row.shareBits, row.shareBits + 1);
    assert.ok(rx, 'bound digest');
    rxByNote.set(hex, rx);
  }
  stashSharePow(setNonce(Buffer.from(header), BigInt(row.nonce)), rx);
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

function asBlock(tpl, miner, hash) {
  return {
    header: Buffer.from(tpl.header),
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: (tpl.shareBatch || []).map((s) => ({ ...s })),
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hashCredits: tpl.hashCredits,
    hash,
    height: tpl.height,
  };
}

function freshStore(childCount = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-slot-'));
  const store = createStore(dir);
  const dest = minerDest();
  // Every child is 90s after its parent and still behind HEADER_AHEAD.
  const now = Date.now() - (childCount + 3) * 90_000;
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: dest,
    bits: GENESIS_BITS_PACKED,
    now,
  });
  const pow = easyPow();
  const got = store.append(asBlock(tpl, dest, pow), { trustedPowHash: pow, skipSharePow: true });
  assert.equal(got.ok, true, got.reason || 'height 1');
  assert.equal(store.tip().height, 1);
  return { dir, store, dest, now };
}

function childOf(store, rows, now) {
  const tip = store.tip();
  const genesis = decodeHeader(store.blocks[0].header);
  const subsidy = potSubsidyAt({
    nowMs: now,
    genesisMs: Number(genesis.timestamp),
    magic: MAGIC_TESTNET,
  });
  const carry = canonicalCarry(tip.txs[0]) || 0;
  const pays = potSharesFromBatch(rows, null, subsidy, carry);
  const sum = pays.reduce((n, row) => n + row.nanos, 0);
  assert.equal(sum, subsidy + carry);
  const quote = quoteFor(store, now);
  assert.equal(quote.ok, true, quote.reason || 'asert');
  clearLiveSharePow();
  const provedOn = rows[0].proofSlot === 1 && store.blocks.length >= 2
    ? store.blocks[store.blocks.length - 2].header
    : tip.header;
  for (const row of rows) {
    const header = row.proofSlot === 1 ? provedOn : tip.header;
    plant(header, row);
  }
  const tpl = buildTemplate({
    prev: tip.hash,
    prevHeader: tip.header,
    prevBlock: tip,
    height: tip.height + 1,
    miner: rows[0].dest,
    bits: quote.packed,
    now,
    potShares: pays,
    shareBatch: rows,
    parentBlocks: store.blocks,
  });
  assert.ok(Buffer.from(tpl.txs[0].shareSlotRoot).equals(shareSlotRoot(tpl.shareBatch)));
  return tpl;
}

function appendBlock(store, block, pow) {
  return store.append(block, { trustedPowHash: pow, poolDest: block.miner });
}

describe('v12 proofSlot is bound by the block', () => {
  it('rejects a flipped, stripped, or wrong slot and still accepts the honest block', () => {
    const widths = [
      { dests: 1, count: 1 },
      { dests: 3, count: 1 },
      { dests: 17, count: 1 },
      { dests: 1, count: 4 },
      { dests: 3, count: 4 },
      { dests: 17, count: 4 },
      { dests: 1, count: MAX_SHARES_PER_BLOCK - 1 },
    ];
    const { dir, store, now } = freshStore(widths.length);
    let clock = now;
    for (const width of widths) {
      clock += 90_000;
      const dests = Array.from({ length: width.dests }, () => minerDest());
      const rows = rowsFor(dests, width.count, 0);
      const slotsBefore = rows.map((row) => row.proofSlot);
      const tpl = childOf(store, rows, clock);
      assert.deepEqual(rows.map((row) => row.proofSlot), slotsBefore);
      const honestHeader = Buffer.from(tpl.header);
      const honest = asBlock(tpl, dests[0], easyPow());
      const tipBefore = store.tip().height;
      const attacks = [
        {
          name: 'flip',
          batch: honest.shareBatch.map((row) => ({ ...row, proofSlot: row.proofSlot === 0 ? 1 : 0 })),
          reason: 'share_slot',
        },
        {
          name: 'strip',
          batch: honest.shareBatch.map((row) => {
            const copy = { ...row };
            delete copy.proofSlot;
            return copy;
          }),
          reason: 'share_slot',
        },
        {
          name: 'wrong',
          batch: honest.shareBatch.map((row) => ({ ...row, proofSlot: 2 })),
          reason: 'share_slot',
        },
      ];
      for (const attack of attacks) {
        const bad = { ...honest, header: Buffer.from(honestHeader), shareBatch: attack.batch };
        const got = appendBlock(store, bad, honest.hash);
        assert.equal(got.ok, false, `${width.dests}x${width.count} ${attack.name} ${got.reason}`);
        assert.equal(got.reason, attack.reason, `${width.dests}x${width.count} ${attack.name}`);
        assert.ok(Buffer.from(bad.header).equals(honestHeader));
        assert.equal(store.tip().height, tipBefore);
        const wire = encodeWireBlock({ ...honest, shareBatch: tpl.shareBatch });
        if (attack.name === 'flip') {
          const packed = Buffer.from(wire.sharePacked, 'hex');
          const n = packed.readUInt32LE(0);
          let o = 4;
          for (let i = 0; i < n; i += 1) {
            const len = packed.readUInt16LE(o);
            o += 2;
            packed[o + len - 1] ^= 1;
            o += len;
          }
          wire.sharePacked = packed.toString('hex');
          const decoded = decodeWireBlock(wire);
          const wireGot = appendBlock(store, { ...decoded, hash: honest.hash }, honest.hash);
          assert.equal(wireGot.reason, 'share_slot', `wire ${width.dests}x${width.count}`);
          const ipc = applyVerifiedIpcBlock(store, {
            type: 'ipc_block',
            magic: MAGIC_TESTNET,
            block: { ...wire, sharePacked: packed.toString('hex') },
            powHash: honest.hash.toString('hex'),
          });
          assert.equal(ipc.ok, false);
          assert.equal(ipc.reason, 'share_slot', `ipc ${width.dests}x${width.count}`);
        } else {
          const packed = Buffer.from(wire.sharePacked, 'hex');
          const n = packed.readUInt32LE(0);
          const parts = [Buffer.alloc(4)];
          parts[0].writeUInt32LE(n, 0);
          let o = 4;
          for (let i = 0; i < n; i += 1) {
            const len = packed.readUInt16LE(o);
            o += 2;
            const frame = Buffer.from(packed.subarray(o, o + len));
            o += len;
            const body = attack.name === 'strip' ? frame.subarray(0, frame.length - 1) : frame;
            if (attack.name === 'wrong') body[body.length - 1] = 2;
            const l = Buffer.alloc(2);
            l.writeUInt16LE(body.length, 0);
            parts.push(l, body);
          }
          const mangled = Buffer.concat(parts);
          assert.throws(() => unpackShareBatchBytes(mangled), /bad_share_work/);
          const broken = { ...wire, sharePacked: mangled.toString('hex') };
          assert.throws(() => decodeWireBlock(broken), /bad_share_work/);
          const ipc = applyVerifiedIpcBlock(store, {
            type: 'ipc_block',
            magic: MAGIC_TESTNET,
            block: broken,
            powHash: honest.hash.toString('hex'),
          });
          assert.equal(ipc.reason, 'decode', `ipc ${attack.name} ${width.dests}x${width.count}`);
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
      const ok = appendBlock(store, asBlock(again, dests[0], pow), pow);
      assert.equal(ok.ok, true, `${width.dests}x${width.count} honest ${ok.reason}`);
      assert.equal(store.tip().height, tipBefore + 1);
      const packed = packShareBatchBytes(store.tip().shareBatch);
      const opened = unpackShareBatchBytes(packed);
      assert.equal(opened.length, width.count);
      for (const row of opened) assert.equal(row.proofSlot === 0 || row.proofSlot === 1, true);
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
    const buried = verifyBlock(pruned, {
      hash: parent.hash,
      header: parent.header,
      height: parent.height,
      txs: parent.txs,
      shareBatch: parent.shareBatch,
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

  it('pays the same nonce on the other header only when that header is named', () => {
    const { store, dest, now } = freshStore();
    const first = rowsFor([dest], 1, 0);
    const midNow = now + 90_000;
    const midTpl = childOf(store, first, midNow);
    const midPow = easyPow();
    const mid = appendBlock(store, asBlock(midTpl, dest, midPow), midPow);
    assert.equal(mid.ok, true, mid.reason || 'parent seal');
    const nonce = first[0].nonce;
    assert.equal(store.tip().shareBatch.length, 1);
    assert.equal(store.tip().shareBatch[0].proofSlot, 0);
    const nextNow = midNow + 90_000;
    const namedPrior = rowsFor([dest], 1, 1);
    namedPrior[0].nonce = nonce;
    namedPrior[0].noteCommit = Buffer.from(noteCommitOfShare(namedPrior[0]));
    const priorTpl = childOf(store, namedPrior, nextNow);
    const priorPow = easyPow();
    const priorGot = appendBlock(store, asBlock(priorTpl, dest, priorPow), priorPow);
    assert.equal(priorGot.ok, false);
    assert.equal(priorGot.reason, 'share_pow');
    assert.equal(store.tip().height, 2);
    const absentTpl = childOf(store, rowsFor([dest], 1, 0), nextNow);
    const absent = asBlock(absentTpl, dest, easyPow());
    absent.shareBatch = absent.shareBatch.map((row) => {
      const copy = { ...row, nonce };
      delete copy.proofSlot;
      return copy;
    });
    const absentGot = appendBlock(store, absent, absent.hash);
    assert.equal(absentGot.reason, 'share_slot');
    assert.equal(store.tip().height, 2);
    const other = rowsFor([dest], 1, 0);
    other[0].nonce = nonce;
    other[0].noteCommit = Buffer.from(noteCommitOfShare(other[0]));
    const otherTpl = childOf(store, other, nextNow);
    const otherPow = easyPow();
    const otherGot = appendBlock(store, asBlock(otherTpl, dest, otherPow), otherPow);
    assert.equal(otherGot.ok, true, otherGot.reason || 'other header');
    assert.equal(store.tip().height, 3);
    assert.equal(store.tip().shareBatch[0].proofSlot, 0);
    assert.equal(store.tip().shareBatch[0].nonce, nonce);
    assert.equal(store.blocks[1].shareBatch[0].nonce, nonce);
    assert.equal(store.blocks[1].shareBatch[0].proofSlot, 0);
  });
});
