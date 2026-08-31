import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  createPool,
  scoreShare,
  rememberJobHeader,
  candidateShareHeaders,
  isStaleReject,
  jobWithinGrace,
  JOB_RESTAMP_MS,
  PREV_JOB_GRACE_MS,
  JOB_HEADER_HISTORY,
} from '../src/pool.js';
import { decodeHeader, headerFromHex } from '../../crypto/header.js';

function tmpPool(shareBits = 1) {
  const dest = destForLogin(newIdentity().address, { viewKey: newIdentity().viewKey, height: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stale-'));
  const pool = createPool({
    dataDir: dir,
    stratumPort: 0,
    httpPort: 0,
    miner: dest,
    shareBits,
    bits: 16,
  });
  return { pool, dest };
}

function findShare(job, max = 64n) {
  for (let nonce = 0n; nonce < max; nonce += 1n) {
    const s = scoreShare({ job, nonce });
    if (s.ok) return { nonce, s };
  }
  throw new Error('no_share');
}

function findMiss(job, max = 4096n) {
  for (let nonce = 0n; nonce < max; nonce += 1n) {
    const s = scoreShare({ job, nonce });
    if (!s.ok && s.reason === 'low_diff' && s.hash) return { nonce, s };
  }
  throw new Error('no_low_diff');
}

async function listen(pool) {
  await new Promise((resolve, reject) => {
    pool.stratum.listen(0, '127.0.0.1', () => {
      pool.httpServer.listen(0, '127.0.0.1', resolve);
    });
    pool.stratum.on('error', reject);
  });
  return pool.stratum.address().port;
}

function loginAndSubmit(port, dest, submits) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const replies = [];
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(JSON.stringify({
        id: 1,
        method: 'login',
        params: { login: `${dest}.rig`, client: 'ShearHash', name: 'ShearK-Miner', version: '1.2', threads: 1 },
      }) + '\n');
    });
    sock.on('data', (c) => {
      buf += c.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.id === 1 || msg.job || (msg.result && msg.result.status === 'OK' && msg.job)) {
          for (const s of submits) {
            sock.write(JSON.stringify({
              id: s.id,
              method: 'submit',
              params: { jobId: s.jobId, nonce: String(s.nonce), hash: s.hash },
            }) + '\n');
          }
          continue;
        }
        replies.push(msg);
        if (replies.length >= submits.length) {
          sock.end();
          resolve(replies);
        }
      }
    });
    setTimeout(() => reject(new Error('timeout')), 120000);
  });
}

describe('stale classification and restamp/grace accept', () => {
  it('only stale_job counts as stale; restamp history is kept', () => {
    assert.equal(isStaleReject('stale_job'), true);
    assert.equal(isStaleReject('stale'), true);
    assert.equal(isStaleReject('bad_hash'), false);
    assert.equal(isStaleReject('duplicate_share'), false);
    assert.equal(isStaleReject('low_diff'), false);
    assert.equal(JOB_HEADER_HISTORY, 12);
    assert.equal(PREV_JOB_GRACE_MS, 3_000);
    const job = { jobId: 'j', header: 'aa' };
    rememberJobHeader(job, 'aa');
    rememberJobHeader(job, 'bb');
    const c = candidateShareHeaders({ ...job, header: 'cc' });
    assert.equal(c[0], 'cc');
    assert.ok(c.includes('aa'));
    assert.equal(jobWithinGrace({ jobId: 'old' }, { jobId: 'old' }, Date.now() - 500), true);
    assert.equal(jobWithinGrace({ jobId: 'old' }, { jobId: 'old' }, Date.now() - 10_000), false);
    const { pool } = tmpPool(8);
    const a = pool.issueJob();
    a.timestamp = String(Date.now() - JOB_RESTAMP_MS - 50_000);
    const b = pool.issueJob(9);
    assert.equal(b.jobId, a.jobId, 'mid-round issueJob must not mint a new RandomX K');
    assert.equal(b.shareBits, 9);
    pool.close();
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /rememberJobHeader/);
    assert.match(src, /closedRound/);
    assert.equal(/m\.accepted = 0/.test(src), false);
    assert.equal(/session\.accepted = 0/.test(src), false);
  });

  it('a share on the pre-restamp header of the same jobId is accepted', async () => {
    const { pool, dest } = tmpPool(1);
    const job = pool.issueJob();
    const hit = findShare(job);
    const beforeHeader = job.header;
    job.timestamp = String(Date.now() - JOB_RESTAMP_MS - 50);
    const next = pool.restampJob();
    assert.equal(next.jobId, job.jobId);
    assert.notEqual(next.header, beforeHeader);
    const scored = scoreShare({ job: next, nonce: hit.nonce, claimed: hit.s.hash });
    assert.equal(scored.ok, true, JSON.stringify(scored));
    assert.equal(scored.hash, hit.s.hash);
    const port = await listen(pool);
    const stale0 = pool.stats.stale;
    const acc0 = pool.stats.accepted;
    const replies = await loginAndSubmit(port, dest, [{
      id: 2, jobId: next.jobId, nonce: hit.nonce, hash: hit.s.hash,
    }]);
    const ack = replies.find((m) => m.id === 2);
    assert.ok(ack?.result?.status === 'OK', JSON.stringify(ack));
    assert.equal(pool.stats.stale, stale0);
    assert.equal(pool.stats.accepted, acc0 + 1);
    const miner = [...pool.miners.values()][0];
    assert.ok(Number(miner.accepted) >= 1);
    pool.close();
  });

  it('previous-job share after a new round is not stale and does not add roundHashes', async () => {
    const { pool, dest } = tmpPool(1);
    const job = pool.issueJob();
    const a = findShare(job);
    let b;
    for (let nonce = a.nonce + 1n; nonce < a.nonce + 64n; nonce += 1n) {
      const s = scoreShare({ job, nonce });
      if (s.ok) { b = { nonce, s }; break; }
    }
    assert.ok(b, 'need a second share on the same job');
    const port = await listen(pool);
    await loginAndSubmit(port, dest, [{
      id: 2, jobId: job.jobId, nonce: a.nonce, hash: a.s.hash,
    }]);
    const miner = [...pool.miners.values()][0];
    const acceptedBefore = Number(miner.accepted);
    const roundBefore = Number(miner.roundHashes);
    const staleBefore = Number(miner.stale) || 0;
    assert.ok(acceptedBefore >= 1);
    assert.ok(roundBefore > 0);
    const next = pool.issueJob(1, { force: true });
    assert.notEqual(next.jobId, job.jobId);
    assert.ok(pool.prevJob && pool.prevJob.jobId === job.jobId);
    const replies = await loginAndSubmit(port, dest, [{
      id: 3, jobId: job.jobId, nonce: b.nonce, hash: b.s.hash,
    }]);
    const ack = replies.find((m) => m.id === 3);
    assert.ok(!ack?.error, JSON.stringify(ack));
    assert.equal(ack?.result?.status, 'OK');
    assert.equal(Number(miner.stale) || 0, staleBefore);
    assert.equal(Number(miner.roundHashes), roundBefore);
    assert.equal(Number(miner.accepted), acceptedBefore + 1);
    pool.close();
  });

  it('bad_hash, duplicate_share, and low_diff do not increment stale; accepted survives a round roll', async () => {
    const { pool, dest } = tmpPool(1);
    const job = pool.issueJob();
    const hit = findShare(job);
    const port = await listen(pool);
    const first = await loginAndSubmit(port, dest, [{
      id: 2, jobId: job.jobId, nonce: hit.nonce, hash: hit.s.hash,
    }]);
    assert.equal(first.find((m) => m.id === 2)?.result?.status, 'OK');
    const miner = [...pool.miners.values()][0];
    const stale0 = Number(miner.stale) || 0;
    const accepted0 = Number(miner.accepted);
    const dup = await loginAndSubmit(port, dest, [{
      id: 3, jobId: job.jobId, nonce: hit.nonce, hash: hit.s.hash,
    }]);
    assert.equal(dup.find((m) => m.id === 3)?.error, 'duplicate_share');
    const bad = await loginAndSubmit(port, dest, [{
      id: 4, jobId: job.jobId, nonce: hit.nonce, hash: 'ab'.repeat(32),
    }]);
    assert.equal(bad.find((m) => m.id === 4)?.error, 'bad_hash');
    pool.close();

    const { pool: pool2, dest: dest2 } = tmpPool(8);
    const job2 = pool2.issueJob();
    const miss = findMiss(job2);
    const port2 = await listen(pool2);
    const low = await loginAndSubmit(port2, dest2, [{
      id: 2, jobId: job2.jobId, nonce: miss.nonce, hash: miss.s.hash,
    }]);
    const lowMsg = low.find((m) => m.id === 2);
    assert.equal(lowMsg?.error, 'low_diff');
    const miner2 = [...pool2.miners.values()][0];
    assert.equal(Number(miner2.stale) || 0, 0);
    pool2.close();

    const { pool: pool3, dest: dest3 } = tmpPool(1);
    const job3 = pool3.issueJob();
    const hit3 = findShare(job3);
    const port3 = await listen(pool3);
    await loginAndSubmit(port3, dest3, [{
      id: 2, jobId: job3.jobId, nonce: hit3.nonce, hash: hit3.s.hash,
    }]);
    const miner3 = [...pool3.miners.values()][0];
    const kept = Number(miner3.accepted);
    assert.ok(kept >= 1);
    pool3.issueJob(1, { force: true });
    assert.equal(Number(miner3.accepted), kept);
    assert.equal(Number(miner.stale) || 0, stale0);
    assert.equal(Number(miner.accepted), accepted0);
    pool3.close();
  });
});
