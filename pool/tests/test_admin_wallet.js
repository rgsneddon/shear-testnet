import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { NANOS_PER_SHE, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import { reconstructOwner } from '../src/wallet_api.js';
import { destOpeningFromView } from '../../crypto/address.js';
import { levyNanos, poolFeeDest, containsShe1 } from '../../crypto/levy.js';
import { signPoolWithdraw, poolWithdrawDigest } from '../../crypto/eip712.js';
import { sign } from 'node:crypto';
import { withdrawNonces, withdrawDigests } from '../src/withdraw_state.js';
import {
  ADMIN_HOST_EXAMPLE,
  ADMIN_USER,
  ADMIN_DIR,
  createAdmin,
  handleAdminApi,
  totpCode,
  isAdminHost,
  adminWalletDests,
  adminWalletBalance,
} from '../src/admin.js';
import { createPullBook, potCreditNanos } from '../src/pull_book.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADMIN_HOST = 'admin.mypool.site';

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
    assert.deepEqual(labels, ['MAIN', 'POOL', 'EXPLORER', 'MEMPOOL', 'MINER', 'NODE', 'WALLET', 'DOCS']);
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

  it('third-party desk is /admin when SHEAR_ADMIN_HOST is unset', () => {
    const prev = process.env.SHEAR_ADMIN_HOST;
    delete process.env.SHEAR_ADMIN_HOST;
    try {
      assert.equal(isAdminHost('mypool.site'), false);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-3p-admin-'));
      const admin = createAdmin(dir);
      const setup = handleAdminApi(new URL('https://mypool.site/api/admin/setup'), 'POST', {
        user: 'operator', password: 'aaaaaaaa',
      }, { admin, host: 'mypool.site' });
      assert.equal(setup.json.ok, true, setup.json.reason);
      const poolSrc = fs.readFileSync(path.join(root, 'pool/src/pool.js'), 'utf8');
      assert.match(poolSrc, /url\.pathname === '\/admin'/);
      const ngx = fs.readFileSync(path.join(root, 'pool/deploy/nginx-mypool.site.conf'), 'utf8');
      assert.match(ngx, /location = \/admin/);
      assert.match(ngx, /proxy_pass http:\/\/127\.0\.0\.1:8088\/admin/);
    } finally {
      if (prev == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prev;
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
    const run = (p, method, body, cookie, extra = {}) => handleAdminApi(url(p), method, body, {
      store, admin, cookie, queueSend: (t) => {
        posted.push(t);
        return { id: 'w1', ...t };
      },
      ...extra,
    });

    const prevHost = process.env.SHEAR_ADMIN_HOST;
    process.env.SHEAR_ADMIN_HOST = ADMIN_HOST;
    assert.equal(admin.status().setup, false);
    const stranger = run('/api/admin/setup', 'POST', { user: 'not-it', password: 'aaaaaaaa' }, '', { host: 'pool.shear.digital' });
    assert.equal(stranger.json.ok, false);
    assert.equal(stranger.json.reason, 'setup_forbidden');
    assert.equal(admin.status().setup, false);

    const created = run('/api/admin/setup', 'POST', {
      user: 'operator', password: 'aaaaaaaa', setupToken: admin.setupToken,
    });
    assert.doesNotMatch(fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8'), /if \(!same\(user, ADMIN_USER\)\)/);
    assert.match(fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8'), /issuer=\$\{encodeURIComponent\(iss\)\}/);
    assert.match(fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8'), /ADMIN_ISSUER = 'shear'/);
    assert.equal(created.json.ok, true, created.json.reason);
    const cookie = cookieOf(created.headers);
    assert.ok(cookie);
    const again = run('/api/admin/setup', 'POST', { user: ADMIN_USER, password: 'bbbbbbbb' });
    assert.equal(again.json.reason, 'closed');

    const wallet = run('/api/admin/wallet', 'GET', {}, cookie);
    assert.equal(wallet.json.ok, true);
    assert.equal(wallet.json.spendable, 1);
    assert.ok(adminWalletDests('').includes(from));

    const leak = run('/api/admin/withdraw', 'POST', { to: id.paymentCode, amount }, cookie);
    assert.equal(leak.json.ok, false);
    assert.equal(leak.json.reason === 'she1_on_chain' || leak.json.reason === 'she1', true);

    const unsigned = run('/api/admin/withdraw', 'POST', {
      to: dest, amount, login: id.paymentCode,
    }, cookie);
    assert.equal(unsigned.json.ok, false);
    assert.equal(unsigned.json.reason, 'unsigned');
    assert.equal(unsigned.json.pending.kind, 'admin-spendable');
    assert.equal(posted.length, 0);

    withdrawNonces.clear();
    withdrawDigests.clear();
    const sig = signPoolWithdraw({
      seed: id.spendPub,
      login: id.paymentCode,
      dest,
      nanos,
    });
    const open = destOpeningFromView(id.viewKey, id.spendPub, 0);
    const digest = poolWithdrawDigest({
      login: id.paymentCode, dest, minerShe1: id.paymentCode, payoutSsa1: dest, nanos,
    });
    const spendSig = sign(null, digest, id.privateKey).toString('hex');
    const sent = run('/api/admin/withdraw', 'POST', {
      to: dest,
      amount,
      login: id.paymentCode,
      sig,
      open,
      spendSig,
    }, cookie);
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

    const noCode = run('/api/admin/login', 'POST', { user: 'operator', password: 'aaaaaaaa' });
    assert.equal(noCode.json.ok, false);
    const wrongUser = run('/api/admin/login', 'POST', {
      user: 'not-the-op', password: 'aaaaaaaa', code: totpCode(pending),
    });
    assert.equal(wrongUser.json.ok, false);
    const withCode = run('/api/admin/login', 'POST', {
      user: 'operator', password: 'aaaaaaaa', code: totpCode(pending),
    });
    assert.equal(withCode.json.ok, true);
    if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
    else process.env.SHEAR_ADMIN_HOST = prevHost;
  });

  it('admin spendable reconstructs custody pots on the pool dest, not only the 1% fee dest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-pot-'));
    const admin = createAdmin(dir);
    const poolId = newIdentity();
    const hasherId = newIdentity();
    const poolDest = destForLogin(poolId.address, { viewKey: poolId.viewKey, height: 1 });
    const hasher = destForLogin(hasherId.address, { viewKey: hasherId.viewKey, height: 1 });
    const want = noteCommitOfDest20(hash20FromAddress(poolDest));
    const store = {
      blocks: [{
        height: 2,
        miner: hasher,
        aLeaves: [{ noteCommit: Buffer.alloc(32, 3), count: 256 }],
        txs: [{
          coinbase: true,
          vout: [
            { kind: 'pot', noteCommit: want, nanos: 0 },
            { kind: 'hash', noteCommit: want, nanos: 0 },
          ],
        }],
      }],
      tip: () => ({ height: 2 + SPENDABLE_CONFIRMATIONS }),
      mempool: [],
    };
    const rec = reconstructOwner(store, poolDest);
    const pot = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * 0.01);
    assert.equal(rec.spendableNanos, pot + 256);
    const prevHost = process.env.SHEAR_ADMIN_HOST;
    process.env.SHEAR_ADMIN_HOST = ADMIN_HOST;
    try {
      const created = handleAdminApi(url('/api/admin/setup'), 'POST', {
        user: 'operator', password: 'aaaaaaaa', setupToken: admin.setupToken,
      }, { store, admin, cookie: '', host: ADMIN_HOST });
      assert.equal(created.json.ok, true, created.json.reason);
      const cookie = cookieOf(created.headers);
      const wallet = handleAdminApi(url('/api/admin/wallet'), 'GET', {}, {
        store, admin, cookie, host: ADMIN_HOST, poolDest,
      });
      assert.equal(wallet.json.ok, true);
      assert.ok(wallet.json.spendableNanos >= 0);
      assert.equal(wallet.json.spendable < 0.02, true);
      assert.ok(wallet.json.custodyDisplay);
    } finally {
      if (prevHost == null) delete process.env.SHEAR_ADMIN_HOST;
      else process.env.SHEAR_ADMIN_HOST = prevHost;
    }
  });

  it('admin may withdraw only the fee dest; unpaid miner credits are reserved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admin-split-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const book = createPullBook(dir);
    const pot = potCreditNanos();
    assert.equal(book.creditRound([{ tag: 'mabcdef12', dest, count: 10 }], { height: 5, nanos: pot }).ok, true);
    const fee = poolFeeDest();
    const store = {
      historyFor: (addr) => (addr === fee ? [{
        id: 'fee-1', from: 'coinbase', to: fee, nanos: NANOS_PER_SHE, height: 10, kind: 'pool-fee',
      }] : []),
      tip: () => ({ height: 20 }),
      mempool: [],
    };
    const bal = adminWalletBalance(store, dest, book);
    assert.equal(bal.spendable, 1);
    assert.equal(bal.minerReservedNanos, pot);
    assert.ok(bal.minerReserved > 0.9);
    assert.ok(bal.minerReserved < 1);
  });
});
