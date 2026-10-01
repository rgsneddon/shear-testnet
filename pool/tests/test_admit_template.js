import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NANOS_PER_SHE,
  SPENDABLE_CONFIRMATIONS,
  TARGET_BLOCK_INTERVAL_MS,
} from '../../crypto/asert.js';
import { newIdentity, destOpeningFromView, ed25519SeedOf, freshStealthDest } from '../../crypto/address.js';
import { vaultDest } from '../../crypto/flow_sheet.js';
import { bindWeightFee } from '../../crypto/levy.js';
import { matureSpendableNanos, signSpendTx } from '../../crypto/spend.js';
import { lockTx, voteTx, VOTE_HOLD } from '../../crypto/reserve_vault.js';
import { createStore } from '../../node/src/store.js';
import { attachPoolIpc, attachSidecarIpc } from '../../node/src/p2p_ipc.js';
import { createPool } from '../src/pool.js';

function spendBox(id) {
  const pay = freshStealthDest(id);
  return {
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
  };
}

function userIds(store, job) {
  const rec = job?.jobId ? store.jobs.get(String(job.jobId)) : null;
  return (rec?.tpl?.txs || []).filter((t) => t && !t.coinbase).map((t) => String(t.id));
}

async function fund(store, dest) {
  const n = 4 + SPENDABLE_CONFIRMATIONS;
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < n; i += 1) {
    const { tpl } = store.template({ miner: dest, now: t0 + i * TARGET_BLOCK_INTERVAL_MS });
    const pow = Buffer.alloc(32, 0);
    pow[30] = 4;
    pow[31] = i + 1;
    const got = await Promise.resolve(store.append({
      header: Buffer.from(tpl.header),
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }, { trustedPowHash: pow, skipSharePow: true }));
    assert.equal(got.ok, true, `${got.reason || ''} ${got.error || ''}`);
  }
}

function signedLock(box, vault, id, nanos = NANOS_PER_SHE) {
  const lock = lockTx({ from: box.dest, to: vault, nanos, id });
  lock.open = destOpeningFromView(box.viewKey, box.spendPub, 0);
  bindWeightFee(lock);
  lock.maxLevy = lock.fee;
  signSpendTx(lock, box.key);
  return lock;
}

async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return !!pred();
}

describe('admitted txs enter the live miner template', () => {
  it('packs every admitted lock and vote while the tip stays put', { timeout: 120_000 }, async () => {
    const alice = newIdentity();
    const box = spendBox(alice);
    box.viewKey = alice.viewKey;
    box.spendPub = alice.spendPub;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-tpl-'));
    const pool = createPool({
      dataDir: dir,
      miner: box.dest,
      stratumPort: 0,
      httpPort: 0,
    });
    try {
      await pool.listen();
      await fund(pool.store, box.dest);
      const have = matureSpendableNanos(pool.store.historyFor(box.dest), box.dest, pool.store.tip().height);
      assert.ok(have >= NANOS_PER_SHE, `funded ${have}`);
      const tipH = pool.store.tip().height;

      const emptyAt = Date.now();
      const empty = pool.issueJob(undefined, { force: true });
      const emptyMs = Date.now() - emptyAt;
      assert.ok(empty && empty.jobId);
      assert.equal(userIds(pool.store, empty).length, 0);
      assert.ok(emptyMs < 2000, `empty rebuild ${emptyMs}ms`);

      const lock = signedLock(box, vault, 'lock-job');
      const lockAt = Date.now();
      const queued = pool.store.queueTx(lock);
      assert.equal(queued.ok, true, queued.reason);
      const packed = pool.issueJob();
      const lockMs = Date.now() - lockAt;
      assert.ok(lockMs < 2000, `lock rebuild ${lockMs}ms`);
      assert.notEqual(packed.jobId, empty.jobId);
      assert.equal(pool.store.tip().height, tipH);
      assert.ok(userIds(pool.store, packed).includes('lock-job'), userIds(pool.store, packed).join(','));
      const restamp = pool.issueJob(9);
      assert.equal(restamp.jobId, packed.jobId, 'unchanged mempool must keep the job id');

      const vote = voteTx({ from: box.dest, dest: vault, choice: VOTE_HOLD, id: 'vote-job' });
      vote.open = lock.open;
      vote.payer = box.dest;
      bindWeightFee(vote);
      vote.maxLevy = vote.fee;
      signSpendTx(vote, box.key);
      const qv = pool.store.queueTx(vote);
      assert.equal(qv.ok, true, qv.reason);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      let newest = null;
      for (const rec of pool.store.jobs.values()) newest = rec;
      const ids = (newest?.tpl?.txs || []).filter((t) => t && !t.coinbase).map((t) => String(t.id));
      assert.ok(ids.includes('lock-job'), ids.join(','));
      assert.ok(ids.includes('vote-job'), ids.join(','));
      assert.equal(pool.store.tip().height, tipH);
      const held = pool.issueJob();
      assert.equal(held.jobId, newest.job.jobId);

      const bad = lockTx({ from: box.dest, to: vault, nanos: NANOS_PER_SHE, id: 'lock-rejected' });
      bad.open = lock.open;
      bindWeightFee(bad);
      bad.maxLevy = bad.fee;
      const refused = pool.store.queueTx(bad);
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'unsigned');
      assert.equal(pool.store.mempool.some((m) => m.id === 'lock-rejected'), false);

      pool.store.mempool.push({
        id: 'pool-private',
        kind: 'send',
        fee: 9,
        to: box.dest,
        vout: [{ address: box.dest }],
      });
      const port = pool.httpServer.address().port;
      const shown = await fetch(`http://127.0.0.1:${port}/api/mempool`).then((r) => r.json());
      assert.equal(shown.pending.some((t) => t.id === 'lock-job'), true);
      assert.equal(shown.pending.some((t) => t.id === 'vote-job'), true);
      assert.equal(shown.pending.some((t) => t.id === 'lock-rejected'), false);
      assert.equal(shown.pending.some((t) => t.id === 'pool-private'), false);
      assert.equal(shown.pendingBlock.txs.some((t) => t.id === 'lock-job' && t.kind === 'lock'), true);
      assert.equal(shown.pendingBlock.txs.some((t) => t.id === 'vote-job' && t.kind === 'vote'), true);
      assert.equal(JSON.stringify(shown).includes(box.dest), false);
      assert.doesNotMatch(JSON.stringify(shown), /ssa1/);
    } finally {
      pool.close();
    }
  });

  it('forwards an admitted lock from a non-mining node into the job store', { timeout: 120_000 }, async () => {
    const alice = newIdentity();
    const box = spendBox(alice);
    box.viewKey = alice.viewKey;
    box.spendPub = alice.spendPub;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-ipc-'));
    const sideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-side-'));
    const pool = createPool({
      dataDir: dir,
      miner: box.dest,
      stratumPort: 0,
      httpPort: 0,
    });
    const side = createStore(sideDir);
    let ipc = null;
    let sideIpc = null;
    try {
      await pool.listen();
      const n = 4 + SPENDABLE_CONFIRMATIONS;
      const t0 = 1_700_000_000_000;
      for (let i = 0; i < n; i += 1) {
        const { tpl } = pool.store.template({ miner: box.dest, now: t0 + i * TARGET_BLOCK_INTERVAL_MS });
        const pow = Buffer.alloc(32, 0);
        pow[30] = 5;
        pow[31] = i + 1;
        const block = {
          header: Buffer.from(tpl.header),
          txs: tpl.txs,
          samples: tpl.samples,
          shareBatch: tpl.shareBatch || [],
          miner: box.dest,
          aLeaves: tpl.aLeaves,
          bLeaves: tpl.bLeaves,
          rootA: tpl.rootA,
          rootB: tpl.rootB,
          weight: tpl.weight,
        };
        const a = await Promise.resolve(pool.store.append(block, { trustedPowHash: pow, skipSharePow: true }));
        assert.equal(a.ok, true, a.reason || a.error);
        const b = await Promise.resolve(side.append({
          ...block,
          header: Buffer.from(block.header),
        }, { trustedPowHash: pow, skipSharePow: true }));
        assert.equal(b.ok, true, b.reason || b.error);
      }
      ipc = await attachPoolIpc({ store: pool.store, port: 0 });
      sideIpc = attachSidecarIpc({ store: side, addr: `127.0.0.1:${ipc.port}` });
      const before = pool.issueJob(undefined, { force: true });
      const tipH = pool.store.tip().height;
      const lock = signedLock(box, vault, 'lock-ipc');
      const t0send = Date.now();
      const queued = side.queueTx(lock);
      assert.equal(queued.ok, true, queued.reason);
      const arrived = await waitFor(
        () => pool.store.mempool.some((m) => String(m.id) === 'lock-ipc'),
        2000,
      );
      assert.equal(arrived, true, `ipc miss ${Date.now() - t0send}ms`);
      assert.ok(Date.now() - t0send < 2000);
      const job = pool.issueJob();
      assert.equal(pool.store.tip().height, tipH);
      assert.notEqual(job.jobId, before.jobId);
      assert.ok(userIds(pool.store, job).includes('lock-ipc'), userIds(pool.store, job).join(','));
    } finally {
      try { sideIpc?.close(); } catch { /* ignore */ }
      try { ipc?.close(); } catch { /* ignore */ }
      pool.close();
    }
  });
});
