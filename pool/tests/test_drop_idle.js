import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  createPool,
  scoreShare,
  isWrongAlgoReject,
  shouldDropOnReject,
  idleDropSocks,
  NO_VALID_SHARE_MS,
} from '../src/pool.js';

function dest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function tmpPool(shareBits = 1, extra = {}) {
  const d = dest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-drop-'));
  const pool = createPool({
    dataDir: dir,
    stratumPort: 0,
    httpPort: 0,
    miner: d,
    shareBits,
    bits: 16,
    ...extra,
  });
  return { pool, dest: d };
}

async function listen(pool) {
  await new Promise((resolve, reject) => {
    pool.stratum.listen(0, '127.0.0.1', resolve);
    pool.stratum.on('error', reject);
  });
  return pool.stratum.address().port;
}

function readLines(sock, msgs) {
  let buf = '';
  sock.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (raw) msgs.push(JSON.parse(raw));
    }
  });
}

function waitClose(sock, ms = 4000) {
  return new Promise((resolve, reject) => {
    if (sock.destroyed || sock.readyState === 'closed') {
      resolve();
      return;
    }
    const t = setTimeout(() => reject(new Error('still_connected')), ms);
    sock.once('close', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function waitMsg(msgs, pred, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = msgs.find(pred);
      if (hit) {
        resolve(hit);
        return;
      }
      if (Date.now() - t0 > ms) {
        reject(new Error(`timeout ${JSON.stringify(msgs)}`));
        return;
      }
      setTimeout(tick, 15);
    };
    tick();
  });
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

describe('drop idle / wrong-algo miners', () => {
  it('classifies wrong-algo rejects and idle sockets', () => {
    assert.equal(isWrongAlgoReject('client_refused'), true);
    assert.equal(isWrongAlgoReject('bad_hash'), true);
    assert.equal(isWrongAlgoReject('need_hash'), true);
    assert.equal(isWrongAlgoReject('low_diff'), false);
    assert.equal(isWrongAlgoReject('stale_job'), false);
    assert.equal(isWrongAlgoReject('duplicate_share'), false);
    assert.equal(shouldDropOnReject({ accepted: 0 }, 'bad_hash'), true);
    assert.equal(shouldDropOnReject({ accepted: 3 }, 'bad_hash'), false);
    assert.equal(shouldDropOnReject({ accepted: 3 }, 'need_hash'), true);
    assert.equal(shouldDropOnReject({ accepted: 0 }, 'low_diff'), false);
    assert.ok(NO_VALID_SHARE_MS >= 60_000);

    const live = { sock: { id: 1 } };
    const idle = {
      accepted: 0,
      connections: [{ sock: live, authedAt: Date.now() - NO_VALID_SHARE_MS - 1 }],
    };
    assert.equal(idleDropSocks(idle).includes(live), true);
    const scored = { ...idle, accepted: 1 };
    assert.equal(idleDropSocks(scored).length, 0);
    const fresh = {
      accepted: 0,
      connections: [{ sock: live, authedAt: Date.now() }],
    };
    assert.equal(idleDropSocks(fresh).length, 0);
    const inflight = {
      accepted: 0,
      connections: [{ sock: live, authedAt: 1, hashInflight: 1 }],
    };
    assert.equal(idleDropSocks(inflight).length, 0);
  });

  it('drops a login that names the wrong algo and does not list the hasher', async () => {
    const { pool, dest } = tmpPool(1);
    const port = await listen(pool);
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    const msgs = [];
    readLines(sock, msgs);
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
    sock.write(JSON.stringify({
      id: 1,
      method: 'login',
      params: { login: `${dest}.rx`, client: 'rx/0', algo: 'sha256', threads: 1 },
    }) + '\n');
    const err = await waitMsg(msgs, (m) => m.id === 1 && m.error);
    assert.equal(err.error, 'client_refused');
    await waitClose(sock);
    assert.equal(pool.miners.size, 0);
    assert.ok((Number(pool.stats.dropped) || 0) >= 1);
    pool.close();
  });

  it('drops a hasher that submits no digest or a non-ShearHash digest', async () => {
    const { pool, dest } = tmpPool(1);
    const port = await listen(pool);
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    const msgs = [];
    readLines(sock, msgs);
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
    sock.write(JSON.stringify({
      id: 1,
      method: 'login',
      params: { login: `${dest}.old`, client: 'ShearHash', name: 'Shear-Miner', threads: 1 },
    }) + '\n');
    const login = await waitMsg(msgs, (m) => m.id === 1);
    assert.equal(login.error, undefined);
    const jobId = login.job?.jobId || login.result?.jobId;
    sock.write(JSON.stringify({
      id: 2,
      method: 'submit',
      params: { jobId, nonce: '1', hashes: 9e12, hashrate: 1e9 },
    }) + '\n');
    const need = await waitMsg(msgs, (m) => m.id === 2);
    assert.equal(need.error, 'need_hash');
    await waitClose(sock);
    pool.close();

    const { pool: pool2, dest: dest2 } = tmpPool(1);
    const port2 = await listen(pool2);
    const sock2 = net.connect(port2, '127.0.0.1');
    sock2.on('error', () => {});
    const msgs2 = [];
    readLines(sock2, msgs2);
    await new Promise((res, rej) => { sock2.on('connect', res); sock2.on('error', rej); });
    sock2.write(JSON.stringify({
      id: 1,
      method: 'login',
      params: { login: `${dest2}.bad`, client: 'ShearHash', threads: 1 },
    }) + '\n');
    const login2 = await waitMsg(msgs2, (m) => m.id === 1);
    sock2.write(JSON.stringify({
      id: 2,
      method: 'submit',
      params: { jobId: login2.job?.jobId, nonce: '0', hash: 'ab'.repeat(32) },
    }) + '\n');
    const bad = await waitMsg(msgs2, (m) => m.id === 2);
    assert.equal(bad.error, 'bad_hash');
    await waitClose(sock2);
    pool2.close();
  });

  it('low_diff (right algo, below share bits) does not drop; idle never-share does', async () => {
    const { pool, dest } = tmpPool(8);
    const job = pool.issueJob();
    const miss = findMiss(job);
    const port = await listen(pool);
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    const msgs = [];
    readLines(sock, msgs);
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
    sock.write(JSON.stringify({
      id: 1,
      method: 'login',
      params: { login: `${dest}.low`, client: 'ShearHash', threads: 1 },
    }) + '\n');
    await waitMsg(msgs, (m) => m.id === 1);
    sock.write(JSON.stringify({
      id: 2,
      method: 'submit',
      params: { jobId: job.jobId, nonce: String(miss.nonce), hash: miss.s.hash },
    }) + '\n');
    const low = await waitMsg(msgs, (m) => m.id === 2);
    assert.equal(low.error, 'low_diff');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sock.destroyed, false);
    const miner = [...pool.miners.values()][0];
    assert.ok(miner);
    assert.equal(Number(miner.accepted) || 0, 0);
    sock.destroy();
    pool.close();

    const { pool: idlePool, dest: idleDest } = tmpPool(1, { noValidShareMs: 80 });
    const idlePort = await listen(idlePool);
    const idleSock = net.connect(idlePort, '127.0.0.1');
    idleSock.on('error', () => {});
    const idleMsgs = [];
    readLines(idleSock, idleMsgs);
    await new Promise((res, rej) => { idleSock.on('connect', res); idleSock.on('error', rej); });
    idleSock.write(JSON.stringify({
      id: 1,
      method: 'login',
      params: { login: `${idleDest}.idle`, client: 'ShearHash', threads: 1 },
    }) + '\n');
    await waitMsg(idleMsgs, (m) => m.id === 1);
    const note = await waitMsg(idleMsgs, (m) => m.error === 'no_valid_share' || m.method === 'error', 2000)
      .catch(() => null);
    await waitClose(idleSock, 2000);
    if (note) assert.equal(note.error, 'no_valid_share');
    idlePool.sweepIdle(Date.now());
    const left = [...idlePool.miners.values()].filter((m) => (m.connections || []).some((c) => c.sock));
    assert.equal(left.length, 0);
    idlePool.close();
  });

  it('a hasher with an accepted ShearHash-v3 share is not idle-dropped', async () => {
    const { pool, dest } = tmpPool(1, { noValidShareMs: 80 });
    const job = pool.issueJob();
    const hit = findShare(job);
    const port = await listen(pool);
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    const msgs = [];
    readLines(sock, msgs);
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
    sock.write(JSON.stringify({
      id: 1,
      method: 'login',
      params: { login: `${dest}.ok`, client: 'ShearHash', name: 'ShearK-Miner', threads: 1 },
    }) + '\n');
    await waitMsg(msgs, (m) => m.id === 1);
    sock.write(JSON.stringify({
      id: 2,
      method: 'submit',
      params: { jobId: job.jobId, nonce: String(hit.nonce), hash: hit.s.hash },
    }) + '\n');
    const ack = await waitMsg(msgs, (m) => m.id === 2);
    assert.equal(ack.error, undefined, JSON.stringify(ack));
    assert.equal(ack.result?.status, 'OK');
    await new Promise((r) => setTimeout(r, 200));
    pool.sweepIdle(Date.now());
    assert.equal(sock.destroyed, false);
    const miner = [...pool.miners.values()][0];
    assert.ok(Number(miner.accepted) >= 1);
    sock.destroy();
    pool.close();
  });
});
