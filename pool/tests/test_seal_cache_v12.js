import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { GENESIS_BITS_PACKED, SHARE_FLOOR_BITS, shareCreditMaxBits, MAX_SHARES_PER_BLOCK } from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  LIVE_SHARE_POW_BOUND,
  clearLiveSharePow,
  findShare,
  hasLiveSharePow,
  liveSharePowKey,
  liveSharePowMetrics,
  nonceWithShareTarget,
  noteCommitOfShare,
  pinLiveSharePow,
  rememberLiveSharePow,
  resetSharePowCounters,
  sharePowCounters,
} from '../../crypto/share_batch.js';
import { createPool } from '../src/pool.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function parentHeader() {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: 1_700_000_000_000,
    bits: GENESIS_BITS_PACKED,
  });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function poolAt(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-seal-${tag}-`));
  return createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
}

function shareRec(dest, nonce, bits, verifiedHeader) {
  return {
    dest,
    nonce,
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    verifiedHeader,
    hash: '11',
  };
}

describe('v12 pool seal survives share-cache eviction', () => {
  it('keeps the fail-closed skip and the OK literal on the success branch', () => {
    const shareSrc = fs.readFileSync(new URL('../../crypto/share_batch.js', import.meta.url), 'utf8');
    const remember = shareSrc.split('export function rememberLiveSharePow')[1].split('export async function reproveSharesOffLoop')[0];
    assert.doesNotMatch(remember, /\.clear\(/);
    const reprove = shareSrc.split('export async function reproveSharesOffLoop')[1].split('function liveProofForShare')[0];
    assert.match(reprove, /hashHeaderOffLoop/);
    assert.doesNotMatch(reprove, /shearHash\(/);
    const storeSrc = fs.readFileSync(new URL('../../node/src/store.js', import.meta.url), 'utf8');
    const rebuild = storeSrc.split('function rebuildSpentB()')[1].split('function bounceMempool')[0];
    assert.match(rebuild, /skipSharePow:\s*false/);
    assert.doesNotMatch(rebuild, /skipSharePow:\s*true/);
    assert.doesNotMatch(rebuild, /return step\(\)/);
    assert.doesNotMatch(rebuild, /spentB\.clear\(\)/);
    assert.match(rebuild, /trustedPowHash/);
    assert.match(rebuild, /\.then\(/);
    assert.match(storeSrc, /skipSharePow: !!okHash/);
    const poolSrc = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(poolSrc, /result: \{ status: 'OK', hash: scored\.hash, block: sealedBlock \}/);
    assert.match(poolSrc, /error: 'seal_failed'/);
    const noteFail = poolSrc.split('function noteSealFailure')[1].split('function noteSealSuccess')[0];
    assert.match(noteFail, /seal_batch_carry/);
    assert.match(noteFail, /SEAL_ESCAPE_V1/);
    assert.doesNotMatch(noteFail, /bans\.add/);
    assert.doesNotMatch(noteFail, /kickMiner/);
    assert.doesNotMatch(noteFail, /lag1Shares = \[\]/);
    assert.doesNotMatch(noteFail, /seal_batch_held/);
    const warm = poolSrc.split('function ensureCachedShareProofs')[1].split('function whenShareProofs')[0];
    assert.match(warm, /noteSealFailure\('worker'/);
    assert.match(reprove, /reason: 'worker'/);
  });

  it('evicts unpinned proofs, refuses a bad seal, and reseals a wiped lag-1 batch', { timeout: 420_000 }, async () => {
    clearLiveSharePow();
    pinLiveSharePow([]);
    const header = parentHeader();
    const dests = [minerDest(), minerDest(), minerDest()];
    const maxB = shareCreditMaxBits();
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 4, maxB];
    assert.equal(LIVE_SHARE_POW_BOUND, MAX_SHARES_PER_BLOCK * 8);
    const bound = LIVE_SHARE_POW_BOUND;
    for (let i = 0; i < 3; i += 1) {
      const bits = widths[i];
      const nonce = nonceWithShareTarget(BigInt(i + 1), bits);
      const nc = noteCommitOfShare({ dest: dests[i] });
      assert.equal(rememberLiveSharePow(header, nonce, { noteCommit: nc, shareBits: bits, lz: bits }), true);
    }
    assert.equal(liveSharePowMetrics().size, 3);
    assert.equal(liveSharePowMetrics().evictions, 0);
    clearLiveSharePow();

    const nonces = [];
    const baseEvict = liveSharePowMetrics().evictions;
    const bulkNc = noteCommitOfShare({ dest: dests[0] });
    for (let i = 0; i < bound; i += 1) {
      const bits = i < widths.length ? widths[i] : SHARE_FLOOR_BITS;
      const dest = dests[i % dests.length];
      const nc = i < dests.length ? noteCommitOfShare({ dest }) : bulkNc;
      const nonce = nonceWithShareTarget(BigInt(i + 1), bits);
      assert.equal(rememberLiveSharePow(header, nonce, { noteCommit: nc, shareBits: bits, lz: bits }), true);
      nonces.push(nonce);
    }
    let m = liveSharePowMetrics();
    assert.equal(m.size, bound);
    assert.equal(m.evictions, baseEvict);
    assert.equal(m.overBound, 0);
    pinLiveSharePow([liveSharePowKey(header, nonces[0])]);
    const extra = nonceWithShareTarget(BigInt(bound + 1), maxB);
    assert.equal(rememberLiveSharePow(header, extra, {
      noteCommit: noteCommitOfShare({ dest: dests[1] }),
      shareBits: maxB,
      lz: maxB,
    }), true);
    assert.equal(hasLiveSharePow(header, nonces[0]), true);
    assert.equal(hasLiveSharePow(header, nonces[1]), false);
    assert.equal(hasLiveSharePow(header, extra), true);
    m = liveSharePowMetrics();
    assert.equal(m.size, bound);
    assert.equal(m.evictions, baseEvict + 1);

    const keep = [];
    for (const nonce of nonces) {
      if (hasLiveSharePow(header, nonce)) keep.push(liveSharePowKey(header, nonce));
    }
    keep.push(liveSharePowKey(header, extra));
    pinLiveSharePow(keep);
    for (let i = 0; i < 8; i += 1) {
      const bits = widths[i % widths.length];
      const nonce = nonceWithShareTarget(BigInt(bound + 10 + i), bits);
      assert.equal(rememberLiveSharePow(header, nonce, { noteCommit: bulkNc, shareBits: bits, lz: bits }), true);
      keep.push(liveSharePowKey(header, nonce));
      pinLiveSharePow(keep);
    }
    m = liveSharePowMetrics();
    assert.ok(m.size > m.bound);
    assert.ok(m.overBound > 0);
    assert.equal(hasLiveSharePow(header, nonces[0]), true);
    assert.equal(hasLiveSharePow(header, extra), true);

    const view = poolAt('metrics');
    try {
      const job = view.issueJob(undefined, { force: true });
      assert.ok(job?.jobId);
      assert.equal(view.stats.shareCacheEvictions, liveSharePowMetrics().evictions);
      assert.equal(view.stats.shareCacheWipes, liveSharePowMetrics().wipes);
    } finally {
      view.close();
    }
    clearLiveSharePow();
    pinLiveSharePow([]);

    const logs = [];
    const orig = console.error;
    console.error = (...args) => {
      logs.push(args.map((a) => String(a)).join(' '));
      orig(...args);
    };
    const bad = poolAt('bad');
    const held = poolAt('held');
    const live = poolAt('live');
    try {
      const opened = bad.issueJob(undefined, { force: true });
      const badDest = minerDest();
      const badNonce = nonceWithShareTarget(50n, SHARE_FLOOR_BITS);
      const badHeader = Buffer.from(opened.header, 'hex');
      assert.equal(bad.creditAcceptedShare(shareRec(badDest, badNonce, SHARE_FLOOR_BITS, badHeader)).ok, true);
      const sealed = await bad.sealFoundShare({
        jobId: opened.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: easyPow(9).toString('hex'),
      });
      assert.equal(sealed.ok, true, sealed.reason);
      bad.rollOpenRound();
      clearLiveSharePow();
      const cold = bad.issueJob(undefined, { force: true });
      assert.equal(cold, null);
      const warmed = await bad.whenShareProofs();
      const batch = warmed ? bad.store.jobs.get(String(warmed.jobId))?.tpl?.shareBatch || [] : [];
      assert.equal(batch.some((s) => String(s.nonce) === String(badNonce)), false);
      assert.equal(bad.lag1Shares.some((s) => String(s.nonce) === String(badNonce)), false);
      assert.ok(bad.stats.sealFailed >= 1);
      assert.ok(logs.some((line) => line.includes('seal_failed') && line.includes('"alert":true')));

      const first = held.issueJob(undefined, { force: true });
      const heldDest = minerDest();
      const heldNonce = nonceWithShareTarget(70n, SHARE_FLOOR_BITS + 4);
      const heldHeader = Buffer.from(first.header, 'hex');
      assert.equal(held.creditAcceptedShare(shareRec(heldDest, heldNonce, SHARE_FLOOR_BITS + 4, heldHeader)).ok, true);
      const ok1 = await held.sealFoundShare({
        jobId: first.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: easyPow(11).toString('hex'),
      });
      assert.equal(ok1.ok, true, ok1.reason);
      held.rollOpenRound();
      const published = held.issueJob(undefined, { force: true });
      assert.ok(published?.jobId);
      assert.ok((held.store.jobs.get(String(published.jobId)).tpl.shareBatch || []).length > 0);
      const badPow = Buffer.alloc(32, 0xff).toString('hex');
      const fail1 = await held.sealFoundShare({
        jobId: published.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: badPow,
      });
      assert.equal(fail1.ok, false);
      assert.equal(fail1.reason, 'pow');
      assert.ok(held.lag1Shares.some((s) => String(s.nonce) === String(heldNonce)));
      const againId = held.lastJob.jobId;
      const fail2 = await held.sealFoundShare({
        jobId: againId,
        nonce: 0n,
        miner: FEE,
        powHash: badPow,
      });
      assert.equal(fail2.ok, false);
      assert.ok(held.lag1Shares.some((s) => String(s.nonce) === String(heldNonce)));
      assert.equal(Number(held.stats.lostWorkHashes) || 0, 0);
      assert.ok(logs.some((line) => line.includes('seal_batch_carry')));
      assert.equal(logs.some((line) => line.includes('seal_batch_held')), false);
      const stale = await held.sealFoundShare({
        jobId: againId,
        nonce: 0n,
        miner: FEE,
        powHash: badPow,
      });
      assert.equal(stale.reason, 'stale_job');
      assert.ok(held.lag1Shares.some((s) => String(s.nonce) === String(heldNonce)));
      const carried = held.lastJob;
      assert.ok(carried?.jobId);
      assert.notEqual(String(carried.jobId), String(againId));
      const carriedBatch = held.store.jobs.get(String(carried.jobId))?.tpl?.shareBatch || [];
      assert.ok(carriedBatch.some((s) => String(s.nonce) === String(heldNonce)));
      const paid = await held.sealFoundShare({
        jobId: carried.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: easyPow(31).toString('hex'),
      });
      assert.equal(paid.ok, true, paid.reason);
      const sealedHeld = held.store.tip();
      assert.ok((sealedHeld.shareBatch || []).some((s) => String(s.nonce) === String(heldNonce)));
      assert.equal(Number(held.stats.lostWorkHashes) || 0, 0);

      const genesis = live.issueJob(undefined, { force: true });
      const hasher = minerDest();
      const found = findShare(Buffer.from(genesis.header, 'hex'), {
        dest: hasher,
        floorBits: SHARE_FLOOR_BITS,
        maxTries: 1600,
      });
      assert.ok(found, 'floor share search');
      const verified = Buffer.from(genesis.header, 'hex');
      assert.equal(live.creditAcceptedShare({
        dest: hasher,
        nonce: found.nonce,
        lz: found.lz,
        shareBits: found.shareBits,
        creditedShareBits: found.shareBits,
        verifiedHeader: verified,
        hash: '22',
        noteCommit: found.noteCommit,
      }).ok, true);
      const block1 = await live.sealFoundShare({
        jobId: genesis.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: easyPow(21).toString('hex'),
      });
      assert.equal(block1.ok, true, block1.reason);
      live.rollOpenRound();
      clearLiveSharePow();
      const withheld = live.issueJob(undefined, { force: true });
      assert.equal(withheld, null);
      const job2 = await live.whenShareProofs();
      assert.ok(job2?.jobId);
      const tpl = live.store.jobs.get(String(job2.jobId)).tpl;
      assert.equal(tpl.shareBatch.length, 1);
      assert.equal(String(tpl.shareBatch[0].nonce), String(found.nonce));
      const beforeLeaves = JSON.stringify(tpl.aLeaves.map((l) => [Buffer.from(l.noteCommit).toString('hex'), l.count]));
      clearLiveSharePow();
      resetSharePowCounters();
      let yielded = false;
      const pending = live.sealFoundShare({
        jobId: job2.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: easyPow(22).toString('hex'),
      });
      setImmediate(() => { yielded = true; });
      const block2 = await pending;
      assert.equal(yielded, true);
      assert.equal(block2.ok, true, block2.reason);
      assert.equal(sharePowCounters().sync, 0);
      const tip = live.store.tip();
      const afterLeaves = JSON.stringify((tip.aLeaves || []).map((l) => [Buffer.from(l.noteCommit).toString('hex'), l.count]));
      assert.equal(afterLeaves, beforeLeaves);
      assert.equal(String(tip.shareBatch[0].nonce), String(found.nonce));
      console.log(JSON.stringify({
        event: 'seal_cache_measured',
        sync: sharePowCounters().sync,
        prepared: sharePowCounters().prepared,
        yielded,
        sealFailed: live.stats.sealFailed,
        evictions: liveSharePowMetrics().evictions,
        bound,
      }));
    } finally {
      console.error = orig;
      bad.close();
      held.close();
      live.close();
    }
  });
});
