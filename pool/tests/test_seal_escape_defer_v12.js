import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  HASH_BONUS_NANOS,
  MAX_SHARES_PER_BLOCK,
  SHARE_FLOOR_BITS,
} from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { openedCoinbaseNanos } from '../../crypto/note.js';
import { hashOwedFromTx } from '../../crypto/hash_owed.js';
import {
  nonceWithShareTarget,
  unitsForShare,
  noteCommitOfShare,
  rememberLiveSharePow,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import { buildTemplate, retarget, shouldAdopt } from '../../node/src/chain.js';
import { createPool, SEAL_ESCAPE_AFTER } from '../src/pool.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 9000;
function nextPow() {
  powTag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  return h.toString('hex');
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function poolAt(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-defer-${tag}-`));
  return createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
}

function nonceKey(share) {
  return BigInt(share?.nonce || 0).toString();
}

function nonceSet(shares) {
  return new Set((shares || []).map(nonceKey));
}

function commitHex(share) {
  return Buffer.from(noteCommitOfShare(share)).toString('hex');
}

async function sealParent(pool) {
  const genesis = pool.issueJob(undefined, { force: true });
  assert.ok(genesis?.jobId);
  const sealed = await pool.sealFoundShare({
    jobId: genesis.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(sealed.ok, true, sealed.reason || 'parent');
  return pool.store.tip().header;
}

function pushProven(pool, parent, rows) {
  const made = [];
  for (const row of rows) {
    const nonce = nonceWithShareTarget(BigInt(row.low), row.bits);
    const share = {
      dest: row.dest,
      nonce,
      lz: row.bits,
      shareBits: row.bits,
      creditedShareBits: row.bits,
      verifiedHeader: parent,
      hash: '11',
    };
    const remembered = rememberLiveSharePow(parent, nonce, {
      noteCommit: noteCommitOfShare(share),
      shareBits: row.bits,
      lz: row.bits,
    });
    assert.equal(remembered, true);
    pool.lag1Shares.push(share);
    made.push(share);
  }
  const job = pool.issueJob(undefined, { force: true });
  assert.ok(job?.jobId);
  assert.equal(pool.lag1Shares.length, rows.length);
  return made;
}

function rowsOf(count, dests, lowBase, order) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      dest: dests[i % dests.length],
      low: lowBase + i + 1,
      bits: SHARE_FLOOR_BITS + (i % 3),
    });
  }
  const idx = order || rows.map((_, i) => i);
  return idx.map((i) => rows[i]);
}

function armEscape(pool, limit) {
  const realProbe = pool.store.probeBlock.bind(pool.store);
  pool.store.probeBlock = (block) => {
    const n = (block?.shareBatch || []).length;
    if (n > limit) return { ok: false, reason: 'append' };
    return realProbe(block);
  };
  let submits = 0;
  const realSubmit = pool.store.submitHeader.bind(pool.store);
  pool.store.submitHeader = (req, opts) => {
    submits += 1;
    const rec = pool.store.jobs.get(String(req.jobId));
    const n = (rec?.tpl?.shareBatch || []).length;
    if (submits <= SEAL_ESCAPE_AFTER || n > limit) return { ok: false, reason: 'append' };
    return realSubmit(req, opts);
  };
  return () => {
    pool.store.probeBlock = realProbe;
    pool.store.submitHeader = realSubmit;
  };
}

async function escapeAndSealPrefix(pool) {
  for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
    const got = await pool.sealFoundShare({
      jobId: pool.lastJob.jobId,
      nonce: 0n,
      miner: FEE,
      powHash: nextPow(),
    });
    assert.equal(got.ok, false);
  }
  const deferred = pool.deferredShares.map((s) => nonceKey(s));
  assert.ok(deferred.length > 0);
  const paid = await pool.sealFoundShare({
    jobId: pool.lastJob.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(paid.ok, true, paid.reason || 'prefix');
  return deferred;
}

function stratumRoll(pool) {
  pool.rollOpenRound();
  return pool.issueJob(undefined, { force: true });
}

function liveNonces(pool) {
  return nonceSet([
    ...pool.lag1Shares,
    ...pool.openShares,
    ...pool.deferredShares,
  ]);
}

async function sealJob(pool, job) {
  assert.ok(job?.jobId, 'next job');
  const got = await pool.sealFoundShare({
    jobId: job.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(got.ok, true, got.reason || 'later');
  return got;
}

function hashNanosByCommit(block) {
  const out = new Map();
  const cb = block?.txs?.[0];
  for (const o of cb?.vout || []) {
    if (o.kind !== 'hash' || !o.noteCommit) continue;
    const v = openedCoinbaseNanos(o);
    if (v == null) continue;
    const hex = Buffer.from(o.noteCommit).toString('hex');
    out.set(hex, (out.get(hex) || 0) + v);
  }
  return out;
}

function owedByCommit(block) {
  const out = new Map();
  const rows = hashOwedFromTx(block?.txs?.[0]);
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const hex = Buffer.from(row.noteCommit).toString('hex');
    out.set(hex, (out.get(hex) || 0n) + BigInt(row.nanos));
  }
  return out;
}

function chainNonces(blocks, fromHeight) {
  const out = new Set();
  for (const b of blocks) {
    if (Number(b.height) < fromHeight) continue;
    for (const s of b.shareBatch || []) out.add(nonceKey(s));
  }
  return out;
}

function assertPaid(pool, made, deferredNonces, fromHeight) {
  const blocks = pool.store.blocks;
  const sealed = chainNonces(blocks, fromHeight);
  const missing = deferredNonces.filter((n) => !sealed.has(n));
  assert.equal(missing.length, 0, `deferred missing from sealed batches ${missing.length}`);
  const want = new Map();
  for (const s of made) {
    const hex = commitHex(s);
    want.set(hex, (want.get(hex) || 0) + unitsForShare(s.shareBits));
  }
  const paid = new Map();
  for (const b of blocks) {
    if (Number(b.height) < fromHeight) continue;
    for (const [hex, v] of hashNanosByCommit(b)) {
      paid.set(hex, (paid.get(hex) || 0) + v);
    }
  }
  const owed = owedByCommit(blocks[blocks.length - 1]);
  for (const [hex, units] of want) {
    const got = paid.get(hex) || 0;
    const rest = Number(owed.get(hex) || 0n);
    assert.equal(got + rest, units * HASH_BONUS_NANOS, hex.slice(0, 8));
  }
}

function heavierFork(store, dest, parentIndex, count, tagBase, stepMs = 90_000) {
  const prefix = store.blocks.slice(0, parentIndex + 1);
  const out = [];
  let prev = prefix[prefix.length - 1];
  let now = Number(decodeHeader(Buffer.from(prev.header)).timestamp) + stepMs;
  for (let i = 0; i < count; i += 1) {
    const bits = retarget(prefix.concat(out), now);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits,
      parentBlocks: prefix.concat(out),
    });
    const pow = easyPow(tagBase + i);
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      hash: pow,
      height: Number(prev.height) + 1,
      weight: tpl.weight,
    };
    out.push(block);
    prev = block;
    now += stepMs;
  }
  return out;
}

describe('v12 deferred seal-escape shares are paid', () => {
  it('pays every deferred nonce in a later block, at any width and dest count', { timeout: 300_000 }, async () => {
    const pools = [];
    try {
      const spreads = [
        { tag: 'one', count: 4, dests: 1, limit: 3, low: 100, orders: [null] },
        {
          tag: 'few',
          count: 8,
          dests: 3,
          limit: 3,
          low: 400,
          orders: [
            [0, 1, 2, 3, 4, 5, 6, 7],
            [7, 6, 5, 4, 3, 2, 1, 0],
            [3, 0, 6, 1, 5, 2, 7, 4],
          ],
        },
        { tag: 'many', count: 12, dests: 12, limit: 4, low: 800, orders: [null] },
      ];
      const paidSets = [];
      for (const spec of spreads) {
        const dests = Array.from({ length: spec.dests }, () => minerDest());
        for (const order of spec.orders) {
          const pool = poolAt(`${spec.tag}-${order ? order[0] : 0}`);
          pools.push(pool);
          const parent = await sealParent(pool);
          const rows = rowsOf(spec.count, dests, spec.low, order);
          const made = pushProven(pool, parent, rows);
          const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
          const disarm = armEscape(pool, spec.limit);
          const deferred = await escapeAndSealPrefix(pool);
          disarm();
          const fromHeight = Number(pool.store.tip().height);
          const next = stratumRoll(pool);
          const live = liveNonces(pool);
          const lost = (Number(pool.stats.lostWorkHashes) || 0) - beforeLost;
          const gone = deferred.filter((n) => !live.has(n));
          assert.equal(gone.length, 0, `${spec.tag} dropped ${gone.length} lost ${lost} job ${next ? 'yes' : 'no'}`);
          assert.equal(lost, 0, `${spec.tag} lost`);
          await sealJob(pool, next);
          const after = stratumRoll(pool);
          await sealJob(pool, after);
          assertPaid(pool, made, deferred, fromHeight);
          if (spec.tag === 'few') paidSets.push([...deferred].sort());
          const paying = pool.store.blocks.find((b) => Number(b.height) === fromHeight);
          const proof = pool.store.blocks[pool.store.blocks.indexOf(paying) - 1];
          const prefix = made.find((s) => !deferred.includes(nonceKey(s)));
          const replay = verifyShareBatch({
            parentHeader: paying.header,
            priorHeader: proof.header,
            excludeNonces: nonceSet(paying.shareBatch),
            shares: [prefix],
            skipPow: true,
          });
          assert.equal(replay.ok, false, replay.reason || 'replay');
        }
      }
      assert.deepEqual(paidSets[1], paidSets[0]);
      assert.deepEqual(paidSets[2], paidSets[0]);
    } finally {
      for (const pool of pools) {
        try { await pool.close(); } catch { /* closed */ }
      }
    }
  });

  it('pays most of a share-cap batch in the next block', { timeout: 300_000 }, async () => {
    const pool = poolAt('cap');
    try {
      const dest = minerDest();
      const parent = await sealParent(pool);
      const width = MAX_SHARES_PER_BLOCK;
      const limit = 128;
      const rows = [];
      for (let i = 0; i < width; i += 1) {
        rows.push({ dest, low: i + 1, bits: SHARE_FLOOR_BITS });
      }
      const made = pushProven(pool, parent, rows);
      const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
      const disarm = armEscape(pool, limit);
      const deferred = await escapeAndSealPrefix(pool);
      disarm();
      assert.ok(deferred.length > width / 2, `deferred ${deferred.length}`);
      const fromHeight = Number(pool.store.tip().height);
      const next = stratumRoll(pool);
      const live = liveNonces(pool);
      const lost = (Number(pool.stats.lostWorkHashes) || 0) - beforeLost;
      const gone = deferred.filter((n) => !live.has(n));
      assert.equal(gone.length, 0, `cap dropped ${gone.length} lost ${lost}`);
      await sealJob(pool, next);
      const after = stratumRoll(pool);
      await sealJob(pool, after);
      assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0);
      assertPaid(pool, made, deferred, fromHeight);
    } finally {
      try { await pool.close(); } catch { /* closed */ }
    }
  });

  it('a reorg between N and N+1 keeps payable deferred shares and counts the rest', { timeout: 180_000 }, async () => {
    const pool = poolAt('reorg');
    try {
      const dests = [minerDest(), minerDest(), minerDest()];
      const parent = await sealParent(pool);
      const made = pushProven(pool, parent, rowsOf(6, dests, 2000));
      const disarm = armEscape(pool, 2);
      const deferred = await escapeAndSealPrefix(pool);
      disarm();
      const staleBits = SHARE_FLOOR_BITS + 1;
      const staleNonce = nonceWithShareTarget(9_000_000n, staleBits);
      const stale = {
        dest: dests[0],
        nonce: staleNonce,
        lz: staleBits,
        shareBits: staleBits,
        creditedShareBits: staleBits,
        verifiedHeader: Buffer.alloc(128, 9),
      };
      pool.lag1Shares.push(stale);
      const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
      const parentIndex = pool.store.blocks.length - 2;
      // One sibling keeps the proof header as the parent of the new tip, so the
      // next block can still re-seal those shares. A longer fork leaves that
      // header outside the one-step window and the work is counted, not paid.
      let fork = heavierFork(pool.store, FEE, parentIndex, 1, 50_000, 1);
      let candidate = pool.store.blocks.slice(0, parentIndex + 1).concat(fork);
      if (!shouldAdopt(pool.store.blocks, candidate)) {
        fork[0].hash = Buffer.alloc(32, 0);
        candidate = pool.store.blocks.slice(0, parentIndex + 1).concat(fork);
      }
      assert.equal(shouldAdopt(pool.store.blocks, candidate), true);
      const tipTs = Number(decodeHeader(Buffer.from(fork[fork.length - 1].header)).timestamp);
      const adopted = await Promise.resolve(pool.store.ingest(fork, {
        trustBlockHash: true,
        nowMs: Math.max(Date.now(), tipTs),
      }));
      assert.equal(adopted.ok, true, adopted.reason || 'reorg');
      assert.equal(adopted.reorg, true);
      const live = liveNonces(pool);
      const gone = deferred.filter((n) => !live.has(n));
      assert.equal(gone.length, 0, `reorg dropped ${gone.length}`);
      const lost = (Number(pool.stats.lostWorkHashes) || 0) - beforeLost;
      assert.equal(lost, 0, `lost ${lost}`);
      const owed = pool.windowOwedRows().reduce((sum, row) => sum + BigInt(row.units), 0n);
      assert.equal(owed, BigInt(unitsForShare(staleBits)));
      assert.equal(live.has(nonceKey(stale)), false);
      const fromHeight = Number(pool.store.tip().height) + 1;
      const next = pool.lastJob || pool.issueJob(undefined, { force: true });
      await sealJob(pool, next);
      const sealed = chainNonces(pool.store.blocks, fromHeight);
      const missing = deferred.filter((n) => !sealed.has(n));
      assert.equal(missing.length, 0, `reorg unpaid ${missing.length}`);
      const batch = pool.store.tip().shareBatch || [];
      const again = verifyShareBatch({
        parentHeader: pool.store.blocks[pool.store.blocks.length - 2].header,
        priorHeader: pool.store.blocks[pool.store.blocks.length - 3].header,
        excludeNonces: nonceSet(pool.store.blocks[pool.store.blocks.length - 2].shareBatch),
        shares: batch,
        skipPow: true,
      });
      assert.equal(again.ok, true, again.reason || 'grandparent');
      void made;
    } finally {
      try { await pool.close(); } catch { /* closed */ }
    }
  });
});
