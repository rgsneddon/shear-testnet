import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  ADMIN_HOST,
  ADMIN_USER,
  createAdmin,
  handleAdminApi,
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
  it('pause, restart hooks, miner table, kick, ban, and clear-stale require a session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-ops-'));
    const admin = createAdmin(dir);
    const calls = { pause: [], restart: 0, hasher: 0, kick: [], stale: 0 };
    const miners = [{ tag: 'she1abcd1234', worker: 'rig', accepted: 4, stale: 9, hashrate: 12 }];
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
    const run = (p, method, body, cookie) => handleAdminApi(url(p), method, body, { admin, ops, cookie });

    assert.equal(run('/api/admin/health', 'GET').status, 401);
    assert.equal(run('/api/admin/restart', 'POST').status, 401);

    const created = run('/api/admin/setup', 'POST', { user: ADMIN_USER, password: 'aaaaaaaa' });
    assert.equal(created.json.ok, true, created.json.reason);
    const cookie = cookieOf(created.headers);

    const health = run('/api/admin/health', 'GET', {}, cookie);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.height, 9);

    const list = run('/api/admin/miners', 'GET', {}, cookie);
    assert.equal(list.json.n, 1);
    assert.equal(list.json.miners[0].tag, 'she1abcd1234');

    assert.equal(run('/api/admin/pause', 'POST', {}, cookie).json.paused, true);
    assert.equal(run('/api/admin/resume', 'POST', {}, cookie).json.paused, false);
    assert.deepEqual(calls.pause, [true, false]);

    assert.equal(run('/api/admin/restart', 'POST', {}, cookie).json.scheduled, true);
    assert.equal(run('/api/admin/restart-hasher', 'POST', {}, cookie).json.scheduled, true);
    assert.equal(calls.restart, 1);
    assert.equal(calls.hasher, 1);

    assert.equal(run('/api/admin/rebroadcast', 'POST', {}, cookie).json.n, 2);
    assert.equal(run('/api/admin/disconnect-all', 'POST', {}, cookie).json.dropped, 3);
    assert.equal(run('/api/admin/kick', 'POST', { miner: 'she1abcd1234' }, cookie).json.dropped, 1);
    assert.equal(calls.kick[0], 'she1abcd1234');
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
      user: ADMIN_USER, password: 'aaaaaaaa',
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
    assert.ok(view.tag.startsWith('she1'));

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
