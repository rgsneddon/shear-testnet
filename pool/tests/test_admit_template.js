import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, encodeDest, hash20FromAddress } from '../../crypto/address.js';
import { bindWeightFee, levyNeed } from '../../crypto/levy.js';
import { signSpendTx } from '../../crypto/spend.js';
import { lockTx, VOTE_HOLD, portalIdFromDest } from '../../crypto/reserve_vault.js';
import { createStore } from '../../node/src/store.js';
import { attachPoolIpc, attachSidecarIpc } from '../../node/src/p2p_ipc.js';
import { createPool } from '../src/pool.js';

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest, key: id.privateKey };
}

function userIds(store, job) {
  const rec = job?.jobId ? store.jobs.get(String(job.jobId)) : null;
  return (rec?.tpl?.txs || []).filter((t) => t && !t.coinbase).map((t) => String(t.id));
}

function publicReceipt(who, kind, id) {
  const d20 = Buffer.from(hash20FromAddress(who.dest));
  const tx = {
    id,
    kind,
    nanos: kind === 'vote' ? 0 : 1,
    portalId: portalIdFromDest(who.dest),
    payoutPortalId: portalIdFromDest(who.dest),
    vin: [{ dest20: d20 }],
    vout: [{
      kind,
      dest20: d20,
      portalId: portalIdFromDest(who.dest),
      valueProof: { v: kind === 'vote' ? 0 : 1 },
    }],
  };
  if (kind === 'vote') tx.choice = VOTE_HOLD;
  tx.fee = 0;
  for (let i = 0; i < 6; i += 1) {
    bindWeightFee(tx);
    if (levyNeed(tx) === tx.fee) break;
  }
  signSpendTx(tx, who.key);
  return tx;
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
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-tpl-'));
    const pool = createPool({
      dataDir: dir,
      miner: who.dest,
      stratumPort: 0,
      httpPort: 0,
    });
    try {
      await pool.listen();
      const tipH = pool.store.tip()?.height || 0;

      const emptyAt = Date.now();
      const empty = pool.issueJob(undefined, { force: true });
      const emptyMs = Date.now() - emptyAt;
      assert.ok(empty && empty.jobId);
      assert.equal(userIds(pool.store, empty).length, 0);
      assert.ok(emptyMs < 2000, `empty rebuild ${emptyMs}ms`);

      const lock = publicReceipt(who, 'lock', 'lock-job');
      const lockAt = Date.now();
      const queued = pool.store.queueTx(lock);
      assert.equal(queued.ok, true, queued.reason);
      const packed = pool.issueJob();
      const lockMs = Date.now() - lockAt;
      assert.ok(lockMs < 2000, `lock rebuild ${lockMs}ms`);
      assert.notEqual(packed.jobId, empty.jobId);
      assert.equal(pool.store.tip()?.height || 0, tipH);
      assert.ok(userIds(pool.store, packed).includes('lock-job'), userIds(pool.store, packed).join(','));
      const restamp = pool.issueJob(9);
      assert.equal(restamp.jobId, packed.jobId, 'unchanged mempool must keep the job id');

      const vote = publicReceipt(who, 'vote', 'vote-job');
      const qv = pool.store.queueTx(vote);
      assert.equal(qv.ok, true, qv.reason);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      let newest = null;
      for (const rec of pool.store.jobs.values()) newest = rec;
      const ids = (newest?.tpl?.txs || []).filter((t) => t && !t.coinbase).map((t) => String(t.id));
      assert.ok(ids.includes('lock-job'), ids.join(','));
      assert.ok(ids.includes('vote-job'), ids.join(','));
      assert.equal(pool.store.tip()?.height || 0, tipH);
      const held = pool.issueJob();
      assert.equal(held.jobId, newest.job.jobId);

      const bad = lockTx({ from: who.dest, to: who.dest, nanos: 1, id: 'lock-rejected' });
      bindWeightFee(bad);
      bad.maxLevy = bad.fee;
      const refused = pool.store.queueTx(bad);
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'admit_version');
      assert.equal(pool.store.mempool.some((m) => m.id === 'lock-rejected'), false);

      pool.store.mempool.push({
        id: 'pool-private',
        kind: 'send',
        fee: 9,
        to: who.dest,
        vout: [{ address: who.dest }],
      });
      const port = pool.httpServer.address().port;
      const shown = await fetch(`http://127.0.0.1:${port}/api/mempool`).then((r) => r.json());
      assert.equal(shown.pending.some((t) => t.id === 'lock-job'), true);
      assert.equal(shown.pending.some((t) => t.id === 'vote-job'), true);
      assert.equal(shown.pending.some((t) => t.id === 'lock-rejected'), false);
      assert.equal(shown.pending.some((t) => t.id === 'pool-private'), false);
      assert.equal(shown.pendingBlock.txs.some((t) => t.id === 'lock-job' && t.kind === 'lock'), true);
      assert.equal(shown.pendingBlock.txs.some((t) => t.id === 'vote-job' && t.kind === 'vote'), true);
      assert.equal(JSON.stringify(shown).includes(who.dest), false);
      assert.doesNotMatch(JSON.stringify(shown), /ssa1/);
    } finally {
      pool.close();
    }
  });

  it('forwards an admitted lock from a non-mining node into the job store', { timeout: 120_000 }, async () => {
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-ipc-'));
    const sideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-side-'));
    const pool = createPool({
      dataDir: dir,
      miner: who.dest,
      stratumPort: 0,
      httpPort: 0,
    });
    const side = createStore(sideDir);
    let ipc = null;
    let sideIpc = null;
    try {
      await pool.listen();
      ipc = await attachPoolIpc({ store: pool.store, port: 0 });
      sideIpc = attachSidecarIpc({ store: side, addr: `127.0.0.1:${ipc.port}` });
      const before = pool.issueJob(undefined, { force: true });
      const tipH = pool.store.tip()?.height || 0;
      const lock = publicReceipt(who, 'lock', 'lock-ipc');
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
      assert.equal(pool.store.tip()?.height || 0, tipH);
      assert.notEqual(job.jobId, before.jobId);
      assert.ok(userIds(pool.store, job).includes('lock-ipc'), userIds(pool.store, job).join(','));
    } finally {
      try { sideIpc?.close(); } catch { /* ignore */ }
      try { ipc?.close(); } catch { /* ignore */ }
      pool.close();
    }
  });
});
