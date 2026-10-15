import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/pool.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

function walkConf(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walkConf(full, acc);
    else if (name.endsWith('.conf')) acc.push(full);
  }
  return acc;
}

describe('pool web admin is absent', () => {
  it('no admin static dir, module, or nginx vhost remains', () => {
    assert.equal(fs.existsSync(path.join(root, 'pool/admin')), false);
    assert.equal(fs.existsSync(path.join(root, 'site/admin')), false);
    assert.equal(fs.existsSync(path.join(root, 'pool/src/admin.js')), false);
    assert.equal(fs.existsSync(path.join(root, 'deploy/nginx-admin.shear.digital.conf')), false);
    const confs = [
      ...walkConf(path.join(root, 'deploy')),
      ...walkConf(path.join(root, 'pool/deploy')),
    ];
    assert.ok(confs.length > 0);
    for (const file of confs) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(root, file);
      assert.doesNotMatch(text, /admin\.shear\.digital/, rel);
      assert.doesNotMatch(text, /location\s*=\s*\/admin\b/, rel);
      assert.doesNotMatch(text, /location\s+\/admin\//, rel);
      assert.doesNotMatch(text, /location\s+\/api\/admin\//, rel);
      assert.doesNotMatch(text, /proxy_pass\s+http:\/\/127\.0\.0\.1:8088\/admin/, rel);
    }
    const units = [
      'deploy/shear-pool.service',
      'deploy/shear-pool-v4.service',
      'pool/deploy/shear-pool.service',
    ];
    for (const rel of units) {
      const unit = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.doesNotMatch(unit, /SHEAR_ADMIN_HOST/, rel);
      assert.doesNotMatch(unit, /SHEAR_ADMIN_SETUP/, rel);
    }
  });

  it('pool source has no admin route, import, or admin host config', () => {
    const poolSrc = fs.readFileSync(path.join(root, 'pool/src/pool.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(root, 'pool/src/main.js'), 'utf8');
    assert.doesNotMatch(poolSrc, /from '\.\/admin\.js'/);
    assert.doesNotMatch(poolSrc, /createAdmin\(/);
    assert.doesNotMatch(poolSrc, /handleAdminHttp\(/);
    assert.doesNotMatch(poolSrc, /url\.pathname === '\/admin'/);
    assert.doesNotMatch(poolSrc, /url\.pathname\.startsWith\('\/admin\/'\)/);
    assert.doesNotMatch(poolSrc, /url\.pathname\.startsWith\('\/api\/admin'\)/);
    assert.doesNotMatch(poolSrc, /SHEAR_ADMIN_HOST/);
    assert.doesNotMatch(poolSrc, /SHEAR_ADMIN_SETUP/);
    assert.doesNotMatch(mainSrc, /createAdmin\(/);
    assert.doesNotMatch(mainSrc, /SHEAR_ADMIN_HOST/);
    assert.doesNotMatch(mainSrc, /SHEAR_ADMIN_SETUP/);
    assert.match(poolSrc, /runAutoPayoutSweep/);
    assert.match(mainSrc, /operatorSpendKey/);
    const themes = [
      'brand/theme.js',
      'team/brand/theme.js',
      'pool/public/brand/theme.js',
      'site/brand/theme.js',
      'site/boot/brand/theme.js',
      'mempool/brand/theme.js',
      'explorer/brand/theme.js',
    ];
    for (const rel of themes) {
      const theme = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.doesNotMatch(theme, /osadminHref/, rel);
      assert.doesNotMatch(theme, /shear_osadmin/, rel);
      assert.doesNotMatch(theme, /nav-osadmin/, rel);
      assert.doesNotMatch(theme, /flagShearOsadmin/, rel);
    }
  });

  it('the pool starts with no admin config and does not serve /admin', async () => {
    const prevHost = process.env.SHEAR_ADMIN_HOST;
    const prevSetup = process.env.SHEAR_ADMIN_SETUP;
    delete process.env.SHEAR_ADMIN_HOST;
    delete process.env.SHEAR_ADMIN_SETUP;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-absent-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0 });
    try {
      assert.equal(pool.admin, undefined);
      assert.equal(typeof pool.runAutoPayoutSweep, 'function');
      assert.equal(typeof pool.adminOps.health, 'function');
      const heard = await pool.listen();
      assert.ok(heard.httpPort > 0);
      for (const [method, route] of routes) {
        const res = await fetch(`http://127.0.0.1:${heard.httpPort}${route}`, {
          method,
          headers: { 'content-type': 'application/json', host: 'pool.example' },
          body: method === 'GET' ? undefined : JSON.stringify({
            user: 'operator',
            password: 'aaaaaaaa',
            allowSetup: true,
            amount: 1,
          }),
        });
        const text = await res.text();
        assert.equal(res.status, 404, route);
        assert.equal(text.includes('<html'), false, route);
        assert.equal(text.includes('spendable'), false, route);
        assert.equal(text.includes('setupToken'), false, route);
      }
      assert.equal(fs.existsSync(path.join(dir, 'admin.enc')), false);
      assert.equal(fs.existsSync(path.join(dir, 'admin.key')), false);
      assert.equal(fs.existsSync(path.join(dir, 'admin-audit.jsonl')), false);
      const stats = await fetch(`http://127.0.0.1:${heard.httpPort}/api/stats`).then((r) => r.json());
      assert.equal(stats.ok, true);
    } finally {
      pool.close();
      if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prevHost;
      if (prevSetup == null) delete process.env.SHEAR_ADMIN_SETUP;
      else process.env.SHEAR_ADMIN_SETUP = prevSetup;
    }
  });
});
