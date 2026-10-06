import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createPool,
  THIS_POOL_DIRECT_FEE_DEST,
  configuredFeeIdentity,
  stratumListenPlan,
  authPubGate,
  intervalCertify,
  gateStratumLogin,
} from '../src/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const miner = path.join(root, 'sheark-miner', 'ShearK-Miner.exe');
const openssl = 'C:\\msys64\\mingw64\\bin\\openssl.exe';

describe('fee dest, auth pub, certify, public stats', () => {
  it('mismatched fee dest versus admin spend fails closed and the shipped ssa1 is unchanged', () => {
    const shipped = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
    const retired = 'ssa1qzcru37269cx30t7pdsmujwrxhc76km6ctzhwggxnyr9f0ld85wc4zvluktldtcnke7mr524ngqqvfr3sd5qsh6kkuk';
    const retiredV11 = 'ssa1q5495s7qwnljwkt2q8896vect0qaj3argt68hvet8t3vkhf9f7tcn0qhsd2q45e4lnay7u98sp22sddc639hqt0d8jj';
    assert.equal(THIS_POOL_DIRECT_FEE_DEST, shipped);
    assert.notEqual(shipped, retired);
    assert.notEqual(shipped, retiredV11);
    assert.equal(shipped.slice(-4), 'e9sv');
    const retiredEnv = configuredFeeIdentity({ env: { SHEAR_FEE_DEST: retired, SHEAR_ADMIN_SPEND_DEST: retired } });
    assert.equal(retiredEnv.ok, false);
    assert.equal(retiredEnv.reason, 'v10_fee_dest');
    const retiredV11Env = configuredFeeIdentity({ env: { SHEAR_FEE_DEST: retiredV11, SHEAR_ADMIN_SPEND_DEST: retiredV11 } });
    assert.equal(retiredV11Env.ok, false);
    assert.equal(retiredV11Env.reason, 'v11_fee_dest');
    const retiredV11Legacy = configuredFeeIdentity({ env: { SHEAR_POOL_FEE_PAYOUT_DEST: retiredV11 } });
    assert.equal(retiredV11Legacy.ok, false);
    assert.equal(retiredV11Legacy.reason, 'v11_fee_dest');
    const match = configuredFeeIdentity({ env: {} });
    assert.equal(match.ok, true);
    assert.equal(match.feeDest, shipped);
    assert.equal(match.adminSpendDest, shipped);
    const bad = configuredFeeIdentity({
      env: { SHEAR_FEE_DEST: shipped, SHEAR_ADMIN_SPEND_DEST: `${shipped}x` },
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'fee_dest_mismatch');
    const legacy = `${shipped.slice(0, -1)}a`;
    const kept = configuredFeeIdentity({ env: { SHEAR_POOL_FEE_PAYOUT_DEST: legacy } });
    assert.equal(kept.ok, true);
    assert.equal(kept.feeDest, legacy);
    assert.equal(kept.adminSpendDest, legacy);
    const clash = configuredFeeIdentity({
      env: { SHEAR_POOL_FEE_PAYOUT_DEST: legacy, SHEAR_ADMIN_SPEND_DEST: shipped },
    });
    assert.equal(clash.ok, false);
    assert.equal(clash.reason, 'fee_dest_mismatch');
    const prev = process.env.SHEAR_ADMIN_SPEND_DEST;
    process.env.SHEAR_ADMIN_SPEND_DEST = `${shipped}x`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fee-'));
    try {
      const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0 });
      assert.equal(pool.issueJob(), null);
      pool.close();
    } finally {
      if (prev == null) delete process.env.SHEAR_ADMIN_SPEND_DEST;
      else process.env.SHEAR_ADMIN_SPEND_DEST = prev;
    }
  });

  it('AUTH=1 rejects an unbound auth pub', () => {
    assert.equal(authPubGate({ requireAuth: true, boundPub: '', presentedPub: 'ab'.repeat(32) }).reason, 'auth_pub_unbound');
    const pub = '11'.repeat(32);
    const gated = gateStratumLogin({
      login: 'ssa1q8flwjptadua9u7qtpvs7t26aarenstew938zlcgclzvthv5v4e03hsv4j8uf2pr73w8arp0krf0mhry6f5gqff4fl9',
      client: 'ShearHash',
      version: '2.7',
      authPub: pub,
      authSig: '00',
      challenge: 'abc',
    }, { requireLoginAuth: true });
    assert.equal(gated.ok, false);
    assert.equal(gated.reason, 'auth_pub_unbound');
  });

  it('n below 288 cannot certify ~90s', () => {
    const thin = intervalCertify({ sealedSamples: 12, ewmaMs: 90000, sealedMeanMs: 90000 });
    assert.equal(thin.soaking, true);
    assert.equal(thin.certified90s, false);
    assert.equal(thin.readyOnInterval, false);
    assert.match(thin.text, /soaking/);
    assert.match(thin.text, /n=12/);
    assert.match(thin.text, /not certified/);
    const full = intervalCertify({ sealedSamples: 288, ewmaMs: 90000, sealedMeanMs: 90000 });
    assert.equal(full.soaking, false);
    assert.equal(full.certified90s, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-cert-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0 });
    const stats = pool.publicStats();
    const body = JSON.stringify(stats);
    const ident = configuredFeeIdentity({ env: {} });
    const tail = String(ident.feeDest || '').slice(-4);
    assert.equal(ident.ok, true);
    assert.equal(stats.interval.soaking, true);
    assert.equal(stats.interval.certified90s, false);
    assert.equal(stats.productVersion, '19.0');
    assert.equal(stats.feeDest, THIS_POOL_DIRECT_FEE_DEST);
    assert.equal(body.includes(THIS_POOL_DIRECT_FEE_DEST), true);
    assert.equal(stats.feeNanos, undefined);
    assert.equal(stats.poolFeeNanos, undefined);
    assert.equal(stats.fluxset, undefined);
    assert.equal(stats.pubs, undefined);
    assert.equal(stats.feeDestTail, tail);
    assert.equal(stats.feeDestTail, THIS_POOL_DIRECT_FEE_DEST.slice(-4));
    assert.equal(String(stats.feeDestTail).length, 4);
    console.log(JSON.stringify({
      event: 'public_stats_fee_tail',
      feeDestTail: stats.feeDestTail,
      feeDestPresent: Object.prototype.hasOwnProperty.call(stats, 'feeDest'),
      fluxsetPresent: Object.prototype.hasOwnProperty.call(stats, 'fluxset'),
      pubsPresent: Object.prototype.hasOwnProperty.call(stats, 'pubs'),
    }));
    pool.close();
    const index = fs.readFileSync(path.join(root, 'pool/public/index.html'), 'utf8');
    const explorer = fs.readFileSync(path.join(root, 'explorer/explorer.html'), 'utf8');
    assert.doesNotMatch(index, /~90s certified/);
    assert.match(index, /<div class="label">blockBits<\/div>/);
    assert.match(explorer, /~90s not certified/);
  });

  it('public bind without TLS or the lab flag refuses to listen', async () => {
    const plan = stratumListenPlan({ bind: '0.0.0.0', hasTls: false, labCleartext: false });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'public_bind_needs_tls_or_lab');
    assert.equal(stratumListenPlan({ bind: '127.0.0.1', hasTls: false }).ok, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bind-'));
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      stratumBind: '0.0.0.0',
      labCleartext: false,
    });
    await assert.rejects(pool.listen(), /public_bind_needs_tls_or_lab/);
    pool.close();
  });
});

describe('stratum TLS job to share', () => {
  it('pool TLS listener accepts a share and ShearK can speak TLS', async () => {
    assert.equal(fs.existsSync(openssl), true, 'openssl');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tls-'));
    const cert = path.join(dir, 'cert.pem');
    const key = path.join(dir, 'key.pem');
    const made = spawnSync(openssl, [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
      '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      stratumBind: '127.0.0.1',
      tlsCert: cert,
      tlsKey: key,
      tlsPort: 0,
      shareBits: 8,
    });
    const bound = await pool.listen();
    assert.ok(bound.tlsPort > 0, JSON.stringify(bound));
    const jobLine = await new Promise((resolve, reject) => {
      const sock = tls.connect({
        host: '127.0.0.1',
        port: bound.tlsPort,
        ca: fs.readFileSync(cert),
        servername: '127.0.0.1',
        rejectUnauthorized: true,
      }, () => {
        sock.write(`${JSON.stringify({
          id: 1,
          method: 'login',
          params: {
            login: 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.tls',
            client: 'ShearHash',
            version: '2.7',
          },
        })}\n`);
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('\n')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error(`tls login timeout ${buf}`)), 8000);
    });
    assert.match(jobLine, /"jobId"/);
    const clear = await new Promise((resolve) => {
      const s = net.connect(bound.stratumPort, '127.0.0.1', () => {
        s.write(`${JSON.stringify({ id: 1, method: 'login', params: { login: 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.clear', client: 'ShearHash', version: '2.7' } })}\n`);
      });
      let buf = '';
      s.on('data', (c) => { buf += c.toString(); });
      s.on('error', () => resolve(buf));
      setTimeout(() => { s.destroy(); resolve(buf); }, 2000);
    });
    assert.match(clear, /jobId|error|OK/);
    if (!fs.existsSync(miner)) {
      pool.close();
      assert.fail('ShearK-Miner.exe missing');
    }
    const cfg = spawnSync(miner, ['--backend', 'interpreter', '--print-config'], { encoding: 'utf8' });
    const version = (String(cfg.stdout || '').match(/"version":"([^"]+)"/) || [])[1] || '';
    const magic = fs.readFileSync(miner).subarray(0, 2).toString('latin1');
    console.log(JSON.stringify({
      event: 'sheark_binary',
      path: miner,
      bytes: fs.statSync(miner).size,
      pe: magic === 'MZ',
      version,
    }));
    assert.equal(magic, 'MZ');
    assert.equal(version, '2.8');
    assert.notEqual(version, '2.6');
    assert.notEqual(version, '2.7');
    const child = spawn(miner, [
      '--backend', 'jit',
      '--pool', `stratum+ssl://127.0.0.1:${bound.tlsPort}`,
      '--tls-ca', cert,
      '--user', 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.raskul',
      '--threads', '2',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `C:\\msys64\\mingw64\\bin;${process.env.PATH || ''}` },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !/accepted=[1-9]/.test(out) && !/tls failed/.test(out)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    child.kill();
    pool.close();
    let acceptedN = 0;
    for (const m of out.matchAll(/accepted=(\d+)/g)) {
      const n = Number(m[1]);
      if (n > acceptedN) acceptedN = n;
    }
    console.log(JSON.stringify({
      event: 'tls_job_share',
      path: miner,
      version,
      scheme: 'stratum+ssl',
      accepted: acceptedN,
    }));
    assert.equal(/tls failed/.test(out), false, out);
    assert.match(out, /stratum\+ssl:\/\//, out);
    assert.ok(acceptedN >= 1, out);
    assert.match(out, /accepted=[1-9]/, out);
  });
});
