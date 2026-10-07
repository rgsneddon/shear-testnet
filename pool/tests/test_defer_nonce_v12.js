import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setHashBackend } from '../../crypto/shear_hash.js';
import {
  MAX_SHARES_PER_BLOCK,
  SHARE_FLOOR_BITS,
} from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  packShareWork,
  unpackShareWork,
  packShareBatchBytes,
  unpackShareBatchBytes,
  SHARE_WORK_BODY_LEN,
  ENC_MAGIC,
} from '../../crypto/pack.js';
import {
  nonceWithShareTarget,
  unitsForShare,
  noteCommitOfShare,
  rememberLiveSharePow,
  verifyShareBatch,
  shareWorkKey,
  paidWorkKeys,
  splitDeferWindow,
} from '../../crypto/share_batch.js';
import { createPool, SEAL_ESCAPE_AFTER } from '../src/pool.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const WIDTHS = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 4];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rows, rng) {
  const out = rows.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function headerFill(byte) {
  return Buffer.alloc(128, byte);
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function destsOf(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(minerDest());
  return out;
}

let powTag = 7000;
function nextPow() {
  powTag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  return h.toString('hex');
}

function poolAt(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-defer-${tag}-`));
  const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
  return { pool, dir };
}

function shareOf(dest, header, low, bits) {
  const nonce = nonceWithShareTarget(BigInt(low), bits);
  const share = {
    dest,
    nonce,
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    verifiedHeader: header,
    hash: '11',
  };
  share.noteCommit = Buffer.from(noteCommitOfShare(share));
  return share;
}

function pinShare(share) {
  const ok = rememberLiveSharePow(share.verifiedHeader, share.nonce, {
    noteCommit: share.noteCommit,
    shareBits: share.shareBits,
    lz: share.lz,
  });
  assert.equal(ok, true);
  return share;
}

function workKey(share) {
  return shareWorkKey(share.verifiedHeader, share.nonce);
}

function placedKeys(pool, dir) {
  const keys = new Set();
  for (const s of [...pool.lag1Shares, ...pool.openShares, ...pool.deferredShares]) {
    const k = workKey(s);
    if (k) keys.add(k);
  }
  const file = path.join(dir, 'window-owed.json');
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const row of parsed.rows || []) {
      for (const w of row.works || []) keys.add(String(w));
    }
  }
  return keys;
}

function owedUnits(pool) {
  let n = 0n;
  for (const row of pool.windowOwedRows()) n += BigInt(row.units);
  return n;
}

function assertHonest(planted, pool, dir) {
  const have = placedKeys(pool, dir);
  for (const s of planted) assert.equal(have.has(workKey(s)), true, 'unit left the window');
  assert.equal(Number(pool.stats.lostWorkHashes) || 0, 0);
  assert.equal(Number(pool.stats.lostWorkEvents) || 0, 0);
}

async function sealJob(pool, job) {
  const got = await pool.sealFoundShare({
    jobId: job.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(got.ok, true, got.reason || 'seal');
  return got;
}

describe('v12 defer-window identity', () => {
  it('treats header plus nonce as the unit, and a same-header pair as dup_share', () => {
    const parent = headerFill(1);
    const prior = headerFill(2);
    const dest = destsOf(1)[0];
    const bits = SHARE_FLOOR_BITS;
    const parentRow = pinShare(shareOf(dest, parent, 11, bits));
    const priorRow = pinShare(shareOf(dest, prior, 11, bits));
    const both = verifyShareBatch({
      parentHeader: parent,
      priorHeader: prior,
      shares: [parentRow, priorRow],
      skipPow: true,
    });
    assert.equal(both.ok, true, both.reason);
    assert.equal(both.shares.length, 2);
    const slots = both.shares.map((s) => s.proofSlot).sort();
    assert.deepEqual(slots, [0, 1]);
    assert.equal(parentRow.proofSlot === 0 || parentRow.proofSlot === 1, true);
    assert.notEqual(parentRow.proofSlot, priorRow.proofSlot);

    const marked = verifyShareBatch({
      parentHeader: parent,
      priorHeader: prior,
      shares: [
        { ...parentRow, proofSlot: 0 },
        { ...priorRow, proofSlot: 1 },
      ],
      skipPow: true,
    });
    assert.equal(marked.ok, true, marked.reason);
    assert.equal(marked.shares.length, 2);

    const onlyPrior = pinShare(shareOf(dest, prior, 77, bits));
    const onlyParent = pinShare(shareOf(dest, parent, 78, bits));
    const lie = verifyShareBatch({
      parentHeader: parent,
      priorHeader: prior,
      shares: [{ ...onlyPrior, proofSlot: 0 }],
      skipPow: true,
    });
    assert.equal(lie.ok, false);
    assert.equal(lie.reason, 'share_pow');
    const lieBack = verifyShareBatch({
      parentHeader: parent,
      priorHeader: prior,
      shares: [{ ...onlyParent, proofSlot: 1 }],
      skipPow: true,
    });
    assert.equal(lieBack.ok, false);
    assert.equal(lieBack.reason, 'share_pow');

    const dup = verifyShareBatch({
      parentHeader: parent,
      priorHeader: prior,
      shares: [
        { ...parentRow, proofSlot: 0 },
        { ...parentRow, proofSlot: 0 },
      ],
      skipPow: true,
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, 'dup_share');

    const cold = verifyShareBatch({
      parentHeader: headerFill(3),
      priorHeader: headerFill(4),
      shares: [
        shareOf(dest, headerFill(3), 4, bits),
        shareOf(dest, headerFill(3), 4, bits),
      ],
      skipPow: true,
    });
    assert.equal(cold.ok, false);
    assert.equal(cold.reason, 'share_pow');

    const paid = new Set([shareWorkKey(parent, parentRow.nonce)]);
    const otherHeader = verifyShareBatch({
      parentHeader: parent,
      priorHeader: prior,
      excludeNonces: paid,
      shares: [{ ...priorRow }],
      skipPow: true,
    });
    assert.equal(otherHeader.ok, true, otherHeader.reason);
    assert.equal(otherHeader.shares[0].proofSlot, 1);
    const sameHeader = verifyShareBatch({
      parentHeader: parent,
      priorHeader: prior,
      excludeNonces: paid,
      shares: [{ ...parentRow, proofSlot: 0 }],
      skipPow: true,
    });
    assert.equal(sameHeader.ok, false);
    assert.equal(sameHeader.reason, 'share_pow');
    const bare = verifyShareBatch({
      parentHeader: parent,
      priorHeader: prior,
      excludeNonces: new Set([BigInt(parentRow.nonce).toString()]),
      shares: [{ ...priorRow }],
      skipPow: true,
    });
    assert.equal(bare.ok, false);
    assert.equal(bare.reason, 'share_pow');
    const keys = paidWorkKeys([
      { ...parentRow, proofSlot: 0 },
      { ...priorRow, proofSlot: 1 },
    ], parent);
    assert.equal(keys.has(shareWorkKey(parent, parentRow.nonce)), true);
    assert.equal(keys.has(shareWorkKey(prior, priorRow.nonce)), false);
  });

  it('keeps a 42-byte share body and accepts only slot 0 or 1', () => {
    const dest = destsOf(1)[0];
    const row = shareOf(dest, headerFill(5), 9, SHARE_FLOOR_BITS);
    const plain = packShareWork({
      noteCommit: row.noteCommit,
      nonce: row.nonce,
      lz: row.lz,
      shareBits: row.shareBits,
    });
    assert.equal(plain.length, ENC_MAGIC.length + 1 + SHARE_WORK_BODY_LEN);
    const opened = unpackShareWork(plain);
    assert.equal(opened.proofSlot, undefined);
    assert.equal(opened.nonce, BigInt(row.nonce));
    for (const slot of [0, 1]) {
      const packed = packShareWork({
        noteCommit: row.noteCommit,
        nonce: row.nonce,
        lz: row.lz,
        shareBits: row.shareBits,
        proofSlot: slot,
      });
      assert.equal(packed.length, plain.length + 1);
      assert.equal(unpackShareWork(packed).proofSlot, slot);
      const round = unpackShareBatchBytes(packShareBatchBytes([{ ...row, proofSlot: slot }]));
      assert.equal(round.length, 1);
      assert.equal(round[0].proofSlot, slot);
      assert.equal(BigInt(round[0].nonce), BigInt(row.nonce));
    }
    const absent = unpackShareBatchBytes(packShareBatchBytes([row]));
    assert.equal(absent[0].proofSlot, undefined);
    const bad = Buffer.concat([plain, Buffer.from([2])]);
    assert.throws(() => unpackShareWork(bad), /bad_share_work/);
    const extra = Buffer.concat([plain, Buffer.from([0, 0])]);
    assert.throws(() => unpackShareWork(extra), /bad_share_work/);
  });

  it('accounts every proven unit across caps, dest counts, widths, and shuffles', () => {
    const parent = headerFill(8);
    const prior = headerFill(9);
    const cap = MAX_SHARES_PER_BLOCK;
    const destSets = [destsOf(1), destsOf(3), destsOf(17)];
    const cases = [];
    for (const n of [1, 7, 40]) {
      for (const ratio of [0, 0.5, 1]) cases.push({ n, ratio, heavy: false });
    }
    for (const factor of [1, 2, 4]) {
      for (const ratio of [0, 0.5, 1]) {
        const n = factor === 1 ? cap + 1 : factor * cap;
        cases.push({ n, ratio, heavy: true });
      }
    }
    let heavyDest = 0;
    for (const spec of cases) {
      const dests = spec.heavy
        ? destSets[heavyDest++ % destSets.length]
        : destSets[spec.n % destSets.length];
      const rng = mulberry32((spec.n * 131) ^ Math.floor(spec.ratio * 1000) ^ 0x55);
      const expiringN = Math.floor(spec.n * spec.ratio);
      const freshN = spec.n - expiringN;
      const rows = [];
      for (let i = 0; i < spec.n; i += 1) {
        const bits = WIDTHS[i % WIDTHS.length];
        const onPrior = i < expiringN;
        const low = (BigInt(Math.floor(rng() * 0xffffff)) << 12n) + BigInt(i + 1);
        rows.push(shareOf(dests[i % dests.length], onPrior ? prior : parent, low, bits));
      }
      const ordered = shuffle(rows, rng);
      const split = splitDeferWindow(ordered, parent, prior, cap);
      const seen = new Map();
      for (const [name, list] of [
        ['seal', split.seal],
        ['carry', split.carry],
        ['owe', split.owe],
        ['stale', split.stale],
      ]) {
        for (const s of list) {
          const k = workKey(s);
          assert.equal(seen.has(k), false, `${name} repeated ${k}`);
          seen.set(k, name);
        }
      }
      for (const s of ordered) assert.equal(seen.has(workKey(s)), true);
      assert.equal(seen.size, new Set(ordered.map(workKey)).size);
      assert.ok(split.seal.length <= cap);
      const expiringKeys = new Set(ordered.filter((s) => workKey(s).startsWith(`${shareWorkKey(prior, 0n).slice(0, 256)}`)).map(workKey));
      void expiringKeys;
      let expiringLeft = expiringN;
      let freshLeft = freshN;
      const sealExp = Math.min(expiringN, cap);
      expiringLeft -= sealExp;
      const room = cap - sealExp;
      const sealFresh = Math.min(freshN, room);
      freshLeft -= sealFresh;
      assert.equal(split.seal.length, sealExp + sealFresh);
      assert.equal(split.owe.length, expiringLeft);
      assert.equal(split.carry.length, freshLeft);
      assert.equal(split.stale.length, 0);
      let expiringSeen = 0;
      let freshSeen = 0;
      const priorKey = shareWorkKey(prior, 0n).split(':')[0];
      for (const s of ordered) {
        if (workKey(s).startsWith(priorKey)) expiringSeen += 1;
        else freshSeen += 1;
      }
      assert.equal(expiringSeen, expiringN);
      assert.equal(freshSeen, freshN);
    }
  });

  it('pays a cross-header nonce, owes only expiring spill, and keeps fresh spill', { timeout: 600_000 }, async () => {
    const pools = [];
    try {
      const under = poolAt('under');
      pools.push(under);
      const genesis = under.pool.issueJob(undefined, { force: true });
      await sealJob(under.pool, genesis);
      const second = under.pool.issueJob(undefined, { force: true });
      await sealJob(under.pool, second);
      assert.equal(under.pool.store.blocks.length, 2);
      const tip = Buffer.from(under.pool.store.tip().header);
      const prior = Buffer.from(under.pool.store.blocks[0].header);
      const dests = destsOf(17);
      const rng = mulberry32(0x0550a11);
      const planted = [];
      const widths = [1, 7, 40];
      let low = 1;
      for (const n of widths) {
        for (let i = 0; i < n; i += 1) {
          const bits = WIDTHS[(low + i) % WIDTHS.length];
          const origin = (BigInt(Math.floor(rng() * 0xffffff)) << 8n) + BigInt(low);
          const dest = dests[(low + i) % dests.length];
          planted.push(pinShare(shareOf(dest, tip, origin, bits)));
          planted.push(pinShare(shareOf(dest, prior, origin, bits)));
          low += 1;
        }
      }
      for (const s of shuffle(planted, rng)) under.pool.lag1Shares.push(s);
      const job = under.pool.issueJob(undefined, { force: true });
      assert.ok(job?.jobId);
      const batch = under.pool.store.jobs.get(String(job.jobId)).tpl.shareBatch;
      const batchKeys = new Set(batch.map(workKey));
      for (const s of planted) assert.equal(batchKeys.has(workKey(s)), true);
      assert.equal(Number(under.pool.stats.lostWorkHashes) || 0, 0);
      assert.equal(under.pool.windowOwedRows().length, 0);
      const paidShare = planted.find((s) => Buffer.from(s.verifiedHeader).equals(tip));
      await sealJob(under.pool, job);
      const sealedParent = tip;
      const paidNow = paidWorkKeys(under.pool.store.tip().shareBatch, sealedParent);
      assert.equal(paidNow.has(workKey(paidShare)), true);
      under.pool.rollOpenRound();
      assert.equal(under.pool.windowOwedRows().length, 0);
      const againPrior = pinShare(shareOf(paidShare.dest, sealedParent, paidShare.nonce, paidShare.shareBits));
      const againTip = pinShare(shareOf(paidShare.dest, Buffer.from(under.pool.store.tip().header), paidShare.nonce, paidShare.shareBits));
      const freshNonce = pinShare(shareOf(dests[0], sealedParent, 900_001, SHARE_FLOOR_BITS));
      under.pool.lag1Shares.push(againPrior, againTip, freshNonce);
      const next = under.pool.issueJob(undefined, { force: true });
      assert.ok(next?.jobId);
      const nextKeys = new Set(under.pool.lag1Shares.map(workKey));
      assert.equal(nextKeys.has(workKey(againPrior)), false);
      assert.equal(nextKeys.has(workKey(againTip)), true);
      assert.equal(nextKeys.has(workKey(freshNonce)), true);
      assert.equal(Number(under.pool.stats.lostWorkHashes) || 0, 0);
      assert.equal(under.pool.windowOwedRows().length, 0);

      const dup = poolAt('dup');
      pools.push(dup);
      const dupGenesis = dup.pool.issueJob(undefined, { force: true });
      await sealJob(dup.pool, dupGenesis);
      const dupSecond = dup.pool.issueJob(undefined, { force: true });
      await sealJob(dup.pool, dupSecond);
      const dupTip = Buffer.from(dup.pool.store.tip().header);
      const dupPrior = Buffer.from(dup.pool.store.blocks[0].header);
      const dupDest = destsOf(1)[0];
      const honestA = pinShare(shareOf(dupDest, dupTip, 42, SHARE_FLOOR_BITS));
      const honestB = pinShare(shareOf(dupDest, dupPrior, 42, SHARE_FLOOR_BITS + 1));
      const copy = { ...honestA, noteCommit: Buffer.from(honestA.noteCommit) };
      dup.pool.lag1Shares.push(honestA, honestB, copy);
      const dupJob = dup.pool.issueJob(undefined, { force: true });
      assert.ok(dupJob?.jobId);
      for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
        const failed = await dup.pool.sealFoundShare({
          jobId: dup.pool.lastJob.jobId,
          nonce: 0n,
          miner: FEE,
          powHash: nextPow(),
        });
        assert.equal(failed.ok, false);
      }
      const left = new Set(dup.pool.lag1Shares.map(workKey));
      assert.equal(left.has(workKey(honestA)), true);
      assert.equal(left.has(workKey(honestB)), true);
      assert.equal(dup.pool.lag1Shares.filter((s) => workKey(s) === workKey(honestA)).length, 1);
      assert.equal(Number(dup.pool.stats.lostWorkHashes) || 0, unitsForShare(honestA.shareBits));

      const over = poolAt('over');
      pools.push(over);
      const overGenesis = over.pool.issueJob(undefined, { force: true });
      await sealJob(over.pool, overGenesis);
      const heldHeader = Buffer.from(over.pool.store.tip().header);
      const live = over.pool.issueJob(undefined, { force: true });
      const liveHeader = Buffer.from(live.header, 'hex');
      const overDests = destsOf(3);
      const cap = MAX_SHARES_PER_BLOCK;
      const expiringN = cap + 1;
      const freshN = 5;
      const overPlanted = [];
      for (let i = 0; i < expiringN; i += 1) {
        const bits = WIDTHS[i % WIDTHS.length];
        const row = pinShare(shareOf(overDests[i % overDests.length], heldHeader, i + 1, bits));
        over.pool.deferredShares.push(row);
        overPlanted.push(row);
      }
      for (let i = 0; i < freshN; i += 1) {
        const bits = WIDTHS[(i + 1) % WIDTHS.length];
        const row = pinShare(shareOf(overDests[i % overDests.length], liveHeader, i + 1, bits));
        over.pool.openShares.push(row);
        overPlanted.push(row);
      }
      await sealJob(over.pool, live);
      over.pool.rollOpenRound();
      const published = over.pool.issueJob(undefined, { force: true });
      assert.ok(published?.jobId);
      const publishedN = (over.pool.store.jobs.get(String(published.jobId)).tpl.shareBatch || []).length;
      assert.equal(publishedN, cap);
      assert.equal(over.pool.lag1Shares.length, cap);
      assert.equal(over.pool.deferredShares.length, freshN);
      assertHonest(overPlanted, over.pool, over.dir);
      let spillUnits = 0n;
      const sealKeys = new Set(over.pool.lag1Shares.map(workKey));
      for (const s of overPlanted) {
        if (Buffer.from(s.verifiedHeader).equals(heldHeader) && !sealKeys.has(workKey(s))) {
          spillUnits += BigInt(unitsForShare(s.shareBits));
        }
      }
      assert.equal(owedUnits(over.pool), spillUnits);
      assert.ok(spillUnits > 0n);
      const pub = over.pool.publicStats();
      assert.equal(pub.windowOwedUnits, spillUnits.toString());
      assert.equal(typeof pub.windowOwedUnits, 'string');
      assert.equal(pub.windowOwedNotes > 0, true);
      const pubJson = JSON.stringify(pub);
      assert.equal(pubJson.includes(workKey(overPlanted[0])), false);
      assert.equal(pubJson.includes(overDests[0]), false);
      const reloaded = createPool({ dataDir: over.dir, stratumPort: 0, httpPort: 0, miner: FEE });
      pools.push({ pool: reloaded, dir: over.dir });
      assert.equal(owedUnits(reloaded), spillUnits);
      assert.equal(reloaded.windowOwedRows().length, over.pool.windowOwedRows().length);

      const wide = poolAt('wide');
      pools.push(wide);
      const wideGenesis = wide.pool.issueJob(undefined, { force: true });
      await sealJob(wide.pool, wideGenesis);
      const wideHeld = Buffer.from(wide.pool.store.tip().header);
      const wideJob = wide.pool.issueJob(undefined, { force: true });
      const wideLive = Buffer.from(wideJob.header, 'hex');
      const wideDests = destsOf(3);
      const widePlanted = [];
      for (let i = 0; i < cap * 2; i += 1) {
        const bits = WIDTHS[i % WIDTHS.length];
        const row = pinShare(shareOf(wideDests[i % wideDests.length], wideHeld, i + 1, bits));
        wide.pool.deferredShares.push(row);
        widePlanted.push(row);
      }
      for (let i = 0; i < cap; i += 1) {
        const bits = WIDTHS[(i + 2) % WIDTHS.length];
        const row = pinShare(shareOf(wideDests[i % wideDests.length], wideLive, i + 1, bits));
        wide.pool.openShares.push(row);
        widePlanted.push(row);
      }
      await sealJob(wide.pool, wideJob);
      wide.pool.rollOpenRound();
      assert.equal(wide.pool.lag1Shares.length, cap);
      assert.equal(wide.pool.deferredShares.length, cap);
      assertHonest(widePlanted, wide.pool, wide.dir);
      assert.ok(owedUnits(wide.pool) > spillUnits);
    } finally {
      for (const row of pools) {
        try { row.pool.close(); } catch { /* ignore */ }
      }
    }
  });
});
