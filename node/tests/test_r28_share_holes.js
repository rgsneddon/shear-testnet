// R28 regression tests for the share-research holes H1-H4 and H7
// (Desktop PR130-review/hash-bonus-share-structure-research.md, 27 Oct),
// plus the BluNotes block rules. The hole tests failed on feat 2f6e9962
// at 41e7accd (run r28hfeat4 on p2p-b): H1 re-aimed hash credited, H2
// paid work owed again as spill, H3 seated and spilled, H4 kin paid twice,
// H7 48.8 MB of hex over a 16 MiB frame. Here they must pass.
// Share PoW is real ShearHash-v3: every share is ground until its digest
// meets its width, and verify re-hashes it. Block headers use
// trustedPowHash, as the other chain tests do; block PoW is not under test.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fluxsetFromBlocks, admitBasePub, emptyFluxset } from '../../crypto/admit.js';
import { setHashBackend, shearHash, meetsTarget, leadingZeroBits } from '../../crypto/shear_hash.js';
import { decodeHeader, setNonce } from '../../crypto/header.js';
import {
  GENESIS_BITS_PACKED,
  POOL_FEE_BPS,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
} from '../../crypto/asert.js';
import { pointBytes } from '../../crypto/note.js';
import { verifyShareBatch } from '../../crypto/share_batch.js';
import {
  SHARE_BYTES_MAX,
  bindNonce,
  bindingOk,
  decodeRecord,
  oneTimeKey,
  recogniseOneTime,
  recordRoot,
  scanPub,
  scanScalar,
} from '../../crypto/blunote.js';
import { P2P_MAX_FRAME, encodeWireBlock, decodeWireBlock } from '../src/p2p.js';
import { GENESIS_PREV, buildTemplate, verifyBlock } from '../src/chain.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const NOW = 1_700_000_000_000;
const BITS = SHARE_FLOOR_BITS;

function wallet() {
  const seed = randomBytes(32);
  return { seed, B: pointBytes(admitBasePub(seed)), Y: scanPub(seed), y: scanScalar(seed) };
}

const POOL = wallet();
function poolFeeKey() {
  const k = oneTimeKey({ B: POOL.B, Y: POOL.Y });
  return { R: k.R, P: k.P, viewTag: k.tag };
}

/**
 * Grind a real BluNotes share for `owner` on `header`: a fresh one-time key,
 * then the 256 nonces its binding allows, then a new key.
 */
function mineShare(owner, header, { slot = 0, kin = false, bits = BITS } = {}) {
  for (let keys = 0; keys < 4096; keys += 1) {
    const k = oneTimeKey({ B: owner.B, Y: owner.Y });
    for (let c = 0; c < 256; c += 1) {
      const nonce = bindNonce(header, k.R, k.P, c, bits);
      const rx = shearHash(setNonce(Buffer.from(header), nonce));
      if (!meetsTarget(rx, bits)) continue;
      return {
        shareR: k.R,
        shareP: k.P,
        viewTag: k.tag,
        nonce,
        lz: leadingZeroBits(rx),
        shareBits: bits,
        proofSlot: slot,
        verifiedHeader: Buffer.from(header),
        ...(kin ? { kinHeader: true } : {}),
      };
    }
  }
  throw new Error('no share found');
}

/** Build and verify a block as a node would, and keep its record as the store does. */
function child(parents, { shareBatch = [], hashSpill = [], issuedHeaders = null, wire = false, mutate = null, templateFlux = null } = {}) {
  const prevBlock = parents.length ? parents[parents.length - 1] : null;
  const grand = parents.length >= 2 ? parents[parents.length - 2] : null;
  const height = prevBlock ? prevBlock.height + 1 : 1;
  const when = NOW + (height - 1) * TARGET_BLOCK_INTERVAL_MS;
  let bits = GENESIS_BITS_PACKED;
  if (prevBlock) {
    const q = asertNextBits({
      anchorBits: GENESIS_BITS_PACKED,
      anchorTimeMs: NOW,
      anchorHeight: 1,
      blockTimeMs: when,
      blockHeight: height,
      parentTimeMs: Number(decodeHeader(Buffer.from(prevBlock.header)).timestamp),
    });
    assert.equal(q.ok, true, q.reason);
    bits = q.packed;
  }
  const parentFlux = fluxsetFromBlocks(parents);
  const tpl = buildTemplate({
    prev: prevBlock ? prevBlock.hash : GENESIS_PREV,
    prevHeader: prevBlock ? prevBlock.header : null,
    prevBlock,
    height,
    miner: MINER,
    bits,
    now: when,
    shareBatch,
    hashSpill,
    issuedHeaders,
    poolDest: MINER,
    parentBlocks: parents,
    parentFluxset: templateFlux || parentFlux,
    feeKey: poolFeeKey(),
    feeBps: POOL_FEE_BPS,
  });
  let block = {
    header: tpl.header,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    hashSpill: Array.isArray(hashSpill) && hashSpill.length ? hashSpill : (tpl.hashSpill || []),
    miner: MINER,
    poolDest: MINER,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height,
  };
  if (typeof mutate === 'function') block = mutate(block) || block;
  const tag = Buffer.alloc(32);
  tag.writeUInt32LE(height, 4);
  if (wire) block = { ...decodeWireBlock(encodeWireBlock({ ...block, hash: tag })), height };
  const verdict = verifyBlock(block, prevBlock, {
    trustedPowHash: tag,
    nowMs: when + 1_000,
    genesisMs: NOW,
    poolDest: MINER,
    grandparentHeader: grand ? grand.header : null,
    supplyParents: parents,
    parentFluxset: parentFlux,
  });
  if (verdict.ok) {
    block.hash = verdict.hash;
    block.blunoteRecord = verdict.blunoteRecord;
  }
  return { block, verdict, tpl };
}

describe('R28 share holes (each failed on feat 2f6e9962)', () => {
  let g;
  before(() => {
    const got = child([]);
    assert.equal(got.verdict.ok, true, got.verdict.reason);
    g = got.block;
  });

  it('H1: a RandomX hash cannot be re-aimed at a different payee after hashing', () => {
    const me = wallet();
    const a = mineShare(me, g.header);
    // Control: the honest share verifies.
    const honest = verifyShareBatch({ parentHeader: g.header, shares: [a] });
    assert.equal(honest.ok, true, honest.reason);
    // The attacker keeps the nonce (no new RandomX hash) and tries 2^14 other
    // payees; none binds, so none is creditable.
    let bound = 0;
    for (let i = 0; i < 1 << 14; i += 1) {
      const k = oneTimeKey(wallet());
      if (bindingOk(g.header, a.nonce, k.R, k.P)) bound += 1;
    }
    assert.equal(bound, 0, 'a re-aimed payee bound to an existing nonce');
    const k = oneTimeKey(wallet());
    const stolen = verifyShareBatch({ parentHeader: g.header, shares: [{ ...a, shareR: k.R, shareP: k.P }] });
    assert.equal(stolen.ok, false);
    assert.equal(stolen.reason, 'share_bind');
  });

  it('H2: a share paid in block N is not paid again in N+1, and spill is refused', () => {
    const s = mineShare(wallet(), g.header);
    const b2 = child([g], { shareBatch: [s] });
    assert.equal(b2.verdict.ok, true, b2.verdict.reason);
    // Control: unpaid work on the same header seats as slot 1 in block 3.
    const fresh = mineShare(wallet(), g.header, { slot: 1 });
    const ok3 = child([g, b2.block], { shareBatch: [fresh] });
    assert.equal(ok3.verdict.ok, true, ok3.verdict.reason);
    // s won block 2's draw, so its P is now a note and a knowing template
    // drops it (attack 8). Forced in, the paid-work check refuses it first.
    const dropped = child([g, b2.block], { shareBatch: [{ ...s, proofSlot: 1 }] });
    assert.equal(dropped.block.shareBatch.length, 0);
    const again = child([g, b2.block], { shareBatch: [{ ...s, proofSlot: 1 }], templateFlux: emptyFluxset() });
    assert.equal(again.block.shareBatch.length, 1);
    assert.equal(again.verdict.ok, false);
    assert.equal(again.verdict.reason, 'paid_share');
    const spilled = child([g, b2.block], { hashSpill: [{ ...s, proofSlot: 1 }] });
    assert.equal(spilled.verdict.ok, false);
    assert.equal(spilled.verdict.reason, 'hash_spill');
  });

  it('H3: one share is not paid as both a seat and spill in one block', () => {
    const s = mineShare(wallet(), g.header, { slot: 1 });
    const b2 = child([g]);
    assert.equal(b2.verdict.ok, true, b2.verdict.reason);
    // Control: seated alone, after the wire round trip a peer sees.
    const seat = child([g, b2.block], { shareBatch: [s], wire: true });
    assert.equal(seat.verdict.ok, true, seat.verdict.reason);
    const both = child([g, b2.block], { shareBatch: [s], hashSpill: [s], wire: true });
    assert.equal(both.verdict.ok, false, 'one share was seated and spilled in the same block');
  });

  it('H4: a kin share paid in block N is not paid again in N+1', () => {
    // A sibling template of genesis: same round family, a later timestamp.
    const kin = Buffer.from(g.header);
    kin.writeBigUInt64LE(decodeHeader(kin).timestamp + 1n, 100);
    const s = mineShare(wallet(), kin, { kin: true });
    const b2 = child([g], { shareBatch: [s], issuedHeaders: [kin] });
    assert.equal(b2.verdict.ok, true, b2.verdict.reason);
    assert.equal(b2.block.shareBatch.length, 1);
    // Control: a different kin share on the same sibling is paid in block 3.
    const other = mineShare(wallet(), kin, { kin: true, slot: 1 });
    const ok3 = child([g, b2.block], { shareBatch: [other], issuedHeaders: [kin] });
    assert.equal(ok3.verdict.ok, true, ok3.verdict.reason);
    // Forced in past a knowing template (its P won block 2's draw).
    const b3 = child([g, b2.block], { shareBatch: [{ ...s, proofSlot: 1 }], issuedHeaders: [kin], templateFlux: emptyFluxset() });
    assert.equal(b3.block.shareBatch.length, 1);
    assert.equal(b3.verdict.ok, false, 'a kin share paid in block 2 was paid again in block 3');
    assert.equal(b3.verdict.reason, 'paid_share');
  });

  it('H7: every valid block fits one p2p frame, and the byte cap is checked before any hash', () => {
    // Share frames as hex, plus the 8 MiB hex IPC envelope the rest of a block fits in.
    assert.ok(2 * SHARE_BYTES_MAX + 8 * 1024 * 1024 <= P2P_MAX_FRAME, 'share cap plus envelope above P2P_MAX_FRAME');
    // One frame over the cap. None has PoW, so a refusal other than
    // share_bytes would mean a hash ran first.
    const k = oneTimeKey(wallet());
    const n = Math.floor(SHARE_BYTES_MAX / 89) + 1;
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      rows.push({ shareR: k.R, shareP: k.P, viewTag: 0, nonce: BigInt(i), lz: 0, shareBits: BITS, proofSlot: 0 });
    }
    const got = verifyShareBatch({ parentHeader: g.header, shares: rows });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'share_bytes');
  });
});

describe('R28 BluNotes blocks', () => {
  let g;
  before(() => {
    const got = child([]);
    assert.equal(got.verdict.ok, true, got.verdict.reason);
    g = got.block;
  });

  it('pays winners the miner alone can find, and records them', () => {
    const me = wallet();
    const shares = [mineShare(me, g.header), mineShare(me, g.header), mineShare(wallet(), g.header)];
    const b2 = child([g], { shareBatch: shares });
    assert.equal(b2.verdict.ok, true, b2.verdict.reason);
    const rec = decodeRecord(Buffer.from(b2.block.blunoteRecord, 'hex'));
    assert.equal(rec.n, 3);
    assert.equal(rec.winners.reduce((a, w) => a + w.m, 0), 16);
    // No payee note sits in the coinbase.
    for (const o of b2.block.txs[0].vout) assert.equal(o.kind, 'reserve-fee');
    // Every winner is one of this block's shares; only its owner recognises it.
    const mine = new Set(shares.slice(0, 2).map((s) => s.shareP.toString('hex')));
    for (const w of rec.winners) {
      const sh = shares.find((s) => s.shareP.equals(w.P));
      assert.ok(sh);
      const found = recogniseOneTime({ y: me.y, B: me.B }, w.R, w.P, sh.viewTag) != null;
      assert.equal(found, mine.has(w.P.toString('hex')));
    }
  });

  it('binds the parent record under the next block, and refuses a wrong one', () => {
    const b2 = child([g], { shareBatch: [mineShare(wallet(), g.header)] });
    assert.equal(b2.verdict.ok, true, b2.verdict.reason);
    // The record crosses the wire with its block (a pruned block keeps only it).
    const wired = decodeWireBlock(encodeWireBlock(b2.block));
    assert.equal(wired.blunoteRecord, b2.block.blunoteRecord);
    const b3 = child([g, b2.block]);
    assert.equal(b3.verdict.ok, true, b3.verdict.reason);
    assert.equal(Buffer.from(b3.block.txs[0].blunote.prev).toString('hex'), recordRoot(Buffer.from(b2.block.blunoteRecord, 'hex')).toString('hex'));
    const lied = child([g, b2.block], {
      mutate: (b) => {
        b.txs[0] = { ...b.txs[0], blunote: { ...b.txs[0].blunote, prev: Buffer.alloc(32, 7) } };
        return b;
      },
    });
    assert.equal(lied.verdict.ok, false);
  });

  it('refuses a payee note in the coinbase', () => {
    const b2 = child([g], {
      shareBatch: [mineShare(wallet(), g.header)],
      mutate: (b) => {
        b.txs[0] = { ...b.txs[0], vout: [...b.txs[0].vout, { kind: 'pot', nanos: 1 }] };
        return b;
      },
    });
    assert.equal(b2.verdict.ok, false);
  });

  it('refuses a share whose one-time key is already a note (attack 8)', () => {
    // The genesis pool-fee note is in the admit set after genesis connects.
    const feeP = decodeRecord(Buffer.from(g.blunoteRecord, 'hex')).feeP;
    assert.ok(!feeP.equals(Buffer.alloc(32)));
    const owner = wallet();
    let reused = null;
    for (let c = 0; c < 256 * 64 && !reused; c += 1) {
      const R = oneTimeKey(owner).R;
      for (let n = 0; n < 256 && !reused; n += 1) {
        const nonce = bindNonce(g.header, R, feeP, n, BITS);
        const rx = shearHash(setNonce(Buffer.from(g.header), nonce));
        if (meetsTarget(rx, BITS)) {
          reused = { shareR: R, shareP: Buffer.from(feeP), viewTag: 0, nonce, lz: leadingZeroBits(rx), shareBits: BITS, proofSlot: 0, verifiedHeader: Buffer.from(g.header) };
        }
      }
    }
    assert.ok(reused);
    // A template that knows the admit set leaves the share out.
    const kept = child([g], { shareBatch: [reused] });
    assert.equal(kept.verdict.ok, true, kept.verdict.reason);
    assert.equal(kept.block.shareBatch.length, 0);
    // A block that seats it anyway is refused by every node.
    const forced = child([g], { shareBatch: [reused], templateFlux: emptyFluxset() });
    assert.equal(forced.block.shareBatch.length, 1);
    assert.equal(forced.verdict.ok, false);
    assert.equal(forced.verdict.reason, 'share_key');
  });

  it('an empty block carries the pot minus the fee and mints no floor note (R34)', () => {
    const b2 = child([g]);
    assert.equal(b2.verdict.ok, true, b2.verdict.reason);
    const rec = decodeRecord(Buffer.from(b2.block.blunoteRecord, 'hex'));
    assert.equal(rec.n, 0);
    assert.equal(rec.winners.length, 0);
    assert.ok(Number(b2.block.txs[0].carryNanos) > 0);
  });
});
