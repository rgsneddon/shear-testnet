/**
 * Operator desk. Host is display/routing only, not authorization.
 * Dedicated admin host comes from SHEAR_ADMIN_HOST (never a baked-in name).
 * Generic deploy serves the same desk at /admin (example: https://mypool.site/admin).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import { isDestAddress, payoutDest } from '../../crypto/address.js';
import { configuredFeeIdentity } from './posture.js';
import { NANOS_PER_SHE, formatShe } from '../../crypto/asert.js';
import { HTTP_BODY_MAX, parseBoundedJson } from '../../crypto/json_bounds.js';
import {
  levyNanos,
  mempoolDepthBytes,
  containsShe1,
  verifyPoolWithdrawOffchain,
} from '../../crypto/levy.js';
import { ownerPubFromOpening } from '../../crypto/eip712.js';
import { reconstructOwner } from './wallet_api.js';
import { qrSvg } from './totp_qr.js';

export const ADMIN_ISSUER = 'shear';
/** Display-only. Authorization is password + TOTP after setup. */
export const ADMIN_USER = '';
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_DIR = path.join(__dirname, '../admin');
/** Documented generic example. Override with SHEAR_ADMIN_HOST. */
export const ADMIN_HOST_EXAMPLE = 'mypool.site';

/** Operator Continuum dests: custody pot dest plus the 1% fee dest. */
export function adminWalletDests(poolDest) {
  const out = [];
  const pay = payoutDest(poolDest) || (isDestAddress(poolDest) ? String(poolDest).trim() : '');
  if (pay && isDestAddress(pay)) out.push(pay);
  const pinned = configuredFeeIdentity();
  const fee = pinned.ok ? pinned.feeDest : '';
  if (fee && isDestAddress(fee) && fee !== pay) out.push(fee);
  if (!out.length && fee) out.push(fee);
  return out;
}

export function minerReservedNanos(pullBook) {
  if (!pullBook || typeof pullBook.tags !== 'function' || typeof pullBook.view !== 'function') return 0;
  let n = 0;
  for (const tag of pullBook.tags()) {
    const v = pullBook.view(tag);
    n += Math.max(0, Math.floor(Number(v?.pendingNanos) || 0));
  }
  return n;
}

export function adminWalletBalance(store, poolDest, pullBook) {
  const pinned = configuredFeeIdentity();
  const fee = pinned.ok ? pinned.feeDest : '';
  const pay = payoutDest(poolDest) || (isDestAddress(poolDest) ? String(poolDest).trim() : '');
  const feeN = fee ? reconstructOwner(store, fee).spendableNanos : 0;
  const custodyN = pay && pay !== fee ? reconstructOwner(store, pay).spendableNanos : 0;
  const reserved = minerReservedNanos(pullBook);
  const adminN = Math.max(0, feeN);
  return {
    dests: adminWalletDests(poolDest),
    spendableNanos: adminN,
    spendable: adminN / NANOS_PER_SHE,
    display: formatShe(adminN / NANOS_PER_SHE),
    minerReservedNanos: reserved,
    minerReserved: reserved / NANOS_PER_SHE,
    minerReservedDisplay: formatShe(reserved / NANOS_PER_SHE),
    custodySpendableNanos: Math.max(0, custodyN),
    custodyDisplay: formatShe(Math.max(0, custodyN) / NANOS_PER_SHE),
    feeSpendableNanos: adminN,
  };
}

function adminSpendFrom() {
  const pinned = configuredFeeIdentity();
  if (!pinned.ok) {
    const err = new Error('fee_dest_mismatch');
    err.reason = 'fee_dest_mismatch';
    throw err;
  }
  return pinned.feeDest;
}

export function configuredAdminHosts() {
  return String(process.env.SHEAR_ADMIN_HOST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** First configured host, else the generic example used in docs and tests. */
export const ADMIN_HOST = configuredAdminHosts()[0] || ADMIN_HOST_EXAMPLE;

export function isAdminHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  const hosts = configuredAdminHosts();
  if (!hosts.length) return false;
  return hosts.includes(h);
}

function toBase32(buf) {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = (
    ((hmac[off] & 0x7f) << 24)
    | (hmac[off + 1] << 16)
    | (hmac[off + 2] << 8)
    | hmac[off + 3]
  ) % 1e6;
  return String(code).padStart(6, '0');
}

export function totpCode(secret, now = Date.now()) {
  return hotp(secret, Math.floor(now / 30_000));
}

/** Google Authenticator Key URI. Label is issuer:account; secret is unpadded Base32. */
export function totpKeyUri({ secret, issuer = ADMIN_ISSUER, account = 'operator' } = {}) {
  const iss = String(issuer || 'shear').trim() || 'shear';
  const acc = String(account || 'operator').trim() || 'operator';
  const b32 = String(secret || '').replace(/[\s=]+/g, '').toUpperCase();
  const label = `${encodeURIComponent(iss)}:${encodeURIComponent(acc)}`;
  return `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(iss)}&algorithm=SHA1&digits=6&period=30`;
}

export function verifyTotp(secret, code, now = Date.now()) {
  const want = String(code || '').replace(/\s/g, '');
  if (!/^[0-9]{6}$/.test(want)) return false;
  const a = Buffer.from(want);
  for (const w of [-1, 0, 1]) {
    const got = Buffer.from(totpCode(secret, now + w * 30_000));
    if (got.length === a.length && timingSafeEqual(got, a)) return true;
  }
  return false;
}

function emptyState() {
  return {
    user: null,
    pass: null,
    totp: null,
    closed: false,
  };
}

function machineKey(dir) {
  const p = path.join(dir, 'admin.key');
  if (fs.existsSync(p)) return fs.readFileSync(p);
  const k = randomBytes(32);
  fs.writeFileSync(p, k, { mode: 0o600 });
  return k;
}

function wrapFileKey(machine) {
  return createHash('sha256').update('shear-admin-vault-v1').update(machine).digest();
}

function encryptJson(key, obj) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function decryptJson(key, raw) {
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

function encryptSecret(passKey, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', passKey, iv);
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') };
}

function decryptSecret(passKey, blob) {
  const iv = Buffer.from(blob.iv, 'hex');
  const tag = Buffer.from(blob.tag, 'hex');
  const ct = Buffer.from(blob.ct, 'hex');
  const d = createDecipheriv('aes-256-gcm', passKey, iv);
  d.setAuthTag(tag);
  return d.update(ct);
}

function passHash(password, salt) {
  return scryptSync(String(password), salt, 32, SCRYPT);
}

function passKey(password, salt) {
  return scryptSync(String(password), Buffer.concat([salt, Buffer.from('wrap')]), 32, SCRYPT);
}

function same(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function createAdmin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const encPath = path.join(dir, 'admin.enc');
  const machine = machineKey(dir);
  const fileKey = wrapFileKey(machine);
  const sessions = new Map();
  const setupToken = randomBytes(16).toString('hex');

  function load() {
    if (!fs.existsSync(encPath)) return emptyState();
    try {
      return decryptJson(fileKey, fs.readFileSync(encPath));
    } catch {
      return emptyState();
    }
  }

  function save(state) {
    fs.writeFileSync(encPath, encryptJson(fileKey, state), { mode: 0o600 });
  }

  function status() {
    const s = load();
    return {
      ok: true,
      setup: !!s.pass,
      totp: !!(s.totp && s.totp.enrolled),
      closed: !!s.closed,
    };
  }

  function issueSession(passWrap, totpPending) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, {
      wrap: passWrap,
      totpPending: totpPending || null,
      exp: Date.now() + 12 * 3600_000,
    });
    return token;
  }

  function sessionOf(token) {
    const rec = sessions.get(String(token || ''));
    if (!rec || rec.exp < Date.now()) {
      if (rec) sessions.delete(String(token || ''));
      return null;
    }
    return rec;
  }

  function mayFirstRun({ setupToken: tokenIn, loopback = false, host = '', pathname = '' } = {}) {
    const s = load();
    if (s.pass || s.closed || fs.existsSync(encPath)) return false;
    if (tokenIn && same(tokenIn, setupToken)) return true;
    const envOk = String(process.env.SHEAR_ADMIN_SETUP || '') === '1';
    if (loopback === true && envOk) return true;
    const hosts = configuredAdminHosts();
    if (hosts.length) return isAdminHost(host);
    // Deny-by-default: Host header is not authorization when SHEAR_ADMIN_HOST is unset.
    return false;
  }

  function setup({
    user, password, setupToken: tokenIn, loopback = false, host = '', pathname = '',
  } = {}) {
    const s = load();
    if (s.pass || s.closed) return { ok: false, reason: 'closed' };
    if (!mayFirstRun({ setupToken: tokenIn, loopback, host, pathname })) {
      return { ok: false, reason: 'setup_forbidden' };
    }
    const name = String(user || '').trim().slice(0, 64);
    if (name.length < 1) return { ok: false, reason: 'username' };
    const pw = String(password || '');
    if (pw.length < 8) return { ok: false, reason: 'password' };
    const salt = randomBytes(16);
    s.user = name;
    s.pass = { salt: salt.toString('hex'), hash: passHash(pw, salt).toString('hex') };
    s.totp = null;
    s.closed = false;
    save(s);
    const token = issueSession(passKey(pw, salt), null);
    return { ok: true, setup: true, totp: false, token };
  }

  function login({ user, password, code } = {}) {
    const s = load();
    if (!s.pass) return { ok: false, reason: 'auth' };
    if (!same(String(user || '').trim(), String(s.user || ''))) {
      return { ok: false, reason: 'auth' };
    }
    const salt = Buffer.from(s.pass.salt, 'hex');
    const want = Buffer.from(s.pass.hash, 'hex');
    const got = passHash(password, salt);
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      return { ok: false, reason: 'auth' };
    }
    const wrap = passKey(password, salt);
    if (s.totp && s.totp.enrolled) {
      let secret;
      try {
        secret = decryptSecret(wrap, s.totp);
      } catch {
        return { ok: false, reason: 'auth' };
      }
      if (!verifyTotp(secret, code)) return { ok: false, reason: 'auth' };
    }
    const token = issueSession(wrap, null);
    return { ok: true, totp: !!(s.totp && s.totp.enrolled), token };
  }

  function startTotp(token) {
    const rec = sessionOf(token);
    if (!rec) return { ok: false, reason: 'auth' };
    const s = load();
    if (s.totp && s.totp.enrolled) return { ok: false, reason: 'closed' };
    const secret = randomBytes(20);
    rec.totpPending = secret;
    const b32 = toBase32(secret);
    const account = String(s.user || 'operator');
    const otpauth = totpKeyUri({ secret: b32, issuer: ADMIN_ISSUER, account });
    let svg = '';
    try { svg = qrSvg(otpauth); } catch { svg = ''; }
    return { ok: true, secret: b32, otpauth, qrSvg: svg, account, issuer: ADMIN_ISSUER };
  }

  function confirmTotp(token, code) {
    const rec = sessionOf(token);
    if (!rec || !rec.totpPending) return { ok: false, reason: 'auth' };
    if (!verifyTotp(rec.totpPending, code)) return { ok: false, reason: 'auth' };
    const s = load();
    s.totp = { enrolled: true, ...encryptSecret(rec.wrap, rec.totpPending) };
    s.closed = true;
    save(s);
    rec.totpPending = null;
    return { ok: true, totp: true, closed: true };
  }

  function logout(token) {
    sessions.delete(String(token || ''));
    return { ok: true };
  }

  return { status, setup, login, startTotp, confirmTotp, sessionOf, logout, load, setupToken, dir };
}

export function appendAdminAudit(dir, rec) {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ t: Date.now(), ...rec }) + '\n';
  fs.appendFileSync(path.join(dir, 'admin-audit.jsonl'), line, { mode: 0o600 });
  return rec;
}


export function handleAdminApi(url, method, body, {
  store, queueSend, cookie, admin, ops, loopback = false, host = '', pendingPulls, poolDest = '', pullBook = null,
} = {}) {
  // The web desk is gone. SSH and the process CLI remain. No path here sets up or spends.
  void url; void method; void body; void store; void queueSend; void cookie; void admin;
  void ops; void loopback; void host; void pendingPulls; void poolDest; void pullBook;
  return {
    status: 404,
    json: { ok: false, reason: 'admin_absent' },
    headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'no-store' },
  };
}

export async function handleAdminHttp(req, res, opts) {
  void opts;
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  try { req.resume(); } catch { /* the client may already be closed */ }
  res.end(JSON.stringify({ ok: false, reason: 'admin_absent' }));
  return;
}
