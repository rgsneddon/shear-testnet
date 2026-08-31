import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { levyNanos, poolFeeDest, containsShe1 } from '../../crypto/levy.js';
import {
  ADMIN_HOST,
  ADMIN_USER,
  ADMIN_DIR,
  createAdmin,
  handleAdminApi,
  totpCode,
  isAdminHost,
} from '../src/admin.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function url(p) {
  return new URL(`https://${ADMIN_HOST}${p}`);
}

function cookieOf(headers) {
  const raw = String(headers?.['Set-Cookie'] || '');
  const m = raw.match(/shear_admin=([0-9a-f]+)/);
  return m ? `shear_admin=${m[1]}` : '';
}

function tokenOf(cookie) {
  return String(cookie || '').replace(/^shear_admin=/, '');
}

describe('kyrusfables admin fee wallet', () => {
  it('is host-gated, not in the public site tree, and robots-disallowed', () => {
    assert.equal(isAdminHost(ADMIN_HOST), true);
    assert.equal(isAdminHost('pool.shear.digital'), false);
    assert.equal(isAdminHost('shear.digital'), false);
    const html = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
    assert.match(html, /noindex/);
    assert.doesNotMatch(html, new RegExp(ADMIN_USER));
    assert.match(html, /Spendable/);
    assert.match(html, /Flow/);
    assert.doesNotMatch(html, /hashrate|stratum|explorer|mempool/i);
    const robots = fs.readFileSync(path.join(ADMIN_DIR, 'robots.txt'), 'utf8');
    assert.match(robots, /Disallow: \//);
    const nginx = fs.readFileSync(path.join(root, 'deploy/nginx-kyrusfables.shear.digital.conf'), 'utf8');
    assert.match(nginx, /server_name kyrusfables\.shear\.digital/);
    assert.match(nginx, /X-Robots-Tag/);
    assert.doesNotMatch(nginx, /\/api\/stats/);
    for (const rel of ['site/index.html', 'pool/public/index.html', 'pool/public/miner.html', 'pool/public/explorer.html']) {
      const pub = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.doesNotMatch(pub, /kyrusfables/);
    }
  });

  it('only the intended operator can create access; after 2FA the door stays closed; withdraw pays network L', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-'));
    const admin = createAdmin(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const from = poolFeeDest();
    const amount = 0.05;
    const nanos = Math.round(amount * NANOS_PER_SHE);
    const fee = levyNanos(nanos);
    const store = {
      historyFor: (addr) => (addr === from ? [{
        id: 'fee-1', from: 'coinbase', to: from, nanos: NANOS_PER_SHE, height: 10, kind: 'pool-fee',
      }] : []),
      tip: () => ({ height: 20 }),
      mempool: [],
    };
    const posted = [];
    const run = (p, method, body, cookie) => handleAdminApi(url(p), method, body, {
      store, admin, cookie, queueSend: (t) => {
        posted.push(t);
        return { id: 'w1', ...t };
      },
    });

    assert.equal(admin.status().setup, false);
    const stranger = run('/api/admin/setup', 'POST', { user: 'not-it', password: 'aaaaaaaa' });
    assert.equal(stranger.json.ok, false);
    assert.equal(stranger.json.reason, 'auth');
    assert.equal(admin.status().setup, false);

    const created = run('/api/admin/setup', 'POST', { user: ADMIN_USER, password: 'aaaaaaaa' });
    assert.equal(created.json.ok, true, created.json.reason);
    const cookie = cookieOf(created.headers);
    assert.ok(cookie);
    const again = run('/api/admin/setup', 'POST', { user: ADMIN_USER, password: 'bbbbbbbb' });
    assert.equal(again.json.reason, 'closed');

    const wallet = run('/api/admin/wallet', 'GET', {}, cookie);
    assert.equal(wallet.json.ok, true);
    assert.equal(wallet.json.spendable, 1);

    const leak = run('/api/admin/withdraw', 'POST', { to: id.paymentCode, amount }, cookie);
    assert.equal(leak.json.ok, false);

    const sent = run('/api/admin/withdraw', 'POST', { to: dest, amount }, cookie);
    assert.equal(sent.json.ok, true, sent.json.reason);
    assert.equal(sent.json.levy, fee);
    assert.equal(posted[0].fee, fee);
    assert.equal(posted[0].kind, 'send');
    assert.equal(containsShe1(posted[0]), false);
    assert.equal(JSON.stringify(posted[0]).includes('she1'), false);

    const start = run('/api/admin/totp/start', 'POST', {}, cookie);
    assert.equal(start.json.ok, true);
    const pending = admin.sessionOf(tokenOf(cookie)).totpPending;
    const code = totpCode(pending);
    const confirm = run('/api/admin/totp/confirm', 'POST', { code }, cookie);
    assert.equal(confirm.json.ok, true);
    assert.equal(admin.status().closed, true);
    assert.equal(admin.status().totp, true);

    const noCode = run('/api/admin/login', 'POST', { user: ADMIN_USER, password: 'aaaaaaaa' });
    assert.equal(noCode.json.ok, false);
    const withCode = run('/api/admin/login', 'POST', {
      user: ADMIN_USER, password: 'aaaaaaaa', code: totpCode(pending),
    });
    assert.equal(withCode.json.ok, true);
  });
});
