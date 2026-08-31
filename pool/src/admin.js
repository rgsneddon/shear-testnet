/**
 * kyrusfables.shear.digital — operator fee wallet.
 * Not a public page. Host-gated. Encrypted at rest. Same Phase B levy as the book.
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
import { NANOS_PER_SHE, formatShe } from '../../crypto/asert.js';
import {
  levyNanos,
  mempoolDepthBytes,
  poolFeeDest,
  containsShe1,
} from '../../crypto/levy.js';
import { reconstructOwner } from './wallet_api.js';

export const ADMIN_HOST = 'kyrusfables.shear.digital';
export const ADMIN_USER = 'raskul';
const COOKIE = 'shear_admin';
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_DIR = path.join(__dirname, '../admin');

export function isAdminHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  return h === ADMIN_HOST;
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

  function setup({ user, password } = {}) {
    const s = load();
    if (s.pass || s.closed) return { ok: false, reason: 'closed' };
    if (!same(user, ADMIN_USER)) return { ok: false, reason: 'auth' };
    const pw = String(password || '');
    if (pw.length < 8) return { ok: false, reason: 'password' };
    const salt = randomBytes(16);
    s.user = 'ok';
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
    if (!same(user, ADMIN_USER)) return { ok: false, reason: 'auth' };
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
    const otpauth = `otpauth://totp/kyrusfables?secret=${b32}&issuer=kyrusfables&algorithm=SHA1&digits=6&period=30`;
    return { ok: true, secret: b32, otpauth };
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

  return { status, setup, login, startTotp, confirmTotp, sessionOf, logout, load };
}

function cookieToken(cookie) {
  const raw = String(cookie || '');
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`));
  return m ? m[1] : '';
}

function setCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function handleAdminApi(url, method, body, {
  store, queueSend, cookie, admin,
} = {}) {
  const pathName = url.pathname;
  const verb = String(method || 'GET').toUpperCase();
  const token = cookieToken(cookie);
  if (pathName === '/api/admin/status' && verb === 'GET') {
    return { status: 200, json: admin.status(), headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } };
  }
  if (pathName === '/api/admin/setup' && verb === 'POST') {
    const got = admin.setup({ user: body.user, password: body.password });
    if (!got.ok) return { status: 400, json: got };
    return {
      status: 200,
      json: { ok: true, setup: true, totp: false },
      headers: { 'Set-Cookie': setCookie(got.token) },
    };
  }
  if (pathName === '/api/admin/login' && verb === 'POST') {
    const got = admin.login({ user: body.user, password: body.password, code: body.code });
    if (!got.ok) return { status: 400, json: got };
    return {
      status: 200,
      json: { ok: true, totp: got.totp },
      headers: { 'Set-Cookie': setCookie(got.token) },
    };
  }
  if (pathName === '/api/admin/logout' && verb === 'POST') {
    admin.logout(token);
    return { status: 200, json: { ok: true }, headers: { 'Set-Cookie': clearCookie() } };
  }
  if (pathName === '/api/admin/totp/start' && verb === 'POST') {
    const got = admin.startTotp(token);
    if (!got.ok) return { status: 401, json: got };
    return { status: 200, json: got };
  }
  if (pathName === '/api/admin/totp/confirm' && verb === 'POST') {
    const got = admin.confirmTotp(token, body.code);
    if (!got.ok) return { status: 400, json: got };
    return { status: 200, json: got };
  }
  const rec = admin.sessionOf(token);
  if (!rec) return { status: 401, json: { ok: false, reason: 'auth' } };
  if (pathName === '/api/admin/wallet' && verb === 'GET') {
    const from = poolFeeDest();
    const hist = reconstructOwner(store, from);
    return {
      status: 200,
      json: {
        ok: true,
        spendable: hist.spendable,
        spendableNanos: hist.spendableNanos,
        display: formatShe(hist.spendable),
        totp: !!admin.status().totp,
      },
    };
  }
  if (pathName === '/api/admin/withdraw' && verb === 'POST') {
    const from = poolFeeDest();
    if (containsShe1(body)) {
      return { status: 400, json: { ok: false, reason: 'she1_on_chain' } };
    }
    const to = payoutDest(String(body.to || body.dest || '')) || '';
    const amount = Number(body.amount);
    if (!isDestAddress(to) || !(amount > 0)) {
      return { status: 400, json: { ok: false, reason: 'bad_send' } };
    }
    const hist = reconstructOwner(store, from);
    const nanos = Math.round(amount * NANOS_PER_SHE);
    const depth = mempoolDepthBytes(store?.mempool || []);
    const fee = levyNanos(nanos, { depth });
    if (hist.spendableNanos < nanos + fee) {
      return { status: 400, json: { ok: false, reason: 'insufficient' } };
    }
    const tx = {
      kind: 'send',
      from,
      to,
      nanos,
      amount,
      fee,
      maxLevy: fee,
      vin: [{ address: from }],
      vout: [{ address: to, nanos, kind: 'send' }],
    };
    if (containsShe1(tx)) return { status: 400, json: { ok: false, reason: 'she1_on_chain' } };
    let queued = { ok: true, tx };
    if (typeof queueSend === 'function') queued = queueSend(tx);
    if (queued && typeof queued === 'object' && queued.ok === false) {
      return { status: 400, json: { ok: false, reason: queued.reason || 'queue_failed' } };
    }
    return {
      status: 200,
      json: {
        ok: true,
        levy: fee,
        spendable: (hist.spendableNanos - nanos - fee) / NANOS_PER_SHE,
        tx: { id: queued?.id || queued?.tx?.id, to, amount, fee, kind: 'send' },
      },
    };
  }
  return { status: 404, json: { ok: false, reason: 'unknown' } };
}

const ROBOTS = 'User-agent: *\nDisallow: /\n';
const PRIVACY = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export async function handleAdminHttp(req, res, opts) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (!isAdminHost(host)) {
    res.statusCode = 404;
    res.end('missing');
    return;
  }
  for (const [k, v] of Object.entries(PRIVACY)) res.setHeader(k, v);
  const url = new URL(req.url, `https://${ADMIN_HOST}`);
  if (url.pathname === '/robots.txt') {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(ROBOTS);
    return;
  }
  if (url.pathname.startsWith('/api/admin')) {
    let body = {};
    if (req.method === 'POST') {
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
        req.on('error', reject);
      });
      try { body = JSON.parse(raw); } catch { body = {}; }
    }
    const out = handleAdminApi(url, req.method, body, {
      ...opts,
      cookie: req.headers.cookie,
    });
    res.statusCode = out.status;
    res.setHeader('content-type', 'application/json');
    if (out.headers) {
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    }
    res.end(JSON.stringify(out.json));
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(ADMIN_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(ADMIN_DIR)) {
    res.statusCode = 403;
    res.end('no');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('missing');
      return;
    }
    const ext = path.extname(full);
    res.setHeader('content-type', ext === '.txt' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(data);
  });
}
