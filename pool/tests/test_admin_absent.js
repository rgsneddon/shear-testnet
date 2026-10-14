import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createAdmin, handleAdminApi, handleAdminHttp } from '../src/admin.js';

const routes = [
  ['GET', '/admin'],
  ['GET', '/admin/'],
  ['GET', '/admin/index.html'],
  ['GET', '/admin/robots.txt'],
  ['POST', '/api/admin/setup'],
  ['POST', '/api/admin/login'],
  ['GET', '/api/admin/wallet'],
  ['POST', '/api/admin/withdraw'],
  ['POST', '/api/admin/totp/start'],
  ['GET', '/api/admin/status'],
  ['POST', '/admin/api/admin/setup'],
];

function httpReq(method, route) {
  const req = Readable.from([Buffer.from(JSON.stringify({
    user: 'operator',
    password: 'aaaaaaaa',
    allowSetup: true,
    setupToken: 'not-a-token',
    amount: 1,
    to: 'ssa1q',
  }))]);
  req.method = method;
  req.url = route;
  req.headers = { host: 'kyrusfables.shear.digital', 'content-type': 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function httpRes() {
  const headers = {};
  let raw = '';
  return {
    statusCode: 0,
    headers,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    end(s) { raw = String(s || ''); },
    body() { return raw; },
  };
}

describe('pool web admin is absent', () => {
  it('page, setup, and every /api/admin route refuse on any host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-absent-'));
    const admin = createAdmin(dir);
    const prevSetup = process.env.SHEAR_ADMIN_SETUP;
    const prevHost = process.env.SHEAR_ADMIN_HOST;
    process.env.SHEAR_ADMIN_SETUP = '1';
    process.env.SHEAR_ADMIN_HOST = 'kyrusfables.shear.digital';
    try {
      assert.equal(admin.status().setup, false);
      for (const [method, route] of routes) {
        const res = httpRes();
        await handleAdminHttp(httpReq(method, route), res, { admin, loopback: true, host: '127.0.0.1' });
        const json = JSON.parse(res.body());
        assert.equal(res.statusCode, 404, route);
        assert.equal(json.ok, false, route);
        assert.equal(json.reason, 'admin_absent', route);
        assert.equal(res.body().includes('<html'), false, route);
        assert.equal(admin.status().setup, false, route);
        const api = handleAdminApi(new URL(`https://pool.shear.digital${route}`), method, {
          user: 'operator', password: 'aaaaaaaa', allowSetup: true, setupToken: admin.setupToken,
        }, { admin, loopback: true, host: '127.0.0.1' });
        assert.equal(api.status, 404, route);
        assert.equal(api.json.reason, 'admin_absent', route);
      }
      assert.equal(admin.status().setup, false);
      assert.equal(fs.existsSync(path.join(dir, 'admin-audit.jsonl')), false);
    } finally {
      if (prevSetup == null) delete process.env.SHEAR_ADMIN_SETUP;
      else process.env.SHEAR_ADMIN_SETUP = prevSetup;
      if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prevHost;
    }
  });

  it('the public server does not treat a host name as the admin desk', () => {
    const poolSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pool.js'), 'utf8');
    assert.match(poolSrc, /url\.pathname === '\/admin'/);
    assert.match(poolSrc, /url\.pathname\.startsWith\('\/api\/admin'\)/);
    assert.doesNotMatch(poolSrc, /isAdminHost\(/);
  });
});
