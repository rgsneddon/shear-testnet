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
  createAdmin,
  handleAdminApi,
  handleAdminHttp,
} from '../src/admin.js';
import { createPool, adminMinerView } from '../src/pool.js';

function url(p) {
  return new URL(`https://${ADMIN_HOST}${p}`);
}

describe('operator desk', () => {
  it('non-admin-host POST is setup_forbidden when SHEAR_ADMIN_HOST is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-remote-'));
    const admin = createAdmin(dir);
    const prev = process.env.SHEAR_ADMIN_SETUP;
    const prevHost = process.env.SHEAR_ADMIN_HOST;
    delete process.env.SHEAR_ADMIN_SETUP;
    process.env.SHEAR_ADMIN_HOST = 'admin.mypool.site';
    const req = Readable.from([Buffer.from(JSON.stringify({
      user: 'operator', password: 'aaaaaaaa', allowSetup: true,
    }))]);
    req.method = 'POST';
    req.url = '/api/admin/setup';
    req.headers = { host: 'pool.shear.digital', 'content-type': 'application/json' };
    req.socket = { remoteAddress: '203.0.113.9' };
    let raw = '';
    const res = {
      statusCode: 0,
      setHeader() {},
      end(s) { raw = String(s || ''); },
    };
    await handleAdminHttp(req, res, { admin });
    const json = JSON.parse(raw);
    assert.equal(res.statusCode, 404);
    assert.equal(json.ok, false);
    assert.equal(json.reason, 'admin_absent');
    assert.equal(admin.status().setup, false);
    if (prev == null) delete process.env.SHEAR_ADMIN_SETUP;
    else process.env.SHEAR_ADMIN_SETUP = prev;
    if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
    else process.env.SHEAR_ADMIN_HOST = prevHost;
  });

  it('SHEAR_ADMIN_HOST unset: non-loopback is setup_forbidden; loopback+SHEAR_ADMIN_SETUP=1 first-runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-deny-'));
    const admin = createAdmin(dir);
    const prev = process.env.SHEAR_ADMIN_SETUP;
    const prevHost = process.env.SHEAR_ADMIN_HOST;
    delete process.env.SHEAR_ADMIN_HOST;
    delete process.env.SHEAR_ADMIN_SETUP;
    try {
      assert.equal(admin.setup({ user: 'operator', password: 'aaaaaaaa' }).reason, 'setup_forbidden');
      const remoteReq = Readable.from([Buffer.from(JSON.stringify({
        user: 'operator', password: 'aaaaaaaa',
      }))]);
      remoteReq.method = 'POST';
      remoteReq.url = '/api/admin/setup';
      remoteReq.headers = { host: 'mypool.site', 'content-type': 'application/json' };
      remoteReq.socket = { remoteAddress: '203.0.113.9' };
      let remoteRaw = '';
      const remoteRes = { statusCode: 0, setHeader() {}, end(s) { remoteRaw = String(s || ''); } };
      await handleAdminHttp(remoteReq, remoteRes, { admin });
      const remoteJson = JSON.parse(remoteRaw);
      assert.equal(remoteRes.statusCode, 404);
      assert.equal(remoteJson.ok, false);
      assert.equal(remoteJson.reason, 'admin_absent');
      assert.equal(admin.status().setup, false);

      process.env.SHEAR_ADMIN_SETUP = '1';
      const localReq = Readable.from([Buffer.from(JSON.stringify({
        user: 'operator', password: 'aaaaaaaa',
      }))]);
      localReq.method = 'POST';
      localReq.url = '/api/admin/setup';
      localReq.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
      localReq.socket = { remoteAddress: '127.0.0.1' };
      let localRaw = '';
      const localRes = { statusCode: 0, setHeader() {}, end(s) { localRaw = String(s || ''); } };
      await handleAdminHttp(localReq, localRes, { admin });
      const localJson = JSON.parse(localRaw);
      assert.equal(localRes.statusCode, 404);
      assert.equal(localJson.ok, false);
      assert.equal(localJson.reason, 'admin_absent');
      assert.equal(admin.status().setup, false);
    } finally {
      if (prev == null) delete process.env.SHEAR_ADMIN_SETUP;
      else process.env.SHEAR_ADMIN_SETUP = prev;
      if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prevHost;
    }
  });

  it('SHEAR_ADMIN_SETUP=1 without loopback is setup_forbidden; loopback+env is first-run only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-env-'));
    const admin = createAdmin(dir);
    const prev = process.env.SHEAR_ADMIN_SETUP;
    const prevHost = process.env.SHEAR_ADMIN_HOST;
    process.env.SHEAR_ADMIN_SETUP = '1';
    process.env.SHEAR_ADMIN_HOST = 'admin.mypool.site';
    try {
      assert.equal(admin.setup({ user: 'operator', password: 'aaaaaaaa' }).reason, 'setup_forbidden');
      const remoteReq = Readable.from([Buffer.from(JSON.stringify({
        user: 'operator', password: 'aaaaaaaa',
      }))]);
      remoteReq.method = 'POST';
      remoteReq.url = '/api/admin/setup';
      remoteReq.headers = { host: 'pool.shear.digital', 'content-type': 'application/json' };
      remoteReq.socket = { remoteAddress: '198.51.100.9' };
      let remoteRaw = '';
      const remoteRes = { statusCode: 0, setHeader() {}, end(s) { remoteRaw = String(s || ''); } };
      await handleAdminHttp(remoteReq, remoteRes, { admin });
      const remoteJson = JSON.parse(remoteRaw);
      assert.equal(remoteRes.statusCode, 404);
      assert.equal(remoteJson.ok, false);
      assert.equal(remoteJson.reason, 'admin_absent');
      assert.equal(admin.status().setup, false);

      const localReq = Readable.from([Buffer.from(JSON.stringify({
        user: 'operator', password: 'aaaaaaaa',
      }))]);
      localReq.method = 'POST';
      localReq.url = '/api/admin/setup';
      localReq.headers = { host: 'admin.mypool.site', 'content-type': 'application/json' };
      localReq.socket = { remoteAddress: '127.0.0.1' };
      let localRaw = '';
      const localRes = { statusCode: 0, setHeader() {}, end(s) { localRaw = String(s || ''); } };
      await handleAdminHttp(localReq, localRes, { admin });
      const localJson = JSON.parse(localRaw);
      assert.equal(localRes.statusCode, 404);
      assert.equal(localJson.ok, false);
      assert.equal(localJson.reason, 'admin_absent');
      assert.equal(admin.status().setup, false);
    } finally {
      if (prev == null) delete process.env.SHEAR_ADMIN_SETUP;
      else process.env.SHEAR_ADMIN_SETUP = prev;
      if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prevHost;
    }
  });

  it('http cannot pause, restart, ban, or clear stale; the process ops still can', () => {
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
      ban: (w) => ({ banned: !!w, dropped: w ? 1 : 0, miner: w }),
      unban: () => ({ banned: false }),
      clearStale: () => { calls.stale += 1; return { stale: 0 }; },
    };
    const prevHost = process.env.SHEAR_ADMIN_HOST;
    process.env.SHEAR_ADMIN_HOST = 'admin.mypool.site';
    try {
      const run = (p, method, body, extra = {}) => handleAdminApi(url(p), method, body, {
        admin, ops, cookie: 'shear_admin=deadbeef', loopback: true, host: 'admin.mypool.site', ...extra,
      });
      const routes = [
        ['/api/admin/health', 'GET', {}],
        ['/api/admin/setup', 'POST', { user: 'operator', password: 'aaaaaaaa', allowSetup: true, setupToken: admin.setupToken }],
        ['/api/admin/miners', 'GET', {}],
        ['/api/admin/pause', 'POST', { pause: true }],
        ['/api/admin/resume', 'POST', {}],
        ['/api/admin/restart', 'POST', {}],
        ['/api/admin/restart-hasher', 'POST', {}],
        ['/api/admin/rebroadcast', 'POST', {}],
        ['/api/admin/disconnect-all', 'POST', {}],
        ['/api/admin/kick', 'POST', { miner: 'mabcd1234' }],
        ['/api/admin/clear-stale', 'POST', {}],
        ['/api/admin/unban', 'POST', { miner: 'mabcd1234' }],
        ['/api/admin/ban', 'POST', { miner: 'mabcd1234' }],
        ['/api/admin/ban', 'POST', {}],
      ];
      for (const [p, method, body] of routes) {
        const got = run(p, method, body);
        assert.equal(got.status, 404, p);
        assert.equal(got.json.ok, false, p);
        assert.equal(got.json.reason, 'admin_absent', p);
      }
      assert.equal(admin.status().setup, false);
      assert.deepEqual(calls.pause, []);
      assert.equal(calls.restart, 0);
      assert.equal(calls.hasher, 0);
      assert.equal(calls.stale, 0);
      assert.deepEqual(calls.kick, []);
      assert.equal(fs.existsSync(path.join(dir, 'admin-audit.jsonl')), false);

      assert.equal(ops.setPaused(true).paused, true);
      assert.equal(ops.setPaused(false).paused, false);
      assert.deepEqual(calls.pause, [true, false]);
      assert.equal(ops.health().height, 9);
      assert.equal(ops.miners()[0].tag, 'mabcd1234');
      assert.equal(ops.restart().scheduled, true);
      assert.equal(ops.restartHasher().scheduled, true);
      assert.equal(calls.restart, 1);
      assert.equal(calls.hasher, 1);
      assert.equal(ops.rebroadcast().n, 2);
      assert.equal(ops.disconnectAll().dropped, 3);
      assert.equal(ops.kick('mabcd1234').dropped, 1);
      assert.equal(calls.kick[0], 'mabcd1234');
      assert.equal(ops.clearStale().stale, 0);
      assert.equal(calls.stale, 1);
      assert.equal(ops.unban('mabcd1234').banned, false);
      assert.equal(ops.ban('').banned, false);
      assert.equal(ops.ban('mabcd1234').banned, true);
    } finally {
      if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prevHost;
    }
  });

  it('http pause does not pause the pool; process ops still pause, clear stale, and restart', async () => {
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
    }, { admin, ops: pool.adminOps, loopback: true, host: '127.0.0.1' });
    assert.equal(setup.status, 404);
    assert.equal(setup.json.reason, 'admin_absent');
    assert.equal(admin.status().setup, false);
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
      admin, ops: pool.adminOps, loopback: true, host: '127.0.0.1',
    });
    assert.equal(paused.status, 404);
    assert.equal(paused.json.reason, 'admin_absent');
    assert.equal(pool.paused, false);

    assert.equal(pool.adminOps.setPaused(true).paused, true);
    assert.equal(pool.paused, true);
    const health = pool.adminOps.health();
    assert.equal(health.paused, true);
    const list = pool.adminOps.miners();
    assert.ok(list.some((m) => m.accepted === 7));

    const httpClear = handleAdminApi(url('/api/admin/clear-stale'), 'POST', {}, {
      admin, ops: pool.adminOps, loopback: true,
    });
    assert.equal(httpClear.status, 404);
    assert.equal(row.stale, 4);
    pool.adminOps.clearStale();
    assert.equal(pool.stats.stale, 0);
    assert.equal(row.stale, 0);
    assert.equal(row.accepted, 7);

    const httpRestart = handleAdminApi(url('/api/admin/restart'), 'POST', {}, {
      admin, ops: pool.adminOps, loopback: true,
    });
    assert.equal(httpRestart.status, 404);
    assert.equal(restarts, 0);
    const rst = pool.adminOps.restart();
    assert.equal(rst.scheduled, true);
    assert.equal(restarts, 1);

    const httpResume = handleAdminApi(url('/api/admin/resume'), 'POST', {}, {
      admin, ops: pool.adminOps, loopback: true,
    });
    assert.equal(httpResume.status, 404);
    assert.equal(pool.paused, true);
    pool.adminOps.setPaused(false);
    assert.equal(pool.paused, false);
    pool.close();
  });
});
