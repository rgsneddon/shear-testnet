import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign as signEd } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  gateStratumLogin,
  makeLoginChallenge,
  verifyStratumLoginAuth,
  foldPublicMinerViews,
  statsAlerts,
  noteIpSubmit,
  rememberDestShareBits,
  destShareBitsOf,
  loadDestShareBitsMap,
  persistDestShareBitsMap,
  rememberOpenShare,
  publicHtmlFile,
  isExplorerHost,
  SUBMIT_PER_IP_MAX,
  createPool,
} from '../src/pool.js';
import { totpKeyUri, createAdmin, handleAdminApi, totpCode, appendAdminAudit } from '../src/admin.js';
import { qrModules, qrSvg } from '../src/totp_qr.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function destOf() {
  const id = newIdentity();
  return destForLogin(id.address, { height: 1, viewKey: id.viewKey });
}

describe('A1 stratum auth gate', () => {
  it('auth on rejects dest-only; auth off accepts dest-only', () => {
    const dest = destOf();
    const params = { login: dest, client: 'ShearHash', version: '2.4' };
    const off = gateStratumLogin(params, { requireLoginAuth: false });
    assert.equal(off.ok, true);
    const on = gateStratumLogin(params, { requireLoginAuth: true });
    assert.equal(on.ok, false);
    assert.equal(on.reason, 'need_auth');
    assert.equal(typeof on.challenge, 'string');
  });

  it('signed ed25519 login passes when auth is on', () => {
    const dest = destOf();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const chal = makeLoginChallenge();
    const msg = Buffer.from(`shear-stratum-login-v1:${chal}:${dest}`);
    const sig = signEd(null, msg, privateKey);
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const pub = spki.subarray(spki.length - 32).toString('hex');
    const ok = verifyStratumLoginAuth({ dest, challenge: chal, sig: sig.toString('hex'), pub });
    assert.equal(ok, true);
    const gated = gateStratumLogin({
      login: dest, client: 'ShearHash', version: '2.4',
      challenge: chal, authSig: sig.toString('hex'), authPub: pub,
    }, { requireLoginAuth: true });
    assert.equal(gated.ok, true);
  });
});

describe('A3 lost work on tip reset', () => {
  it('external tip with pending proven hashes increments lostWorkHashes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lost-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0 });
    const dest = destOf();
    pool.miners.set('w1', {
      login: dest,
      workerKey: dest,
      roundHashes: 512,
      hashes: 512,
      accepted: 2,
      connections: [],
    });
    const before = Number(pool.stats.lostWorkHashes) || 0;
    pool.store.emit('tip', { hash: 'ab', height: 2 });
    assert.ok(Number(pool.stats.lostWorkHashes) >= before + 512);
    assert.ok(Number(pool.stats.lostWorkEvents) >= 1);
    const n = Number(pool.stats.lostWorkHashes);
    pool.close();
    const again = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0 });
    assert.ok(Number(again.stats.lostWorkHashes) >= n);
    assert.ok(fs.existsSync(path.join(dir, 'lost-work.json')));
    again.close();
  });
});

describe('A4 fingerprint / dest bits / flood busy', () => {
  it('openShares dedupe on jobId:nonce:hash', () => {
    const list = [];
    const rec = { jobId: 'j1', nonce: '9', hash: 'aa'.repeat(32), dest: 'ssa1q' };
    assert.equal(rememberOpenShare(list, rec).ok, true);
    assert.equal(rememberOpenShare(list, rec).ok, false);
    assert.equal(rememberOpenShare(list, rec).reason, 'duplicate_share');
    assert.equal(rememberOpenShare(list, { ...rec, nonce: '10' }).ok, true);
  });

  it('shareBits persist by dest across reconnect book', () => {
    const book = new Map();
    rememberDestShareBits(book, 'ssa1abc', 12);
    assert.equal(destShareBitsOf(book, 'ssa1abc', 8), 12);
    assert.equal(destShareBitsOf(book, 'ssa1zzz', 8), 8);
  });

  it('shareBits warm-start from disk after a pool restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-share-bits-'));
    const book = new Map();
    rememberDestShareBits(book, 'ssa1abc', 14);
    persistDestShareBitsMap(dir, book);
    const loaded = loadDestShareBitsMap(dir);
    assert.equal(destShareBitsOf(loaded, 'ssa1abc', 8), 14);
    assert.equal(destShareBitsOf(loaded, 'ssa1zzz', 8), 8);
  });

  it('per-IP submit flood returns busy', () => {
    const book = new Map();
    let last = { ok: true };
    for (let i = 0; i < SUBMIT_PER_IP_MAX + 2; i += 1) {
      last = noteIpSubmit(book, '203.0.113.9', 1_700_000_000_000 + i);
    }
    assert.equal(last.ok, false);
    assert.equal(last.reason, 'busy');
  });
});

describe('A6 fold proven totals', () => {
  it('folded proven_* equals the dest sum', () => {
    const folded = foldPublicMinerViews([
      { miner: 'm11111111', provenHashes: 100, proven_round: 100, roundHashes: 100, hashes: 100, hashrate: 1 },
      { miner: 'm11111111', provenHashes: 50, proven_round: 50, roundHashes: 50, hashes: 50, hashrate: 2 },
      { miner: 'm22222222', provenHashes: 7, proven_round: 7, roundHashes: 7, hashes: 7, hashrate: 1 },
    ]);
    const a = folded.find((r) => r.miner === 'm11111111');
    const b = folded.find((r) => r.miner === 'm22222222');
    assert.equal(a.provenHashes, 150);
    assert.equal(a.proven_round, 150);
    assert.equal(b.provenHashes, 7);
  });
});

describe('A7 stats alerts', () => {
  it('crossing threshold flips alert flags', () => {
    assert.equal(statsAlerts({ topDestSharePct: 0.4, shareBlockRatio: 10 }).concentration, false);
    assert.equal(statsAlerts({ topDestSharePct: 0.6, shareBlockRatio: 10 }).concentration, true);
    assert.equal(statsAlerts({ topDestSharePct: 0.1, shareBlockRatio: 9_999 }).shareBlock, false);
    assert.equal(statsAlerts({ topDestSharePct: 0.1, shareBlockRatio: 10_000 }).shareBlock, true);
  });
});

describe('D3 explorer host serves explorer.html', () => {
  it('explorer.shear.digital / is explorer.html, pool host is index.html', () => {
    assert.equal(isExplorerHost('explorer.shear.digital'), true);
    assert.equal(isExplorerHost('pool.shear.digital'), false);
    assert.equal(publicHtmlFile('explorer.shear.digital', '/'), '/explorer.html');
    assert.equal(publicHtmlFile('explorer.shear.digital', '/index.html'), '/explorer.html');
    assert.equal(publicHtmlFile('pool.shear.digital', '/'), '/index.html');
    const ngx = fs.readFileSync(path.join(root, 'deploy/nginx-explorer.shear.digital.conf'), 'utf8');
    assert.match(ngx, /location = \//);
    assert.match(ngx, /try_files \/explorer\.html =404/);
    assert.doesNotMatch(ngx, /proxy_pass http:\/\/127\.0\.0\.1:8088\/\s*;/);
  });
});

describe('A5 + 2FA QR', () => {
  it('otpauth URI is Google Authenticator compatible and QR has finders', () => {
    const uri = totpKeyUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'operator' });
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
    assert.match(uri, /issuer=shear/);
    assert.match(uri, /algorithm=SHA1/);
    const m = qrModules(uri);
    assert.equal(m.length, m[0].length);
    assert.ok(m.length >= 21);
    const finder = [
      '#######',
      '#.....#',
      '#.###.#',
      '#.###.#',
      '#.###.#',
      '#.....#',
      '#######',
    ];
    const dump = (r0, c0) => finder.map((_, y) => {
      let s = '';
      for (let x = 0; x < 7; x += 1) s += m[r0 + y][c0 + x] ? '#' : '.';
      return s;
    });
    assert.deepEqual(dump(0, 0), finder);
    assert.deepEqual(dump(0, m.length - 7), finder);
    assert.deepEqual(dump(m.length - 7, 0), finder);
    for (let i = 8; i < m.length - 8; i += 1) {
      assert.equal(m[6][i], i % 2 === 0 ? 1 : 0);
      assert.equal(m[i][6], i % 2 === 0 ? 1 : 0);
    }
    const svg = qrSvg(uri);
    assert.match(svg, /^<svg /);
    assert.match(svg, /fill="#000"/);
    assert.match(svg, /viewBox="0 0 (\d+) /);
    const dim = Number((svg.match(/viewBox="0 0 (\d+)/) || [])[1] || 0);
    assert.ok(dim >= 200, `qr svg ${dim}px is too small to scan`);
    const html = fs.readFileSync(path.join(root, 'pool/admin/index.html'), 'utf8');
    assert.match(html, /id="totp-qr"/);
    assert.match(html, /function paintTotp/);
    assert.match(html, /otpauth:\/\/totp\//);
    assert.match(html, /width:220px/);
  });

  it('withdraw appends an audit record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wd-audit-'));
    appendAdminAudit(dir, { action: 'withdraw', dest: 'ssa1q', nanos: 1 });
    const text = fs.readFileSync(path.join(dir, 'admin-audit.jsonl'), 'utf8');
    assert.match(text, /"action":"withdraw"/);
  });

  it('totp/start returns otpauth + qrSvg', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-totp-qr-'));
    const admin = createAdmin(dir);
    const prev = process.env.SHEAR_ADMIN_HOST;
    delete process.env.SHEAR_ADMIN_HOST;
    const setup = admin.setup({ user: 'operator', password: 'aaaaaaaa', setupToken: admin.setupToken });
    assert.equal(setup.ok, true);
    const start = handleAdminApi(new URL('https://mypool.site/api/admin/totp/start'), 'POST', {}, {
      admin,
      cookie: `shear_admin=${setup.token}`,
    });
    assert.equal(start.json.ok, true);
    assert.match(start.json.otpauth, /^otpauth:\/\/totp\//);
    assert.match(start.json.qrSvg, /^<svg /);
    assert.equal(start.json.secret.length >= 16, true);
    const code = totpCode(admin.sessionOf(setup.token).totpPending);
    const confirm = handleAdminApi(new URL('https://mypool.site/api/admin/totp/confirm'), 'POST', { code }, {
      admin,
      cookie: `shear_admin=${setup.token}`,
    });
    assert.equal(confirm.json.ok, true);
    if (prev == null) delete process.env.SHEAR_ADMIN_HOST;
    else process.env.SHEAR_ADMIN_HOST = prev;
  });
});

describe('prod examples', () => {
  it('prod systemd example sets auth on and non-all-iface bind', () => {
    const units = [
      'deploy/shear-pool.service',
      'deploy/shear-pool-v4.service',
      'pool/deploy/shear-pool.service',
    ];
    for (const rel of units) {
      const unit = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.match(unit, /SHEAR_STRATUM_AUTH=1/, rel);
      assert.match(unit, /SHEAR_STRATUM_BIND=127\.0\.0\.1/, rel);
      assert.match(unit, /^Environment=SHEAR_ADMIN_HOST=/m, rel);
      assert.doesNotMatch(unit, /SHEAR_MAINNET_EMIT=1/, rel);
    }
    const node = fs.readFileSync(path.join(root, 'deploy/shear-node.service'), 'utf8');
    assert.doesNotMatch(node, /SHEAR_MAINNET_EMIT/);
    const tls = fs.readFileSync(path.join(root, 'pool/deploy/nginx-stratum-tls.conf'), 'utf8');
    assert.match(tls, /127\.0\.0\.1:1111/);
    assert.match(tls, /cleartext/);
    const spec = fs.readFileSync(path.join(root, 'specs/pool.md'), 'utf8');
    assert.doesNotMatch(spec, /Stratum: `0\.0\.0\.0:1111`/);
    assert.match(spec, /SHEAR_STRATUM_AUTH=1/);
    assert.match(spec, /SHEAR_STRATUM_BIND=127\.0\.0\.1/);
    assert.match(spec, /\/api\/stats/);
    const readme = fs.readFileSync(path.join(root, 'pool/README.md'), 'utf8');
    assert.match(readme, /stratumBind/);
    assert.match(readme, /loginAuth/);
    assert.match(readme, /TLS terminator/);
  });
});
