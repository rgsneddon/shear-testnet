import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newIdentity, freshStealthDest, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { BLOCK_SUBSIDY_NANOS, POOL_FEE_BPS, SHARE_FLOOR_BITS, GENESIS_BITS_PACKED, bitsForBlock, MAGIC_TESTNET } from '../../crypto/asert.js';
import { potSubsidyNanos, epochMs } from '../../crypto/pot_sched.js';
import { poolFeeDest } from '../../crypto/levy.js';
import { splitPot } from '../../pool/src/pool.js';
import { findShare, dest20OfShare } from '../../crypto/share_batch.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
  digestTx,
  potSharesFromBatch,
  custodyPotShares,
} from '../src/chain.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { coinbaseSplit as mintSplit } from '../../crypto/mint.js';
import { sealCoinbaseNote, excessOf, noteCommitOfDest20 } from '../../crypto/note.js';

function destOf(id) {
  return freshStealthDest(id).dest;
}

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    hash: found.hash,
  };
}

describe('coinbase pot is PROP across shareBatch dests', () => {
  it('kind:pot totals 1 SHE; hashers get pot minus 100 bps; pool dest gets only the fee', () => {
    const alice = destOf(newIdentity());
    const bob = destOf(newIdentity());
    const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
    const rest = BLOCK_SUBSIDY_NANOS - fee;
    const shares = splitPot([
      { miner: alice, count: 2 },
      { miner: bob, count: 2 },
    ], poolFeeDest());
    const pot = shares.filter((s) => s.kind === 'pot').reduce((a, s) => a + s.nanos, 0);
    const pool = shares.filter((s) => s.kind === 'pool-fee').reduce((a, s) => a + s.nanos, 0);
    assert.equal(pot + pool, BLOCK_SUBSIDY_NANOS);
    assert.equal(pot, rest);
    assert.equal(pool, fee);
    assert.equal(shares.find((s) => s.kind === 'pool-fee').address, poolFeeDest());
    assert.equal(shares.find((s) => s.address === alice).nanos, rest / 2);
    assert.equal(shares.find((s) => s.address === bob).nanos, rest / 2);

    const batch = [
      { dest: alice, dest20: dest20OfShare({ dest: alice }), nonce: 1n, lz: 8 },
      { dest: bob, dest20: dest20OfShare({ dest: bob }), nonce: 2n, lz: 8 },
    ];
    const prop = potSharesFromBatch(batch, poolFeeDest());
    const propPot = prop.reduce((a, s) => a + s.nanos, 0);
    assert.equal(propPot, BLOCK_SUBSIDY_NANOS);
    assert.equal(prop.find((s) => s.address === poolFeeDest()).nanos, fee);
  });

  it('rejects a block that pays the whole pot to the pool dest', () => {
    const hasher = destOf(newIdentity());
    const pool = poolFeeDest();
    const TRUSTED = Buffer.alloc(32);
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: hasher,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
    });
    const parent = {
      header: parentTpl.header,
      txs: parentTpl.txs,
      samples: parentTpl.samples,
      shareBatch: parentTpl.shareBatch || [],
      miner: hasher,
      aLeaves: parentTpl.aLeaves,
      bLeaves: parentTpl.bLeaves,
      weight: parentTpl.weight,
    };
    const okP = verifyBlock(parent, null, { trustedPowHash: TRUSTED });
    assert.equal(okP.ok, true, okP.reason);
    const now = 1_700_000_090_000;
    const ph = decodeHeader(parent.header);
    const row = { dest20: dest20OfShare({ dest: hasher }), dest: hasher, nonce: 1n, lz: 8 };
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner: hasher,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: [row],
      poolDest: pool,
    });
    const cb = childTpl.txs[0];
    const keep = (cb.vout || []).filter((o) => o.kind !== 'pot' && o.kind !== 'pool-fee');
    const whole = sealCoinbaseNote(BLOCK_SUBSIDY_NANOS, {
      dest20: hash20FromAddress(pool),
      kind: 'pot',
    });
    cb.vout = [whole, ...keep];
    cb.excess = excessOf(cb.vout);
    const decoded = decodeHeader(childTpl.header);
    childTpl.header = encodeHeader({
      ...decoded,
      merkleRoot: merkleRoot(childTpl.txs.map(digestTx)),
    });
    const child = {
      header: childTpl.header,
      txs: childTpl.txs,
      samples: childTpl.samples,
      shareBatch: childTpl.shareBatch || [],
      miner: hasher,
      aLeaves: childTpl.aLeaves,
      bLeaves: childTpl.bLeaves,
      weight: childTpl.weight,
    };
    const got = verifyBlock(child, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
      weight: parent.weight,
    }, { poolDest: pool, trustedPowHash: TRUSTED, skipSharePow: true });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'pot_prop');
  });

  it('accepts dest-bound hash to hasher dests with custodial pot on the pool dest', () => {
    const hasher = destOf(newIdentity());
    const pool = destOf(newIdentity());
    const TRUSTED = Buffer.alloc(32);
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: hasher,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
    });
    const parent = {
      header: parentTpl.header,
      txs: parentTpl.txs,
      samples: parentTpl.samples,
      shareBatch: parentTpl.shareBatch || [],
      miner: hasher,
      aLeaves: parentTpl.aLeaves,
      bLeaves: parentTpl.bLeaves,
      weight: parentTpl.weight,
    };
    const okP = verifyBlock(parent, null, { trustedPowHash: TRUSTED });
    assert.equal(okP.ok, true, okP.reason);
    const now = 1_700_000_090_000;
    const ph = decodeHeader(parent.header);
    const row = { dest20: dest20OfShare({ dest: hasher }), dest: hasher, nonce: 1n, lz: 8 };
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner: hasher,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: [row],
      poolDest: pool,
      potShares: custodyPotShares(pool),
    });
    const child = {
      header: childTpl.header,
      txs: childTpl.txs,
      samples: childTpl.samples,
      shareBatch: childTpl.shareBatch || [],
      miner: hasher,
      aLeaves: childTpl.aLeaves,
      bLeaves: childTpl.bLeaves,
      weight: childTpl.weight,
      poolDest: pool,
    };
    const got = verifyBlock(child, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
      weight: parent.weight,
    }, { poolDest: pool, trustedPowHash: TRUSTED, skipSharePow: true });
    assert.equal(got.ok, true, got.reason);
    const p2p = verifyBlock(child, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
      weight: parent.weight,
    }, { trustedPowHash: TRUSTED, skipSharePow: true });
    assert.equal(p2p.ok, true, p2p.reason);
    const kinds = (childTpl.txs[0].vout || []).map((o) => o.kind);
    assert.ok(kinds.includes('hash'));
    assert.ok(kinds.includes('pot'));
  });

  it('hashbonus noteCommit is the hasher dest; pot vouts stay on the pool dest', () => {
    const hasherId = newIdentity();
    const poolId = newIdentity();
    const hasher = destOf(hasherId);
    const pool = destOf(poolId);
    const hasher20 = hash20FromAddress(hasher);
    const pool20 = hash20FromAddress(pool);
    const row = { dest20: dest20OfShare({ dest: hasher }), dest: hasher, nonce: 1n, lz: 8 };
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: pool,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
      shareBatch: [row],
      poolDest: pool,
      potShares: custodyPotShares(pool),
    });
    const vout = tpl.txs[0].vout || [];
    const hashes = vout.filter((o) => o.kind === 'hash');
    const pots = vout.filter((o) => o.kind === 'pot' || o.kind === 'finder-fee' || o.kind === 'reserve-fee');
    assert.ok(hashes.length >= 1, 'per-miner hash vout');
    for (const h of hashes) {
      assert.ok(Buffer.from(h.noteCommit).equals(noteCommitOfDest20(hasher20)));
      assert.ok(h.dest20);
      assert.ok(Buffer.from(h.dest20).equals(Buffer.from(hasher20)));
      assert.ok(!Buffer.from(h.noteCommit).equals(noteCommitOfDest20(pool20)));
      assert.ok(h.rEph && h.rCt);
    }
    assert.ok(pots.length >= 1, 'custodial pot');
    for (const p of pots) {
      assert.ok(Buffer.from(p.noteCommit).equals(noteCommitOfDest20(pool20)));
    }
    const src = fs.readFileSync(new URL('../../pool/src/pool.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /hashBonusCustodyDest\s*:/);
  });

  it('epoch-1 potShares sum equals schedule pot and fails if Σ ≠ wantPot', () => {
    const pool = destOf(newIdentity());
    const hasher = destOf(newIdentity());
    const wantPot = potSubsidyNanos(1);
    assert.equal(wantPot, 99_000_000_000);
    assert.notEqual(wantPot, BLOCK_SUBSIDY_NANOS);
    const shares = custodyPotShares(pool, wantPot);
    const sum = shares.reduce((a, s) => a + s.nanos, 0);
    assert.equal(sum, wantPot);
    const src = fs.readFileSync(new URL('../../pool/src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /custodyPotShares\(poolPay, wantPot\)/);
    assert.match(src, /splitPot\(/);
    assert.match(src, /wantLivePot\(\)/);
    const genesisMs = 1_700_000_000_000;
    const parentNow = genesisMs + epochMs(MAGIC_TESTNET) + 90_000;
    const now = parentNow + 90_000;
    const TRUSTED = Buffer.alloc(32);
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: hasher,
      bits: GENESIS_BITS_PACKED,
      now: parentNow,
      potShares: custodyPotShares(pool, wantPot),
    });
    const parent = {
      header: parentTpl.header,
      txs: parentTpl.txs,
      samples: parentTpl.samples,
      shareBatch: parentTpl.shareBatch || [],
      miner: hasher,
      aLeaves: parentTpl.aLeaves,
      bLeaves: parentTpl.bLeaves,
      weight: parentTpl.weight,
    };
    const okP = verifyBlock(parent, null, { trustedPowHash: TRUSTED, genesisMs });
    assert.equal(okP.ok, true, okP.reason);
    const ph = decodeHeader(parent.header);
    const row = { dest20: dest20OfShare({ dest: hasher }), dest: hasher, nonce: 1n, lz: 8 };
    const wrongTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner: hasher,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: [row],
      poolDest: pool,
      potShares: custodyPotShares(pool, BLOCK_SUBSIDY_NANOS),
    });
    const wrong = {
      header: wrongTpl.header,
      txs: wrongTpl.txs,
      samples: wrongTpl.samples,
      shareBatch: wrongTpl.shareBatch || [],
      miner: hasher,
      aLeaves: wrongTpl.aLeaves,
      bLeaves: wrongTpl.bLeaves,
      weight: wrongTpl.weight,
      poolDest: pool,
    };
    const denied = verifyBlock(wrong, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
      weight: parent.weight,
    }, { poolDest: pool, trustedPowHash: TRUSTED, skipSharePow: true, genesisMs, nowMs: now, magic: MAGIC_TESTNET });
    assert.equal(denied.ok, false);
    assert.ok(denied.reason === 'pot' || denied.reason === 'pot_sched' || denied.reason === 'pot_prop', denied.reason);
    const okTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner: hasher,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: [row],
      poolDest: pool,
      potShares: custodyPotShares(pool, wantPot),
    });
    const child = {
      header: okTpl.header,
      txs: okTpl.txs,
      samples: okTpl.samples,
      shareBatch: okTpl.shareBatch || [],
      miner: hasher,
      aLeaves: okTpl.aLeaves,
      bLeaves: okTpl.bLeaves,
      weight: okTpl.weight,
      poolDest: pool,
    };
    const got = verifyBlock(child, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
      weight: parent.weight,
    }, { poolDest: pool, trustedPowHash: TRUSTED, skipSharePow: true, genesisMs, nowMs: now, magic: MAGIC_TESTNET });
    assert.equal(got.ok, true, got.reason);
  });
});
