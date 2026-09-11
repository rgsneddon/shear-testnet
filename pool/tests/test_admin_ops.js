import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { Readable } from 'node:stream';
import {
  ADMIN_HOST,
  ADMIN_USER,
  createAdmin,
  handleAdminApi,
  handleAdminHttp,
} from '../src/admin.js';
import { createPool, adminMinerView } from '../src/pool.js';

function url(p) {
  return new URL(`https://${ADMIN_HOST}${p}`);
}

function cookieOf(headers) {
  const raw = String(headers?.['Set-Cookie'] || '');
  const m = raw.match(/shear_admin=([0-9a-f]+)/);
  return m ? `shear_admin=${m[1]}` : '';
}

describe('kyrusfables operator desk', () => {
  it('non-loopback POST allowSetup:true is setup_forbidden', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-remote-'));
    const admin = createAdmin(dir);
    const prev = process.env.SHEAR_ADMIN_SETUP;
    delete process.env.SHEAR_ADMIN_SETUP;
    const req = Readable.from([Buffer.from(JSON.stringify({
      user: 'operator', password: 'aaaaaaaa', allowSetup: true,
    }))]);
    req.method = 'POST';
    req.url = '/api/admin/setup';
    req.headers = { host: ADMIN_HOST, 'content-type': 'application/json' };
    req.socket = { remoteAddress: '203.0.113.9' };
    let raw = '';
    const res = {
      statusCode: 0,
      setHeader() {},
      end(s) { raw = String(s || ''); },
    };
    await handleAdminHttp(req, res, { admin });
    const json = JSON.parse(raw);
    assert.equal(json.ok, false);
    assert.equal(json.reason, 'setup_forbidden');
    assert.equal(admin.status().setup, false);
    if (prev == null) delete process.env.SHEAR_ADMIN_SETUP;
    else process.env.SHEAR_ADMIN_SETUP = prev;
  });

  it('SHEAR_ADMIN_SETUP=1 without loopback is setup_forbidden; loopback+env is first-run only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-env-'));
    const admin = createAdmin(dir);
    const prev = process.env.SHEAR_ADMIN_SETUP;
    process.env.SHEAR_ADMIN_SETUP = '1';
    try {
      assert.equal(admin.setup({ user: 'operator', password: 'aaaaaaaa' }).reason, 'setup_forbidden');
      const remoteReq = Readable.from([Buffer.from(JSON.stringify({
        user: 'operator', password: 'aaaaaaaa',
      }))]);
      remoteReq.method = 'POST';
      remoteReq.url = '/api/admin/setup';
      remoteReq.headers = { host: ADMIN_HOST, 'content-type': 'application/json' };
      remoteReq.socket = { remoteAddress: '198.51.100.9' };
      let remoteRaw = '';
      const remoteRes = { statusCode: 0, setHeader() {}, end(s) { remoteRaw = String(s || ''); } };
      await handleAdminHttp(remoteReq, remoteRes, { admin });
      const remoteJson = JSON.parse(remoteRaw);
      assert.equal(remoteJson.ok, false);
      assert.equal(remoteJson.reason, 'setup_forbidden');
      assert.equal(admin.status().setup, false);

      const localReq = Readable.from([Buffer.from(JSON.stringify({
        user: 'operator', password: 'aaaaaaaa',
      }))]);
      localReq.method = 'POST';
      localReq.url = '/api/admin/setup';
      localReq.headers = { host: ADMIN_HOST, 'content-type': 'application/json' };
      localReq.socket = { remoteAddress: '127.0.0.1' };
      let localRaw = '';
      const localRes = { statusCode: 0, setHeader() {}, end(s) { localRaw = String(s || ''); } };
      await handleAdminHttp(localReq, localRes, { admin });
      const localJson = JSON.parse(localRaw);
      assert.equal(localJson.ok, true, localJson.reason);
      assert.equal(admin.status().setup, true);
    } finally {
      if (prev == null) delete process.env.SHEAR_ADMIN_SETUP;
      else process.env.SHEAR_ADMIN_SETUP = prev;
    }
  });

  it('pause, restart hooks, miner table, kick, ban, and clear-stale require a session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-ops-'));
    const admin = createAdmin(dir);
    const calls = { pause: [], restart: 0, hasher: 0, kick: [], stale: 0 };
    const miners = [{ tag: 'mabcd1234', worker: 'rig', accepted: 4, stale: 9, hashrate: 12 }];
    const ops = {
      health: () => ({ paused: false, height: 9, accepted: 4, stale: 9 }),
      miners: () => miners,
      setPaused: (v) => { calls.pause.push(v); return { paused: !!v }; },
      restart: () => { calls.restart += 1; return { scheduled: true }; },
      restartHasher: () => { calls.hasher += 1; return { scheduled: true }; },
      rebroadcast: () => ({ n: 2, jobId: 'j1' }),
      disconnectAll: () => ({ dropped: 3 }),
      kick: (w) => { calls.kick.push(w); return { dropped: 1 }; },
      ban: (w) => ({ banned: true, dropped: 1, miner: w }),
      unban: () => ({ banned: false }),
      clearStale: () => { calls.stale += 1; return { stale: 0 }; },
    };
    const run = (p, method, body, cookie, extra = {}) => handleAdminApi(url(p), method, body, { admin, ops, cookie, ...extra });

    assert.equal(run('/api/admin/health', 'GET').status, 401);
    assert.equal(run('/api/admin/restart', 'POST').status, 401);

    const remote = run('/api/admin/setup', 'POST', { user: 'operator', password: 'aaaaaaaa', allowSetup: true });
    assert.equal(remote.json.ok, false);
    assert.equal(remote.json.reason, 'setup_forbidden');
    assert.equal(admin.status().setup, false);

    const created = run('/api/admin/setup', 'POST', {
      user: 'operator', password: 'aaaaaaaa', setupToken: admin.setupToken,
    });
    assert.equal(created.json.ok, true, created.json.reason);
    const cookie = cookieOf(created.headers);

    const health = run('/api/admin/health', 'GET', {}, cookie);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.height, 9);

    const list = run('/api/admin/miners', 'GET', {}, cookie);
    assert.equal(list.json.n, 1);
    assert.equal(list.json.miners[0].tag, 'mabcd1234');

    assert.equal(run('/api/admin/pause', 'POST', {}, cookie).json.paused, true);
    assert.equal(run('/api/admin/resume', 'POST', {}, cookie).json.paused, false);
    assert.deepEqual(calls.pause, [true, false]);

    assert.equal(run('/api/admin/restart', 'POST', {}, cookie).json.scheduled, true);
    assert.equal(run('/api/admin/restart-hasher', 'POST', {}, cookie).json.scheduled, true);
    assert.equal(calls.restart, 1);
    assert.equal(calls.hasher, 1);

    assert.equal(run('/api/admin/rebroadcast', 'POST', {}, cookie).json.n, 2);
    assert.equal(run('/api/admin/disconnect-all', 'POST', {}, cookie).json.dropped, 3);
    assert.equal(run('/api/admin/kick', 'POST', { miner: 'mabcd1234' }, cookie).json.dropped, 1);
    assert.equal(calls.kick[0], 'mabcd1234');
    assert.equal(run('/api/admin/clear-stale', 'POST', {}, cookie).json.stale, 0);
    assert.equal(calls.stale, 1);
    assert.equal(run('/api/admin/ban', 'POST', {}, cookie).status, 400);
  });

  it('paused pool rejects shares without counting stale; restart hook fires; accepted is kept', async () => {
    const dest = destForLogin(newIdentity().address, { viewKey: newIdentity().viewKey, height: 1 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-pool-'));
    let restarts = 0;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 1,
      bits: 16,
      onRestart: () => { restarts += 1; return { scheduled: true }; },
      onRestartHasher: () => ({ scheduled: true }),
    });
    const admin = pool.admin;
    const setup = handleAdminApi(url('/api/admin/setup'), 'POST', {
      user: 'operator', password: 'aaaaaaaa', setupToken: admin.setupToken,
    }, { admin, ops: pool.adminOps });
    const cookie = cookieOf(setup.headers);
    const row = {
      login: dest,
      workerKey: `${dest}.rig`,
      accepted: 7,
      stale: 4,
      roundHashes: 8,
      connections: [{ sock: {}, shareBits: 8 }],
      version: '1.2',
      name: 'ShearK-Miner',
    };
    pool.miners.set(row.workerKey, row);
    const view = adminMinerView(row);
    assert.equal(view.accepted, 7);
    assert.equal(view.stale, 4);
    assert.equal(view.connected, true);
    assert.ok(view.tag.startsWith('m'));

    const paused = handleAdminApi(url('/api/admin/pause'), 'POST', { pause: true }, {
      admin, ops: pool.adminOps, cookie,
    });
    assert.equal(paused.json.paused, true);
    assert.equal(pool.paused, true);

    const health = handleAdminApi(url('/api/admin/health'), 'GET', {}, { admin, ops: pool.adminOps, cookie });
    assert.equal(health.json.paused, true);
    const list = handleAdminApi(url('/api/admin/miners'), 'GET', {}, { admin, ops: pool.adminOps, cookie });
    assert.ok(list.json.miners.some((m) => m.accepted === 7));

    handleAdminApi(url('/api/admin/clear-stale'), 'POST', {}, { admin, ops: pool.adminOps, cookie });
    assert.equal(pool.stats.stale, 0);
    assert.equal(row.stale, 0);
    assert.equal(row.accepted, 7);

    const rst = handleAdminApi(url('/api/admin/restart'), 'POST', {}, { admin, ops: pool.adminOps, cookie });
    assert.equal(rst.json.scheduled, true);
    assert.equal(restarts, 1);

    handleAdminApi(url('/api/admin/resume'), 'POST', {}, { admin, ops: pool.adminOps, cookie });
    assert.equal(pool.paused, false);
    pool.close();
  });
});
