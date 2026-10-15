import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { NANOS_PER_SHE, POOL_FEE_BPS, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { sealCoinbaseNote } from '../../crypto/note.js';
import { reconstructOwner } from '../src/wallet_api.js';
import { levyNanos } from '../../crypto/levy.js';
import { configuredFeeIdentity } from '../src/posture.js';
import {
  ADMIN_HOST_EXAMPLE,
  ADMIN_USER,
  ADMIN_DIR,
  createAdmin,
  handleAdminApi,
  isAdminHost,
  adminWalletDests,
  adminWalletBalance,
} from '../src/admin.js';
import { createPullBook, potCreditNanos } from '../src/pull_book.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADMIN_HOST = 'admin.mypool.site';

/** Mature pool-fee note. An explorer row alone is fail-closed once notes exist. */
function feeNoteStore(feeDest) {
  return {
    blocks: [{
      height: 10,
      hash: Buffer.alloc(32, 0x11),
      miner: feeDest,
      txs: [{
        coinbase: true,
        vout: [
          sealCoinbaseNote(NANOS_PER_SHE, { dest20: hash20FromAddress(feeDest), kind: 'pool-fee' }),
        ],
      }],
    }],
    historyFor: (addr) => (addr === feeDest ? [{
      id: 'fee-1', from: 'coinbase', to: feeDest, nanos: NANOS_PER_SHE, height: 10, kind: 'pool-fee',
    }] : []),
    tip: () => ({ height: 20 }),
    mempool: [],
  };
}

function url(p) {
  return new URL(`https://${ADMIN_HOST}${p}`);
}

describe('operator admin fee wallet', () => {
  it('is host-gated, not in the public site tree, and robots-disallowed', () => {
    const prev = process.env.SHEAR_ADMIN_HOST;
    process.env.SHEAR_ADMIN_HOST = ADMIN_HOST;
    try {
      assert.equal(isAdminHost(ADMIN_HOST), true);
      assert.equal(isAdminHost('pool.shear.digital'), false);
      assert.equal(isAdminHost('shear.digital'), false);
      assert.equal(isAdminHost(ADMIN_HOST_EXAMPLE), false);
    } finally {
      if (prev == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prev;
    }
    const html = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
    const nav = html.match(/id="shear-nav"[\s\S]*?<\/nav>/);
    assert.ok(nav, 'admin must ship the site navbar');
    const labels = [...nav[0].matchAll(/class="nav-btn[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
    assert.deepEqual(labels, ['MAIN', 'POOL', 'EXPLORER', 'MEMPOOL', 'DAG', 'MINER', 'NODE', 'WALLET', 'VORTICES', 'DOCS']);
    assert.equal(labels.includes('OSAdmin'), false);
    assert.match(html, /theme\.js\?v=15/);
    assert.match(html, /flagShearOsadmin\(true\)/);
    assert.match(html, /flagShearOsadmin\(false\)/);
    assert.match(html, /noindex/);
    assert.doesNotMatch(html, /raskul/);
    assert.match(html, /Admin may withdraw/);
    assert.match(html, /Miner rewards unpaid/);
    assert.match(html, /bal-miners/);
    assert.match(html, /minerReservedDisplay/);
    assert.match(html, /Withdraw/);
    assert.match(html, /Username/);
    assert.match(html, /Confirm password/);
    assert.match(html, /Enable 2FA/);
    assert.doesNotMatch(html, /2044/);
    assert.doesNotMatch(html, /neon-lock/);
    assert.match(html, /Request wallet signature/);
    assert.match(html, /theme-toggle/);
    assert.match(html, /data-theme/);
    assert.match(html, /setInterval\(paintLive/);
    assert.match(html, /Restart pool/);
    assert.match(html, /Pause/);
    assert.match(html, /Resume/);
    assert.match(html, /json\.reason/);
    assert.match(html, /input::placeholder \{ color:var\(--muted\)/);
    assert.match(html, /color:var\(--ink\)/);
    assert.doesNotMatch(html, /\/api\/mempool/i);
    const robots = fs.readFileSync(path.join(ADMIN_DIR, 'robots.txt'), 'utf8');
    assert.match(robots, /Disallow: \//);
    const nginx = fs.readFileSync(path.join(root, 'pool/deploy/nginx-mypool.site.conf'), 'utf8');
    assert.match(nginx, /server_name mypool\.site/);
    assert.match(nginx, /location = \/admin/);
    assert.match(nginx, /X-Robots-Tag/);
    assert.doesNotMatch(nginx, /\/api\/stats/);
    const adminSrc = fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8');
    assert.doesNotMatch(adminSrc, /kyrusfables/);
    assert.match(adminSrc, /adminWalletDests/);
    assert.match(adminSrc, /adminWalletBalance/);
    for (const rel of ['site/index.html', 'pool/public/index.html', 'pool/public/miner.html', 'pool/public/explorer.html', 'pool/src/admin.js', 'pool/src/pool.js']) {
      const pub = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.doesNotMatch(pub, /kyrusfables/);
    }
  });

  it('third-party desk is /admin; first-run is setup_forbidden when SHEAR_ADMIN_HOST is unset', () => {
    const prev = process.env.SHEAR_ADMIN_HOST;
    const prevSetup = process.env.SHEAR_ADMIN_SETUP;
    delete process.env.SHEAR_ADMIN_HOST;
    delete process.env.SHEAR_ADMIN_SETUP;
    try {
      assert.equal(isAdminHost('mypool.site'), false);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-3p-admin-'));
      const admin = createAdmin(dir);
      const setup = handleAdminApi(new URL('https://mypool.site/api/admin/setup'), 'POST', {
        user: 'operator', password: 'aaaaaaaa',
      }, { admin, host: 'mypool.site', loopback: true });
      assert.equal(setup.status, 404);
      assert.equal(setup.json.ok, false);
      assert.equal(setup.json.reason, 'admin_absent');
      assert.equal(admin.status().setup, false);
      const token = handleAdminApi(new URL('https://mypool.site/api/admin/setup'), 'POST', {
        user: 'operator', password: 'aaaaaaaa', setupToken: admin.setupToken, allowSetup: true,
      }, { admin, host: 'mypool.site', loopback: true });
      assert.equal(token.status, 404);
      assert.equal(token.json.reason, 'admin_absent');
      assert.equal(admin.status().setup, false);
      const poolSrc = fs.readFileSync(path.join(root, 'pool/src/pool.js'), 'utf8');
      assert.match(poolSrc, /url\.pathname === '\/admin'/);
      const ngx = fs.readFileSync(path.join(root, 'pool/deploy/nginx-mypool.site.conf'), 'utf8');
      assert.match(ngx, /location = \/admin/);
      assert.match(ngx, /proxy_pass http:\/\/127\.0\.0\.1:8088\/admin/);
    } finally {
      if (prev == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prev;
      if (prevSetup == null) delete process.env.SHEAR_ADMIN_SETUP;
      else process.env.SHEAR_ADMIN_SETUP = prevSetup;
    }
  });

  it('only the intended operator can create access; after 2FA the door stays closed; withdraw pays network L', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-'));
    const admin = createAdmin(dir);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const from = configuredFeeIdentity().feeDest;
    const amount = 0.05;
    const nanos = Math.round(amount * NANOS_PER_SHE);
    const fee = levyNanos(nanos);
    const store = feeNoteStore(from);
    const posted = [];
    const run = (p, method, body, cookie, extra = {}) => handleAdminApi(url(p), method, body, {
      store, admin, cookie, queueSend: (t) => {
        posted.push(t);
        return { id: 'w1', ...t };
      },
      ...extra,
    });

    const prevHost = process.env.SHEAR_ADMIN_HOST;
    process.env.SHEAR_ADMIN_HOST = ADMIN_HOST;
    try {
      assert.equal(admin.status().setup, false);
      const adminSrc = fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8');
      assert.doesNotMatch(adminSrc, /if \(!same\(user, ADMIN_USER\)\)/);
      assert.match(adminSrc, /issuer=\$\{encodeURIComponent\(iss\)\}/);
      assert.match(adminSrc, /ADMIN_ISSUER = 'shear'/);
      assert.ok(adminWalletDests('').includes(from));
      const routes = [
        ['/api/admin/setup', 'POST', { user: 'not-it', password: 'aaaaaaaa' }],
        ['/api/admin/setup', 'POST', { user: 'operator', password: 'aaaaaaaa', setupToken: admin.setupToken, allowSetup: true }],
        ['/api/admin/setup', 'POST', { user: ADMIN_USER, password: 'bbbbbbbb' }],
        ['/api/admin/wallet', 'GET', {}],
        ['/api/admin/withdraw', 'POST', { to: id.paymentCode, amount }],
        ['/api/admin/withdraw', 'POST', { to: dest, amount, login: id.paymentCode }],
        ['/api/admin/totp/start', 'POST', {}],
        ['/api/admin/totp/confirm', 'POST', { code: '000000' }],
        ['/api/admin/login', 'POST', { user: 'operator', password: 'aaaaaaaa' }],
      ];
      for (const [p, method, body] of routes) {
        const got = run(p, method, body, 'shear_admin=deadbeef', { host: ADMIN_HOST, loopback: true });
        assert.equal(got.status, 404, p);
        assert.equal(got.json.ok, false, p);
        assert.equal(got.json.reason, 'admin_absent', p);
        assert.equal(got.json.spendable, undefined, p);
      }
      assert.equal(admin.status().setup, false);
      assert.equal(admin.status().closed, false);
      assert.equal(posted.length, 0);
      assert.equal(fee > 0, true);
      assert.equal(nanos > 0, true);
    } finally {
      if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prevHost;
    }
  });

  it('admin spendable reconstructs custody pots on the pool dest, not only the 1% fee dest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-pot-'));
    const admin = createAdmin(dir);
    const poolId = newIdentity();
    const hasherId = newIdentity();
    const poolDest = destForLogin(poolId.address, { viewKey: poolId.viewKey, height: 1 });
    const hasher = destForLogin(hasherId.address, { viewKey: hasherId.viewKey, height: 1 });
    const rest = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const fee = Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const feeDest = configuredFeeIdentity().feeDest;
    const store = {
      blocks: [{
        height: 2,
        hash: Buffer.alloc(32, 0x63),
        miner: poolDest,
        poolDest,
        shareBatch: [{
          dest: hasher,
          dest20: hash20FromAddress(hasher),
          nonce: 1n,
          lz: 8,
        }],
        txs: [{
          coinbase: true,
          vout: [
            sealCoinbaseNote(rest, { dest20: hash20FromAddress(poolDest), kind: 'pot' }),
            sealCoinbaseNote(fee, { dest20: hash20FromAddress(feeDest), kind: 'pool-fee' }),
          ],
        }],
      }],
      tip: () => ({ height: 2 + SPENDABLE_CONFIRMATIONS }),
      mempool: [],
    };
    const rec = reconstructOwner(store, poolDest);
    assert.equal(rec.spendableNanos, rest);
    assert.equal(reconstructOwner(store, hasher).spendableNanos, 0);
    const prevHost = process.env.SHEAR_ADMIN_HOST;
    process.env.SHEAR_ADMIN_HOST = ADMIN_HOST;
    try {
      const created = handleAdminApi(url('/api/admin/setup'), 'POST', {
        user: 'operator', password: 'aaaaaaaa', setupToken: admin.setupToken, allowSetup: true,
      }, { store, admin, cookie: '', host: ADMIN_HOST, loopback: true, poolDest });
      assert.equal(created.status, 404);
      assert.equal(created.json.reason, 'admin_absent');
      assert.equal(admin.status().setup, false);
      const wallet = handleAdminApi(url('/api/admin/wallet'), 'GET', {}, {
        store, admin, cookie: 'shear_admin=deadbeef', host: ADMIN_HOST, loopback: true, poolDest,
      });
      assert.equal(wallet.status, 404);
      assert.equal(wallet.json.reason, 'admin_absent');
      assert.equal(wallet.json.spendable, undefined);
      assert.equal(wallet.json.spendableNanos, undefined);
      assert.equal(wallet.json.custodyDisplay, undefined);
    } finally {
      if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prevHost;
    }
  });

  it('a refused pull credit reserves nothing, and a plaintext fee row is not spendable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-split-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const book = createPullBook(dir);
    const pot = potCreditNanos();
    const credited = book.creditRound([{ tag: 'mabcdef12', dest, count: 10 }], { height: 5, nanos: pot });
    assert.equal(credited.ok, false);
    assert.equal(credited.reason, 'custodial_pull');
    const fee = configuredFeeIdentity().feeDest;
    const store = feeNoteStore(fee);
    const bal = adminWalletBalance(store, dest, book);
    assert.equal(bal.spendableNanos, 0);
    assert.equal(bal.spendable, 0);
    assert.equal(bal.minerReservedNanos, 0);
    assert.equal(bal.minerReserved, 0);
  });
});
