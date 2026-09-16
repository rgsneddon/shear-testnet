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
import { NANOS_PER_SHE, formatShe } from '../../crypto/asert.js';
import {
  levyNanos,
  mempoolDepthBytes,
  poolFeeDest,
  containsShe1,
  verifyPoolWithdrawOffchain,
} from '../../crypto/levy.js';
import { ownerPubFromOpening } from '../../crypto/eip712.js';
import { reconstructOwner } from './wallet_api.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { withdrawNonces, withdrawDigests } from './withdraw_state.js';

export const ADMIN_ISSUER = 'shear';
/** Display-only. Authorization is password + TOTP after setup. */
export const ADMIN_USER = '';
const COOKIE = 'shear_admin';
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_DIR = path.join(__dirname, '../admin');
const PUBLIC_BRAND = path.join(__dirname, '../public/brand');
/** Documented generic example. Override with SHEAR_ADMIN_HOST. */
export const ADMIN_HOST_EXAMPLE = 'mypool.site';

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

export function isAdminPath(pathname) {
  const p = String(pathname || '');
  return p === '/admin' || p.startsWith('/admin/') || p.startsWith('/api/admin');
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
    return true;
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
    const otpauth = `otpauth://totp/shear?secret=${b32}&issuer=${ADMIN_ISSUER}&algorithm=SHA1&digits=6&period=30`;
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

  return { status, setup, login, startTotp, confirmTotp, sessionOf, logout, load, setupToken };
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

function needOps(ops, name) {
  if (!ops || typeof ops[name] !== 'function') {
    return { status: 501, json: { ok: false, reason: 'no_ops' } };
  }
  return null;
}

export function handleAdminApi(url, method, body, {
  store, queueSend, cookie, admin, ops, loopback = false, host = '', pendingPulls,
} = {}) {
  const pathName = url.pathname;
  const verb = String(method || 'GET').toUpperCase();
  const token = cookieToken(cookie);
  if (pathName === '/api/admin/status' && verb === 'GET') {
    return { status: 200, json: admin.status(), headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } };
  }
  if (pathName === '/api/admin/setup' && verb === 'POST') {
    const got = admin.setup({
      user: body.user,
      password: body.password,
      loopback: loopback === true,
      setupToken: body.setupToken,
      host,
      pathname: pathName,
    });
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
    if (containsShe1(body.to) || containsShe1(body.dest)) {
      return { status: 400, json: { ok: false, reason: 'she1_on_chain' } };
    }
    const to = payoutDest(String(body.to || body.dest || '')) || '';
    const amount = Number(body.amount);
    const she = String(body.login || body.she1 || '').trim().split('.')[0];
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
    const pending = {
      id: `admin-spend-${nanos}`,
      kind: 'admin-spendable',
      login: she,
      dest: to,
      nanos,
      fee,
      chainId: 2701,
      at: Date.now(),
    };
    const sig = body.sig || body.signature;
    if (!sig) {
      if (she.startsWith('she1') && pendingPulls && typeof pendingPulls.set === 'function') {
        pendingPulls.set(she.toLowerCase(), pending);
      }
      return { status: 400, json: { ok: false, reason: she.startsWith('she1') ? 'unsigned' : 'need_she1', pending: she.startsWith('she1') ? pending : undefined } };
    }
    const off = verifyPoolWithdrawOffchain({
      login: she,
      dest: to,
      nanos,
      sig,
      minerShe1: she,
      payoutSsa1: to,
      height: body.height,
      nonce: body.nonce,
      deadline: body.deadline,
      nonceStore: withdrawNonces,
      seenDigests: withdrawDigests,
      open: body.open,
      spendSig: body.spendSig,
      ownerPub: ownerPubFromOpening(body.open),
      requireOwner: true,
    });
    if (!off.ok) return { status: 400, json: { ok: false, ...off } };
    const tx = attachDummyOuts({
      kind: 'send',
      from,
      to,
      nanos,
      amount,
      fee,
      maxLevy: fee,
      open: body.open,
      spendSig: body.spendSig,
      vin: [{ address: from }],
      vout: [{ address: to, nanos, kind: 'send' }],
    });
    if (containsShe1(tx)) return { status: 400, json: { ok: false, reason: 'she1_on_chain' } };
    let queued = { ok: true, tx };
    if (typeof queueSend === 'function') queued = queueSend(tx);
    if (queued && typeof queued === 'object' && queued.ok === false) {
      return { status: 400, json: { ok: false, reason: queued.reason || 'queue_failed' } };
    }
    if (pendingPulls && typeof pendingPulls.delete === 'function' && she) {
      pendingPulls.delete(she.toLowerCase());
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
  if (pathName === '/api/admin/health' && verb === 'GET') {
    const miss = needOps(ops, 'health');
    if (miss) return miss;
    return { status: 200, json: { ok: true, ...ops.health() } };
  }
  if (pathName === '/api/admin/miners' && verb === 'GET') {
    const miss = needOps(ops, 'miners');
    if (miss) return miss;
    const rows = ops.miners() || [];
    return { status: 200, json: { ok: true, miners: rows, n: rows.length } };
  }
  if (pathName === '/api/admin/pause' && verb === 'POST') {
    const miss = needOps(ops, 'setPaused');
    if (miss) return miss;
    const next = body.pause !== false && body.paused !== false && body.resume !== true;
    return { status: 200, json: { ok: true, ...ops.setPaused(!!next) } };
  }
  if (pathName === '/api/admin/resume' && verb === 'POST') {
    const miss = needOps(ops, 'setPaused');
    if (miss) return miss;
    return { status: 200, json: { ok: true, ...ops.setPaused(false) } };
  }
  if (pathName === '/api/admin/restart' && verb === 'POST') {
    const miss = needOps(ops, 'restart');
    if (miss) return miss;
    return { status: 200, json: { ok: true, ...ops.restart() } };
  }
  if (pathName === '/api/admin/restart-hasher' && verb === 'POST') {
    const miss = needOps(ops, 'restartHasher');
    if (miss) return miss;
    return { status: 200, json: { ok: true, ...ops.restartHasher() } };
  }
  if (pathName === '/api/admin/rebroadcast' && verb === 'POST') {
    const miss = needOps(ops, 'rebroadcast');
    if (miss) return miss;
    return { status: 200, json: { ok: true, ...ops.rebroadcast() } };
  }
  if (pathName === '/api/admin/disconnect-all' && verb === 'POST') {
    const miss = needOps(ops, 'disconnectAll');
    if (miss) return miss;
    return { status: 200, json: { ok: true, ...ops.disconnectAll() } };
  }
  if (pathName === '/api/admin/kick' && verb === 'POST') {
    const miss = needOps(ops, 'kick');
    if (miss) return miss;
    const want = String(body.miner || body.tag || body.workerKey || body.dest || '');
    if (!want) return { status: 400, json: { ok: false, reason: 'need_miner' } };
    return { status: 200, json: { ok: true, ...ops.kick(want) } };
  }
  if (pathName === '/api/admin/ban' && verb === 'POST') {
    const miss = needOps(ops, 'ban');
    if (miss) return miss;
    const want = String(body.miner || body.tag || body.workerKey || body.dest || '');
    if (!want) return { status: 400, json: { ok: false, reason: 'need_miner' } };
    return { status: 200, json: { ok: true, ...ops.ban(want) } };
  }
  if (pathName === '/api/admin/unban' && verb === 'POST') {
    const miss = needOps(ops, 'unban');
    if (miss) return miss;
    const want = String(body.miner || body.tag || body.workerKey || body.dest || '');
    if (!want) return { status: 400, json: { ok: false, reason: 'need_miner' } };
    return { status: 200, json: { ok: true, ...ops.unban(want) } };
  }
  if (pathName === '/api/admin/clear-stale' && verb === 'POST') {
    const miss = needOps(ops, 'clearStale');
    if (miss) return miss;
    return { status: 200, json: { ok: true, ...ops.clearStale() } };
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
  const remote = String(opts.remoteAddress || req.socket?.remoteAddress || '');
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote.endsWith('127.0.0.1');
  for (const [k, v] of Object.entries(PRIVACY)) res.setHeader(k, v);
  const url = new URL(req.url, `https://${ADMIN_HOST}`);
  if (url.pathname === '/robots.txt' || url.pathname === '/admin/robots.txt') {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(ROBOTS);
    return;
  }
  const apiPath = url.pathname.startsWith('/admin/api/admin')
    ? url.pathname.slice('/admin'.length)
    : url.pathname;
  if (apiPath.startsWith('/api/admin')) {
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
    const apiUrl = new URL(apiPath + (url.search || ''), `https://${ADMIN_HOST}`);
    const out = handleAdminApi(apiUrl, req.method, body, {
      ...opts,
      cookie: req.headers.cookie,
      loopback,
      host,
    });
    res.statusCode = out.status;
    res.setHeader('content-type', 'application/json');
    if (out.headers) {
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    }
    res.end(JSON.stringify(out.json));
    return;
  }
  let file = url.pathname;
  if (file === '/admin') file = '/index.html';
  else if (file.startsWith('/admin/')) file = file.slice('/admin'.length) || '/index.html';
  else if (file === '/') file = '/index.html';
  const brand = file.startsWith('/brand/');
  const root = brand ? PUBLIC_BRAND : ADMIN_DIR;
  const rel = brand ? file.slice('/brand'.length) : file;
  const full = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(root)) {
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
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
    };
    res.setHeader('content-type', types[ext] || 'application/octet-stream');
    res.end(data);
  });
}
