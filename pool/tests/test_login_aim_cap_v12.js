import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { SHEARK_MINER_VERSION } from '../../crypto/asert.js';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';
import {
  cachedFinderTemplate,
  finderAimSeals,
  resetFinderAimSeals,
  templateForFinder,
} from '../../node/src/chain.js';
import {
  LOGIN_PER_IP_MAX,
  configuredFeeIdentity,
  createPool,
} from '../src/pool.js';

function dest() {
  return freshStealthDest(newIdentity()).dest;
}

function turn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeSock() {
  const lines = [];
  return {
    lines,
    setNoDelay() {},
    write(s) {
      lines.push(String(s));
      return true;
    },
  };
}

function openPool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-login-aim-'));
  const fee = configuredFeeIdentity();
  assert.equal(fee.ok, true);
  const pool = createPool({
    dataDir: dir,
    stratumPort: 0,
    httpPort: 0,
    miner: fee.feeDest,
  });
  return pool;
}

describe('PSA-5a56-3 login cap and one finder seal per turn', () => {
  it('a cache miss does not seal, and a burst aims one dest per later turn', async () => {
    const pool = openPool();
    try {
      const job = pool.issueJob();
      const tpl = pool.store.jobs.get(String(job.jobId))?.tpl;
      assert.ok(tpl?.levyBind, 'issued template carries a levy bind');
      // An empty mempool has no fee, so the live bind is zero. Plant the
      // finder half the fee path would have sealed into the shared job.
      tpl.levyBind.finderNanos = 500;
      const warm = dest();
      resetFinderAimSeals();
      const missed = cachedFinderTemplate(tpl, warm);
      assert.equal(missed.ok, true);
      assert.equal(missed.miss, true);
      assert.equal(finderAimSeals(), 0);
      const aimed = templateForFinder(tpl, warm);
      assert.ok(aimed?.header);
      assert.equal(finderAimSeals(), 1);
      const hit = cachedFinderTemplate(tpl, warm);
      assert.equal(hit.ok, true);
      assert.equal(hit.miss, undefined);
      assert.equal(finderAimSeals(), 1);

      const dests = [dest(), dest(), dest()];
      const socks = dests.map((d) => {
        const sock = fakeSock();
        pool.miners.set(d, {
          login: d,
          payoutDest: d,
          workerKey: d,
          connections: [{ sock, shareBits: 8 }],
        });
        return sock;
      });
      const feeSock = fakeSock();
      const feeDest = dest();
      pool.miners.set(feeDest, {
        login: feeDest,
        payoutDest: feeDest,
        workerKey: feeDest,
        connections: [{ sock: feeSock, shareBits: 8, shearFeeRoute: true }],
      });
      const before = finderAimSeals();
      const n = pool.broadcastJob(job);
      assert.equal(n, 4);
      assert.equal(finderAimSeals(), before, 'the handler does not seal');
      for (const sock of socks) {
        assert.equal(sock.lines.length, 1);
        const msg = JSON.parse(sock.lines[0]);
        assert.equal(msg.params.jobId, job.jobId);
        assert.equal(msg.params.header, job.header);
      }
      assert.equal(feeSock.lines.length, 1);
      assert.equal(JSON.parse(feeSock.lines[0]).params.jobId, job.jobId);

      await turn();
      assert.equal(finderAimSeals(), before + 1);
      assert.equal(socks.filter((s) => s.lines.length === 2).length, 1);
      const follow = JSON.parse(socks.find((s) => s.lines.length === 2).lines[1]);
      assert.ok(String(follow.params.jobId).startsWith(`${job.jobId}.`));
      assert.notEqual(follow.params.header, job.header);
      assert.equal(feeSock.lines.length, 1);

      await turn();
      await turn();
      assert.equal(finderAimSeals(), before + 3);
      assert.ok(socks.every((s) => s.lines.length === 2));
      assert.equal(feeSock.lines.length, 1);

      const cached = finderAimSeals();
      pool.broadcastJob(job);
      await turn();
      await turn();
      assert.equal(finderAimSeals(), cached, 'a cached dest is not sealed again');
    } finally {
      pool.close();
    }
  });

  it('a fresh login past the per-IP cap is busy and does not join', async () => {
    const pool = openPool();
    const sockets = [];
    try {
      await new Promise((resolve, reject) => {
        pool.stratum.listen(0, '127.0.0.1', resolve);
        pool.stratum.on('error', reject);
      });
      const port = pool.stratum.address().port;
      const seeded = pool.issueJob();
      const seededTpl = pool.store.jobs.get(String(seeded.jobId))?.tpl;
      seededTpl.levyBind.finderNanos = 500;
      resetFinderAimSeals();
      const known = [];
      // R28 option 2: a login is a worker name only.
      for (let i = 0; i < LOGIN_PER_IP_MAX; i += 1) {
        const d = `rig${i}`;
        const got = await login(port, d);
        assert.equal(got.msg.result?.status, 'OK', got.msg.error || 'login');
        assert.equal(got.msg.job?.jobId, pool.lastJob.jobId);
        known.push({ dest: d, sock: got.sock });
        sockets.push(got.sock);
      }
      assert.equal(pool.miners.size, LOGIN_PER_IP_MAX);
      const extra = 'rig-extra';
      const before = pool.miners.size;
      const seals = finderAimSeals();
      const refused = await login(port, extra);
      sockets.push(refused.sock);
      assert.equal(refused.msg.error, 'busy');
      assert.equal(pool.miners.has(extra), false);
      assert.equal(pool.miners.size, before);
      await turn();
      await turn();
      assert.equal(finderAimSeals(), seals, 'a refused login does not seal');
      const again = await login(port, known[0].dest);
      sockets.push(again.sock);
      assert.equal(again.msg.result?.status, 'OK');
      assert.equal(pool.miners.size, before);
    } finally {
      for (const sock of sockets) {
        try { sock.destroy(); } catch { /* closed */ }
      }
      pool.close();
    }
  });
});

function login(port, who) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`${JSON.stringify({
        id: 1,
        method: 'login',
        params: {
          login: who,
          client: 'ShearHash',
          version: SHEARK_MINER_VERSION,
          name: 'ShearK-Miner',
          threads: 1,
        },
      })}\n`);
    });
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('login_timeout'));
    }, 5000);
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (!buf.includes('\n')) return;
      clearTimeout(timer);
      try {
        resolve({ sock, msg: JSON.parse(buf.split('\n')[0]) });
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
