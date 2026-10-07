import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeHeader } from '../../crypto/header.js';
import {
  GENESIS_BITS_PACKED,
  SHARE_FLOOR_BITS,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import { shareSlotRoot } from '../../crypto/pack.js';
import { createPool } from '../src/pool.js';

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function headerAt(stamp) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: stamp,
    bits: GENESIS_BITS_PACKED,
  });
}

let powTag = 4000;
function nextPow() {
  powTag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag >>> 0, 4);
  return h.toString('hex');
}

function poolAt(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-slot-${tag}-`));
  return createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
}

function credit(pool, dest, header, bits, low) {
  const nonce = nonceWithShareTarget(BigInt(low), bits);
  const got = pool.creditAcceptedShare({
    dest,
    nonce,
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    verifiedHeader: header,
    hash: '11',
  });
  assert.equal(got.ok, true, got.reason || 'credit');
  return String(nonce);
}

function batchOf(pool, job) {
  return pool.store.jobs.get(String(job.jobId))?.tpl?.shareBatch || [];
}

function nonceSet(shares) {
  return new Set((shares || []).map((s) => String(s.nonce)));
}

async function seal(pool) {
  const got = await pool.sealFoundShare({
    jobId: pool.lastJob.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(got.ok, true, got.reason || 'seal');
}

describe('v12 template stamps a real proof slot', () => {
  it('keeps parent and prior shares, drops a stranger, and does not throw', { timeout: 180_000 }, async () => {
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 4, shareCreditMaxBits()];
    const pool = poolAt('live');
    const dests = [minerDest(), minerDest(), minerDest()];
    const stranger = headerAt(1_700_000_111_000);
    const parked = [];
    let low = 10;
    for (const dest of dests) {
      for (const bits of widths) {
        parked.push(credit(pool, dest, headerAt(1_700_000_000_000 + low), bits, low));
        low += 1;
      }
    }
    pool.rollOpenRound();
    const emptyBook = pool.issueJob(undefined, { force: true });
    assert.ok(emptyBook?.jobId);
    assert.equal(batchOf(pool, emptyBook).length, 0);
    const held = nonceSet([...pool.lag1Shares, ...pool.openShares, ...pool.deferredShares]);
    for (const n of parked) assert.equal(held.has(n), true, `no-parent drop ${n}`);
    for (const s of pool.deferredShares) {
      assert.notEqual(s.proofSlot, 0);
      assert.notEqual(s.proofSlot, 1);
    }

    const genesis = pool.issueJob(undefined, { force: true });
    assert.ok(genesis?.jobId);
    const parentHdr = Buffer.from(genesis.header, 'hex');
    const parentNonces = [];
    const strangerNonces = [];
    low = 100;
    for (const dest of dests) {
      for (const bits of widths) {
        parentNonces.push(credit(pool, dest, parentHdr, bits, low));
        low += 1;
        strangerNonces.push(credit(pool, dest, stranger, bits, low));
        low += 1;
      }
    }
    await seal(pool);
    pool.rollOpenRound();
    const published = pool.issueJob(undefined, { force: true });
    assert.ok(published?.jobId);
    const batch = batchOf(pool, published);
    const got = nonceSet(batch);
    assert.ok(batch.length > 0);
    assert.equal(batch.length, parentNonces.length);
    for (const n of parentNonces) {
      assert.equal(got.has(n), true, `parent missing ${n}`);
    }
    for (const n of strangerNonces) assert.equal(got.has(n), false, `stranger packed ${n}`);
    for (const row of batch) assert.equal(row.proofSlot, 0);
    assert.ok(Buffer.from(published && pool.store.jobs.get(String(published.jobId)).tpl.txs[0].shareSlotRoot).equals(shareSlotRoot(batch)));

    const block1 = pool.store.tip().header;
    const priorNonces = [];
    const freshNonces = [];
    const jobHdr = Buffer.from(published.header, 'hex');
    low = 300;
    for (const dest of dests.slice(0, 2)) {
      for (const bits of [SHARE_FLOOR_BITS, shareCreditMaxBits()]) {
        priorNonces.push(credit(pool, dest, block1, bits, low));
        low += 1;
        freshNonces.push(credit(pool, dest, jobHdr, bits, low));
        low += 1;
      }
    }
    await seal(pool);
    pool.rollOpenRound();
    const next = pool.issueJob(undefined, { force: true });
    assert.ok(next?.jobId);
    const mixed = batchOf(pool, next);
    const mixedNonces = nonceSet(mixed);
    for (const n of priorNonces) assert.equal(mixedNonces.has(n), true, `prior missing ${n}`);
    for (const n of freshNonces) assert.equal(mixedNonces.has(n), true, `fresh missing ${n}`);
    for (const row of mixed) {
      const n = String(row.nonce);
      if (priorNonces.includes(n)) assert.equal(row.proofSlot, 1);
      if (freshNonces.includes(n)) assert.equal(row.proofSlot, 0);
    }
    const rootTx = pool.store.jobs.get(String(next.jobId)).tpl.txs[0];
    assert.ok(Buffer.from(rootTx.shareSlotRoot).equals(shareSlotRoot(mixed)));

    const tip = pool.store.tip();
    const prior = pool.store.blocks[pool.store.blocks.length - 2];
    const claimed = {
      dest: dests[0],
      nonce: nonceWithShareTarget(900n, SHARE_FLOOR_BITS),
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      proofSlot: 0,
    };
    const loose = {
      dest: dests[1],
      nonce: nonceWithShareTarget(901n, SHARE_FLOOR_BITS + 1),
      lz: SHARE_FLOOR_BITS + 1,
      shareBits: SHARE_FLOOR_BITS + 1,
    };
    const onTip = {
      dest: dests[2],
      nonce: nonceWithShareTarget(902n, SHARE_FLOOR_BITS),
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      verifiedHeader: tip.header,
    };
    const onPrior = {
      dest: dests[0],
      nonce: nonceWithShareTarget(903n, shareCreditMaxBits()),
      lz: shareCreditMaxBits(),
      shareBits: shareCreditMaxBits(),
      verifiedHeader: prior.header,
    };
    const off = {
      dest: dests[1],
      nonce: nonceWithShareTarget(904n, SHARE_FLOOR_BITS + 4),
      lz: SHARE_FLOOR_BITS + 4,
      shareBits: SHARE_FLOOR_BITS + 4,
      verifiedHeader: stranger,
    };
    const built = pool.store.template({
      miner: FEE,
      shareBatch: [loose, onTip, off, claimed, onPrior],
      potShares: [],
    });
    const stamped = built.tpl.shareBatch || [];
    const stampedNonces = nonceSet(stamped);
    assert.equal(stampedNonces.has(String(loose.nonce)), false);
    assert.equal(stampedNonces.has(String(off.nonce)), false);
    assert.equal(stampedNonces.has(String(claimed.nonce)), true);
    assert.equal(stampedNonces.has(String(onTip.nonce)), true);
    assert.equal(stampedNonces.has(String(onPrior.nonce)), true);
    const byNonce = new Map(stamped.map((s) => [String(s.nonce), s.proofSlot]));
    assert.equal(byNonce.get(String(claimed.nonce)), 0);
    assert.equal(byNonce.get(String(onTip.nonce)), 0);
    assert.equal(byNonce.get(String(onPrior.nonce)), 1);
    assert.ok(Buffer.from(built.tpl.txs[0].shareSlotRoot).equals(shareSlotRoot(stamped)));
    pool.close();
  });
});
