// R28 regression tests for the share-research holes H1-H4 and H7
// (Desktop PR130-review/hash-bonus-share-structure-research.md, 27 Oct).
// Each test states the rule R28 enforces. On feat 2f6e9962 each one fails,
// which is the hole; R28 makes it pass. Share PoW is real ShearHash-v3:
// every share here is ground until its digest meets its width, and verify
// re-hashes it (no skipSharePow, no remembered PoW). Block headers use
// trustedPowHash, as the other chain tests do; block PoW is not under test.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fluxsetFromBlocks } from '../../crypto/admit.js';
import { setHashBackend, shearHash, meetsTarget } from '../../crypto/shear_hash.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, setNonce } from '../../crypto/header.js';
import {
  GENESIS_BITS_PACKED,
  MAX_SHARES_PER_BLOCK,
  POOL_FEE_BPS,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
  potSubsidyNanos,
} from '../../crypto/asert.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import { freshCreditsFromShares } from '../../crypto/hash_owed.js';
import {
  clearLiveSharePow,
  destBoundShareHash,
  nonceWithShareTarget,
  noteCommitOfShare,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import { P2P_MAX_FRAME, encodeWireBlock, decodeWireBlock } from '../src/p2p.js';
import { GENESIS_PREV, buildTemplate, canonicalCarry, potSharesFromBatch, verifyBlock } from '../src/chain.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const NOW = 1_700_000_000_000;
const BITS = SHARE_FLOOR_BITS;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

/** Grind real nonces on `header` until the dest-bound digest meets `bits`. */
let nextLow = 1;
function mineShare(dest, header, bits = BITS) {
  const probe = { dest, nonce: 0n, lz: bits, shareBits: bits, creditedShareBits: bits };
  const nc = Buffer.from(noteCommitOfShare(probe));
  for (let tries = 0; tries < 1 << 16; tries += 1) {
    const nonce = nonceWithShareTarget(BigInt(nextLow), bits);
    nextLow += 1;
    const rx = shearHash(setNonce(Buffer.from(header), nonce));
    if (!meetsTarget(destBoundShareHash(rx, nc), bits)) continue;
    return {
      dest,
      nonce,
      lz: bits,
      shareBits: bits,
      creditedShareBits: bits,
      verifiedHeader: Buffer.from(header),
      hash: rx.toString('hex'),
      noteCommit: nc,
    };
  }
  throw new Error('no share found');
}

function genesisBlock() {
  const subsidy = potSubsidyNanos(0);
  const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: FEE,
    bits: GENESIS_BITS_PACKED,
    now: NOW,
    potShares: [{ address: FEE, nanos: fee, kind: 'pool-fee' }],
    poolDest: FEE,
  });
  const block = {
    header: tpl.header,
    txs: tpl.txs,
    shareBatch: [],
    hashSpill: [],
    miner: FEE,
    poolDest: FEE,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height: 1,
  };
  const v = verifyBlock(block, null, {
    trustedPowHash: Buffer.from('00'.repeat(31) + '01', 'hex'),
    nowMs: NOW + 1_000,
    genesisMs: NOW,
  });
  assert.equal(v.ok, true, v.reason);
  block.hash = v.hash;
  return block;
}

/** Build and verify a child as a real node would: template, then verify with share PoW on. */
function child(parents, { shareBatch = [], hashSpill = [], issuedHeaders = null, wire = false } = {}) {
  clearLiveSharePow();
  const prevBlock = parents[parents.length - 1];
  const grand = parents.length >= 2 ? parents[parents.length - 2] : null;
  const height = prevBlock.height + 1;
  const when = NOW + (height - 1) * TARGET_BLOCK_INTERVAL_MS;
  const q = asertNextBits({
    anchorBits: GENESIS_BITS_PACKED,
    anchorTimeMs: NOW,
    anchorHeight: 1,
    blockTimeMs: when,
    blockHeight: height,
    parentTimeMs: Number(decodeHeader(Buffer.from(prevBlock.header)).timestamp),
  });
  assert.equal(q.ok, true, q.reason);
  const subsidy = potSubsidyNanos(0);
  // The parent's unminted pot carries in, as a node's template does.
  const potShares = potSharesFromBatch(shareBatch, FEE, subsidy, canonicalCarry(prevBlock.txs[0]) || 0);
  const parentFlux = fluxsetFromBlocks(parents);
  const tpl = buildTemplate({
    prev: prevBlock.hash,
    prevHeader: prevBlock.header,
    prevBlock,
    height,
    miner: FEE,
    bits: q.packed,
    now: when,
    potShares,
    shareBatch,
    hashSpill,
    issuedHeaders,
    poolDest: FEE,
    parentBlocks: parents,
    parentFluxset: parentFlux,
  });
  let block = {
    header: tpl.header,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    hashSpill: tpl.hashSpill || [],
    miner: FEE,
    poolDest: FEE,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height,
  };
  // The sealed credit columns, stamped as the store does before it relays
  // a block (stampCredits, node/src/store.js).
  block.hashCredits = Array.isArray(tpl.hashCredits) ? tpl.hashCredits : freshCreditsFromShares(block.shareBatch);
  if (block.hashSpill.length) block.hashSpillCredits = freshCreditsFromShares(block.hashSpill);
  const tag = Buffer.alloc(32);
  tag.writeUInt32LE(height, 4);
  if (wire) block = { ...decodeWireBlock(encodeWireBlock({ ...block, hash: tag })), height };
  const verdict = verifyBlock(block, prevBlock, {
    trustedPowHash: tag,
    nowMs: when + 1_000,
    genesisMs: NOW,
    poolDest: FEE,
    grandparentHeader: grand ? grand.header : null,
    supplyParents: parents,
    parentFluxset: parentFlux,
  });
  if (verdict.ok) block.hash = verdict.hash;
  return { block, verdict, tpl };
}

describe('R28 share holes (each fails on feat 2f6e9962)', () => {
  let g;
  before(() => { g = genesisBlock(); });

  it('H1: a RandomX hash cannot be re-aimed at a different payee after hashing', () => {
    // An honest share for payee A, on the genesis header.
    const a = mineShare(minerDest(), g.header);
    // The attacker keeps A's nonce, so no new RandomX hash, and tries other
    // payees until the cheap post-hash step passes for one of them.
    const rx = Buffer.from(a.hash, 'hex');
    let stolen = null;
    for (let i = 0; i < 1 << 14 && !stolen; i += 1) {
      const dest = minerDest();
      const nc = Buffer.from(noteCommitOfShare({ dest }));
      if (nc.equals(a.noteCommit)) continue;
      if (meetsTarget(destBoundShareHash(rx, nc), BITS)) stolen = { ...a, dest, noteCommit: nc };
    }
    assert.ok(stolen, 'grinding payees found no second payee');
    // Control: the honest share verifies.
    const honest = verifyShareBatch({ parentHeader: g.header, shares: [{ ...a, proofSlot: 0 }] });
    assert.equal(honest.ok, true, honest.reason);
    // Rule: the payee is fixed before the hash, so the re-aimed share is refused.
    const got = verifyShareBatch({ parentHeader: g.header, shares: [{ ...stolen, proofSlot: 0 }] });
    assert.equal(got.ok, false, 'one RandomX hash was credited to a payee chosen after hashing');
  });

  it('H2: a share paid in block N is not paid again as spill in N+1', () => {
    const s = mineShare(minerDest(), g.header);
    const b2 = child([g], { shareBatch: [s] });
    assert.equal(b2.verdict.ok, true, b2.verdict.reason);
    // The same work, now offered as slot-1 spill (g is b3's grandparent).
    // Control: unpaid work on the same header spills fine.
    const fresh = mineShare(minerDest(), g.header);
    const ok3 = child([g, b2.block], { hashSpill: [fresh] });
    assert.equal(ok3.verdict.ok, true, ok3.verdict.reason);
    const b3 = child([g, b2.block], { hashSpill: [s] });
    assert.equal(b3.verdict.ok, false, 'work paid in block 2 was owed again as spill in block 3');
  });

  it('H3: one share is not paid as both a slot-1 seat and spill in one block', () => {
    const s = mineShare(minerDest(), g.header);
    const b2 = child([g]);
    assert.equal(b2.verdict.ok, true, b2.verdict.reason);
    // Seated as slot 1 and spilled in the same block; checked as a peer
    // receives it, after the wire round trip that drops verifiedHeader.
    // Controls: seated alone, and spilled alone, both verify after the wire.
    const seat = child([g, b2.block], { shareBatch: [s], wire: true });
    assert.equal(seat.verdict.ok, true, seat.verdict.reason);
    const spill = child([g, b2.block], { hashSpill: [s], wire: true });
    assert.equal(spill.verdict.ok, true, spill.verdict.reason);
    const b3 = child([g, b2.block], { shareBatch: [s], hashSpill: [s], wire: true });
    assert.equal(b3.verdict.ok, false, 'one share was seated and spilled in the same block');
  });

  it('H4: a kin share paid in block N is not paid again in N+1', () => {
    // A sibling template of genesis: same round family, a later timestamp.
    // The pool hands each kin share with its claimed slot, as it does live.
    const kin = Buffer.from(g.header);
    kin.writeBigUInt64LE(decodeHeader(kin).timestamp + 1n, 100);
    const s = mineShare(minerDest(), kin);
    const b2 = child([g], { shareBatch: [{ ...s, proofSlot: 0 }], issuedHeaders: [kin] });
    assert.equal(b2.verdict.ok, true, b2.verdict.reason);
    assert.equal(b2.block.shareBatch.length, 1);
    // Control: a different kin share on the same sibling is paid in block 3.
    const other = mineShare(minerDest(), kin);
    const ok3 = child([g, b2.block], { shareBatch: [{ ...other, proofSlot: 1 }], issuedHeaders: [kin] });
    assert.equal(ok3.verdict.ok, true, ok3.verdict.reason);
    assert.equal(ok3.block.shareBatch.length, 1);
    const b3 = child([g, b2.block], { shareBatch: [{ ...s, proofSlot: 1 }], issuedHeaders: [kin] });
    assert.equal(b3.verdict.ok, false, 'a kin share paid in block 2 was paid again in block 3');
  });

  it('H7: every consensus-valid block can be relayed in one p2p frame', () => {
    // Largest share load consensus allows today: a full kin batch plus a full
    // spill, sent as hex. A block peers cannot relay must not be valid.
    const KIN_FRAME = 2 + 184;
    const hexBytes = 2 * (4 + MAX_SHARES_PER_BLOCK * KIN_FRAME) * 2;
    assert.ok(hexBytes <= P2P_MAX_FRAME, `max share load ${hexBytes} B of hex > P2P_MAX_FRAME ${P2P_MAX_FRAME} B`);
  });
});
