import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requiredJobFields, decodeHeader } from '../../crypto/header.js';
import { headerFromHex, setNonce } from '../../crypto/header.js';
import { shearHash, meetsTarget, leadingZeroBits, ALGO, CLIENT, PERSONAL } from '../../crypto/shear_hash.js';
import { isMineLogin, isPaymentCode, payoutDest } from '../../crypto/address.js';
import {
  BLOCK_SUBSIDY_NANOS,
  POOL_FEE_BPS,
  MAGIC_TESTNET,
  TARGET_BLOCK_INTERVAL_MS,
  HASH_BONUS_NANOS,
  HASH_TX_LIVE,
  consensusFingerprint,
  consensusLaw,
} from '../../crypto/asert.js';
import { createStore } from '../../node/src/store.js';
import { poolRecentBlockTxs } from './wallet_api.js';
import {
  clampShareBits,
  hashesProvenByShare,
  nextShareBits,
  shouldRetargetShare,
  SHARE_BITS_V2_START,
} from './share_vardiff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, '../public');
/** Public H/s is proven hashes in this window, not lifetime hashes / first-seen. */
export const HASHRATE_WINDOW_MS = 180_000;
/** Display H/s eases toward the window mean. 1s UI polls must not paint each share. */
export const HASHRATE_EMA_TAU_S = 30;
/** After the last socket closes, keep the row this long. Still-connected hashers with proven shares stay listed (header bits can put shares >12s apart). */
export const HASH_PRESENCE_MS = 12_000;
/** Mean interval of recent headers so the live 9s cadence is not buried under old 90s history. */
export const AVG_BLOCK_WINDOW = 20;

/**
 * Average time between consecutive blocks over the last `windowBlocks`
 * headers. Span of first→last timestamp divided by (n − 1).
 */
export function avgBlockIntervalMs(blocks, windowBlocks = AVG_BLOCK_WINDOW) {
  const list = Array.isArray(blocks) ? blocks : [];
  const keep = Math.max(2, Math.floor(Number(windowBlocks) || AVG_BLOCK_WINDOW));
  const window = list.length > keep ? list.slice(-keep) : list;
  if (window.length < 2) return null;
  const times = [];
  for (const b of window) {
    try {
      const ts = Number(decodeHeader(Buffer.from(b.header)).timestamp);
      if (Number.isFinite(ts) && ts > 0) times.push(ts);
    } catch { /* skip a bad header */ }
  }
  if (times.length < 2) return null;
  const span = times[times.length - 1] - times[0];
  if (!Number.isFinite(span) || span < 0) return null;
  return span / (times.length - 1);
}

/** 1 SHE pot split by proven work this round. 1% of the pot may go to the pool dest. */
export function splitPot(round, poolDest) {
  const rows = [];
  for (const s of round || []) {
    const dest = payoutDest(s.miner || s.address);
    const count = Number(s.count) || 0;
    if (!dest || count <= 0) continue;
    rows.push({ dest, count });
  }
  const total = rows.reduce((a, r) => a + r.count, 0);
  if (!total) {
    const fallback = payoutDest(poolDest);
    return fallback ? [{ address: fallback, nanos: BLOCK_SUBSIDY_NANOS }] : [];
  }
  const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
  const rest = BLOCK_SUBSIDY_NANOS - fee;
  const shares = rows.map((r) => ({
    address: r.dest,
    nanos: Math.floor(rest * r.count / total),
  }));
  const paid = shares.reduce((a, s) => a + s.nanos, 0);
  if (shares.length) shares[0].nanos += rest - paid;
  const poolPay = payoutDest(poolDest);
  if (fee > 0 && poolPay) shares.push({ address: poolPay, nanos: fee });
  return shares.filter((s) => s.nanos > 0);
}

/** Dest (ssa1) or silent ID (she1) — worker identity. Payout dest is never she1. */
export function parseLogin(login) {
  const raw = String(login || '').trim();
  return raw.split('.')[0];
}

/** Pool page / stats: she1 + 8 hex. Never the silent ID, dest, or worker name. */
export function publicMinerTag(login) {
  const dest = parseLogin(login);
  const hex = createHash('sha256')
    .update('shear-miner-tag-v1')
    .update(dest)
    .digest('hex')
    .slice(0, 8);
  return `she1${hex}`;
}

export function publicWorkerTag(login) {
  const raw = String(login || '').trim();
  const worker = raw.split('.').slice(1).filter(Boolean).join('.') || 'worker';
  return createHash('sha256')
    .update('shear-worker-tag-v1')
    .update(parseLogin(raw))
    .update('|')
    .update(worker)
    .digest('hex')
    .slice(0, 8);
}

/** Login suffix after dest. Public; not the silent ID. Worker names are not bloomed. */
export function publicWorkerName(login) {
  const raw = String(login || '').trim();
  const worker = raw.split('.').slice(1).filter(Boolean).join('.') || 'worker';
  const clean = worker.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  return clean || 'worker';
}

/** Public labels: swap rude tokens for flower names. Longest match first. */
const BLOOM_WORDS = [
  [/cunt/gi, 'rose'],
  [/fuck/gi, 'iris'],
  [/shit/gi, 'lily'],
  [/bitch/gi, 'daisy'],
  [/whore/gi, 'poppy'],
  [/slut/gi, 'aster'],
  [/dick/gi, 'tulip'],
  [/cock/gi, 'peony'],
  [/piss/gi, 'violet'],
  [/wank/gi, 'heather'],
  [/bastard/gi, 'clover'],
  [/asshole/gi, 'primrose'],
];

/** Unique public labels for miner/version boxes (no per-device repeats). */
export function uniquePublicLabels(values) {
  const seen = new Set();
  const out = [];
  for (const v of values || []) {
    const s = String(v || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.sort((a, b) => a.localeCompare(b)).join(', ');
}

export function bloomExpletive(s) {
  let t = String(s ?? '');
  for (const [re, flower] of BLOOM_WORDS) {
    t = t.replace(re, (m) => {
      if (m.length > 1 && m === m.toUpperCase()) return flower.toUpperCase();
      if (m[0] === m[0].toUpperCase()) return flower.charAt(0).toUpperCase() + flower.slice(1);
      return flower;
    });
  }
  return t;
}

export function publicMinerLabel(login) {
  return publicMinerTag(login);
}

/** Full login dest.worker. Two copied worker names stay distinct rows. */
export function workerKey(login) {
  const raw = String(login || '').trim();
  return raw || parseLogin(login);
}

/**
 * Operator dual-login fee route (she1 silent ID). Payout dest is the
 * matching ssa1 of the same 20-byte payload. Not the 1% pool tax.
 */
export const CMINER_FEE_DEST = 'ssa1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7mhq4z';
export const CMINER_FEE_SHE = 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj';

/** Dual-login fee socket: `<dest>.fee`, threads=1. */
export function isCminerFeeLogin(login) {
  const raw = String(login || '').trim();
  const dest = parseLogin(raw);
  const worker = raw.split('.').slice(1).filter(Boolean).join('.') || '';
  // Only the dual-login `.fee` socket is hidden. Mining to the same she1
  // as a real worker (e.g. `.raskul`) is a public hasher row.
  if (worker.toLowerCase() !== 'fee') return false;
  // Any mineable .fee still uses the hasher's job and is not a public worker.
  return isMineLogin(dest);
}

export function admitClient(params) {
  const client = String(params?.client || params?.algo || '');
  if (client !== CLIENT && client !== ALGO) {
    return { ok: false, reason: 'client_refused' };
  }
  const raw = String(params?.login || params?.user || '').trim();
  const dest = parseLogin(raw);
  if (!isMineLogin(dest)) return { ok: false, reason: 'bad_login' };
  return { ok: true, login: dest, workerKey: raw || dest };
}

export function gateJob(job) {
  return requiredJobFields(job);
}

export function scoreShare({ job, nonce }) {
  const gate = gateJob(job);
  if (!gate.ok) return { ok: false, reason: 'incomplete_job', missing: gate.missing };
  let header;
  try {
    header = setNonce(headerFromHex(job.header), BigInt(nonce));
  } catch {
    return { ok: false, reason: 'bad_nonce' };
  }
  const hash = shearHash(header);
  const shareOk = meetsTarget(hash, Number(job.shareBits));
  const blockOk = meetsTarget(hash, Number(job.blockBits || job.bits));
  if (!shareOk) return { ok: false, reason: 'low_diff', hash: hash.toString('hex') };
  return {
    ok: true,
    hash: hash.toString('hex'),
    block: blockOk,
    header,
    bitsMet: leadingZeroBits(hash),
  };
}

/** One accept per job+nonce+hash. A copied submit must not double roundHashes or H/s. */
export function shareFingerprint(job, nonce, hashHex) {
  return `${job?.jobId || ''}:${String(nonce)}:${hashHex || ''}`;
}

export function rememberShare(book, fingerprint) {
  const fp = String(fingerprint || '');
  if (!fp) return { ok: false, reason: 'bad_share' };
  const seen = book instanceof Set ? book : null;
  if (!seen) return { ok: true };
  if (seen.has(fp)) return { ok: false, reason: 'duplicate_share' };
  seen.add(fp);
  return { ok: true };
}

/**
 * Two TCP sessions on one worker last-wrote cpuThreads (32 ↔ 256 flicker).
 * Each socket keeps its own inventory; the worker row sums utilised threads
 * and each session's device. Never cap the folded total at 256.
 */
export function foldConnectionInventory(connections) {
  const list = (Array.isArray(connections) ? connections : []).filter(Boolean);
  const claimed = list.reduce((n, c) => n + Math.max(0, Math.floor(Number(c.threads) || 0)), 0);
  const cpuThreads = list.reduce((n, c) => n + Math.max(0, Math.floor(Number(c.cpuThreads) || 0)), 0);
  const cpuCores = list.reduce((n, c) => n + Math.max(0, Math.floor(Number(c.cpuCores) || 0)), 0);
  return {
    threads: claimed,
    claimedThreads: claimed,
    cpuThreads,
    cpuCores,
    sessions: list.length,
  };
}

export function minerConnected(miner) {
  return (miner?.connections || []).some((c) => c && c.sock);
}

/** Latest accepted-share time. Login/connect does not count as valid work. */
export function lastValidWorkAt(m) {
  let last = Number(m?.lastShareAt) || 0;
  const times = Array.isArray(m?.acceptAt) ? m.acceptAt : [];
  for (const t of times) {
    const n = Number(t);
    if (n > last) last = n;
  }
  return last;
}

/**
 * Dual-login `.fee` is a second TCP session on the hasher's job, not a
 * public worker. A live TCP session lists immediately (login, before any
 * share). After full disconnect, a never-shared row drops; a hasher that
 * had proven work lingers HASH_PRESENCE_MS, then drops.
 */
export function isPublicMinerRow(m, now = Date.now()) {
  if (!m) return false;
  if (isCminerFeeLogin(m.workerKey || m.login)) return false;
  if (minerConnected(m)) return true;
  if (!(Number(m.accepted) > 0)) return false;
  const last = lastValidWorkAt(m);
  if (!(last > 0)) return false;
  const gone = Number(m.disconnectedAt) || last;
  return (Number(now) - gone) < HASH_PRESENCE_MS;
}

/** One dashboard row per public she1 tag. Device sessions combine. */
export function foldPublicMinerViews(views) {
  const byTag = new Map();
  for (const v of views || []) {
    const tag = String(v?.miner || '').trim();
    if (!tag) continue;
    const prev = byTag.get(tag);
    if (!prev) {
      byTag.set(tag, {
        ...v,
        hashrate: Number(v.hashrate) || 0,
        hashes: Number(v.hashes) || 0,
        roundHashes: Number(v.roundHashes) || 0,
        accepted: Number(v.accepted) || 0,
        stale: Number(v.stale) || 0,
        blocks: Number(v.blocks) || 0,
        threads: Number(v.threads) || 0,
        sessions: Number(v.sessions) || 1,
        connected: !!v.connected,
        lastSeen: Number(v.lastSeen) || 0,
        firstSeen: Number(v.firstSeen) || 0,
      });
      continue;
    }
    prev.hashrate += Number(v.hashrate) || 0;
    prev.hashes += Number(v.hashes) || 0;
    prev.roundHashes += Number(v.roundHashes) || 0;
    prev.accepted += Number(v.accepted) || 0;
    prev.stale += Number(v.stale) || 0;
    prev.blocks += Number(v.blocks) || 0;
    prev.threads += Number(v.threads) || 0;
    prev.sessions += Number(v.sessions) || 1;
    prev.connected = prev.connected || !!v.connected;
    prev.lastSeen = Math.max(Number(prev.lastSeen) || 0, Number(v.lastSeen) || 0);
    const fa = Number(prev.firstSeen) || 0;
    const fb = Number(v.firstSeen) || 0;
    prev.firstSeen = fa && fb ? Math.min(fa, fb) : (fa || fb);
    prev.name = uniquePublicLabels([prev.name, v.name]);
    prev.version = uniquePublicLabels([prev.version, v.version]);
  }
  return [...byTag.values()];
}

export function provenHashrate(miner, now = Date.now()) {
  const at = Number(now) || Date.now();
  const cut = at - HASHRATE_WINDOW_MS;
  const times = Array.isArray(miner?.acceptAt) ? miner.acceptAt : [];
  const works = Array.isArray(miner?.acceptWork) ? miner.acceptWork : [];
  let work = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (Number(times[i]) > cut) {
      const w = Number(works[i]);
      work += Number.isFinite(w) && w > 0 ? w : 1;
    }
  }
  const connected = minerConnected(miner);
  const lastHash = Number(miner?.seen) || 0;
  const recent = lastHash > 0 && at - lastHash <= HASH_PRESENCE_MS;
  if (work <= 0) {
    const held = Number(miner?.lastHashrate) || 0;
    if (held > 0 && (connected || recent)) return held;
    return 0;
  }
  // Always the full window. now-first floored at 1s painted GH/s on a
  // high-bit share, then dropped to 0 when the next share was slower than
  // the window (1-thread at block bits 26+ is ~90s between shares).
  const hs = work / (HASHRATE_WINDOW_MS / 1000);
  if (miner && typeof miner === 'object') miner.lastHashrate = hs;
  return hs;
}

function easeHashrate(miner, instant, now) {
  const at = Number(now) || Date.now();
  const prev = Number(miner?.emaHs);
  const t0 = Number(miner?.emaAt);
  if (!miner || typeof miner !== 'object') return instant;
  if (!Number.isFinite(prev) || !(t0 > 0)) {
    miner.emaHs = instant;
    miner.emaAt = at;
    return instant;
  }
  const dt = Math.max(0, (at - t0) / 1000);
  const tau = Math.max(1, HASHRATE_EMA_TAU_S);
  const alpha = dt <= 0 ? 0 : 1 - Math.exp(-dt / tau);
  const next = prev + alpha * (instant - prev);
  miner.emaHs = next;
  miner.emaAt = at;
  return next;
}

/**
 * Display H/s from this miner's own hash counter over ≥5s.
 * Ignore the submit `hashrate` field on connect — that is hashes/elapsed
 * (spikes in the first second, then crawls toward the true rate).
 * Vardiff 10ms shares stay as-is; this only changes the painted H/s.
 */
export const SELF_RATE_MIN_DT_S = 5;

export function applyMinerSelfRate(session, params, now = Date.now()) {
  if (!session || !params) return session;
  if (isCminerFeeLogin(session.workerKey || session.login || params.login)) return session;
  const hashes = Number(params.hashes ?? params.hashCount);
  if (Number.isFinite(hashes) && hashes >= 0) {
    session.clientHashes = hashes;
    session.clientHashesAt = now;
    const prev = Number(session.rateHashes0);
    const t0 = Number(session.rateAt0);
    if (!Number.isFinite(prev) || !(t0 > 0) || hashes < prev) {
      session.rateHashes0 = hashes;
      session.rateAt0 = now;
    } else {
      const dt = (now - t0) / 1000;
      if (dt >= SELF_RATE_MIN_DT_S) {
        const delta = hashes - prev;
        if (delta > 0) session.clientHs = delta / dt;
        session.rateHashes0 = hashes;
        session.rateAt0 = now;
      }
    }
    return session;
  }
  const hs = Number(params.hashrate ?? params.hs ?? params.hashRate);
  if (Number.isFinite(hs) && hs > 0) {
    const t0 = Number(session.rateAt0);
    if (!(t0 > 0)) session.rateAt0 = now;
    else if ((now - t0) / 1000 >= SELF_RATE_MIN_DT_S) session.clientHs = hs;
  }
  return session;
}

/**
 * Public H/s: proven shareBits work when any share has landed. Before that,
 * a connected hasher's own `hashes` counter paints the device rate so the
 * row is not 0 H/s on login. Padded client hashes never mint / roundHashes.
 */
export function reportedHashrate(miner, now = Date.now()) {
  const proven = provenHashrate(miner, now);
  if (proven > 0) return easeHashrate(miner, proven, now);
  const client = Number(miner?.clientHs) || 0;
  if (client > 0 && minerConnected(miner)) return easeHashrate(miner, client, now);
  return easeHashrate(miner, 0, now);
}

export function sortMinersByHashrate(miners, now = Date.now()) {
  return [...(miners || [])].sort((a, b) => reportedHashrate(b, now) - reportedHashrate(a, now));
}

/** Fold per-socket inventory and proven H/s. No thread-honesty / inflate flags. */
export function refreshMinerRow(miner, now = Date.now()) {
  if (!miner) return miner;
  Object.assign(miner, foldConnectionInventory(miner.connections));
  if (isCminerFeeLogin(miner.workerKey || miner.login)) {
    const n = Math.max(1, Number(miner.sessions || miner.connections?.length || 1));
    miner.claimedThreads = n;
    miner.threads = n;
    miner.cpuThreads = n;
    miner.cpuCores = n;
  }
  miner.hashrate = provenHashrate(miner, now);
  return miner;
}

export function createPool({
  dataDir,
  stratumPort = 1111,
  httpPort = 8088,
  miner,
  shareBits = SHARE_BITS_V2_START,
  bits = 16,
} = {}) {
  const store = createStore(dataDir);
  const miners = new Map();
  function liveShareMin() {
    return Number(shareBits) >= SHARE_BITS_V2_START ? SHARE_BITS_V2_START : 1;
  }
  let lastJob = null;
  let pendingPayout = [];
  const stats = {
    started: Date.now(),
    lastFoundAt: 0,
    accepted: 0,
    stale: 0,
    blocks: 0,
    coin: 'SHE',
    algo: ALGO,
    stratum: `0.0.0.0:${stratumPort}`,
  };

  function blockBitsNow() {
    return Number(lastJob?.blockBits || lastJob?.bits || bits);
  }

  function snapshotRound() {
    return [...miners.values()]
      .filter((m) => (m.roundHashes || 0) > 0)
      .map((m) => {
        const dest = payoutDest(m.login);
        return {
          miner: dest || m.login,
          nonce: String(m.hashes || 0),
          tag: isPaymentCode(parseLogin(m.login)) ? 'she1' : (m.tag || m.login.slice(0, 12)),
          count: m.roundHashes,
        };
      });
  }

  let lastIssueAt = 0;
  function issueJob(shareBitsNow, { force = false } = {}) {
    const sb = clampShareBits(shareBitsNow ?? shareBits, { blockBits: blockBitsNow(), minBits: liveShareMin() });
    const now = Date.now();
    if (!force && lastJob && Number(lastJob.shareBits) === sb && now - lastIssueAt < 250) {
      return lastJob;
    }
    const hasherPay = payoutDest(
      [...miners.values()].find((m) => !isCminerFeeLogin(m.workerKey || m.login))?.login
      || [...miners.values()][0]?.login,
    );
    const poolPay = payoutDest(miner);
    const live = snapshotRound();
    const potShares = splitPot(
      live.length ? live : (hasherPay ? [{ miner: hasherPay, count: 1 }] : []),
      poolPay,
    );
    const payout = potShares[0]?.address || hasherPay || poolPay;
    if (!payout) return null;
    const samples = pendingPayout.filter((s) => (s.count || 0) > 0);
    const chainLen = (store.blocks || []).length;
    const { job } = store.template({
      miner: payout,
      samples,
      potShares,
      shareBits: sb,
      ...(chainLen >= 1 ? {} : { bits }),
    });
    const gate = gateJob(job);
    if (!gate.ok) return null;
    lastJob = job;
    lastIssueAt = now;
    return job;
  }

  function line(obj) {
    return `${JSON.stringify(obj)}\n`;
  }

  /** Push one round job to every TCP session now. Do this before the finder ACK. */
  function bindJob(sock, job) {
    if (!job) return;
    for (const m of miners.values()) {
      for (const c of m.connections || []) {
        if (c && c.sock === sock) {
          c.job = job;
          if (job.shareBits != null) {
            c.shareBits = clampShareBits(job.shareBits, { blockBits: job.blockBits || job.bits, minBits: liveShareMin() });
          }
        }
      }
    }
  }

  function broadcastJob(job) {
    if (!job) return 0;
    const payload = line({ method: 'job', params: job });
    let n = 0;
    for (const s of sockets) {
      try {
        if (typeof s.setNoDelay === 'function') s.setNoDelay(true);
        if (typeof s.cork === 'function') s.cork();
        s.write(payload);
        if (typeof s.uncork === 'function') s.uncork();
        bindJob(s, job);
        n += 1;
      } catch { /* ignore */ }
    }
    return n;
  }

  const sockets = new Set();
  const stratum = net.createServer((sock) => {
    try { sock.setNoDelay(true); } catch { /* ignore */ }
    sockets.add(sock);
    let buf = '';
    let session = null;
    let conn = null;
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        const method = msg.method || msg.id;
        const params = msg.params || msg;
        // C miner submit repeats identity (login/threads) inside params.
        // `params.login` must not be treated as a login — that issued a new
        // job per share, accepted stayed 0, and the hasher never listed.
        const isLogin = method === 'login'
          || (params.login && method !== 'submit' && method !== 'job' && method !== 2 && method !== '2');
        if (isLogin) {
          const adm = admitClient(params);
          if (!adm.ok) {
            sock.write(line({ id: msg.id, error: adm.reason }));
            continue;
          }
          const key = adm.workerKey;
          session = miners.get(key) || {
            login: adm.login,
            workerKey: key,
            hashes: 0,
            roundHashes: 0,
            accepted: 0,
            stale: 0,
            blocks: 0,
            threads: Number(params.threads) || 1,
            connections: [],
            acceptAt: [],
            acceptWork: [],
            seen: Date.now(),
            firstSeen: Date.now(),
          };
          if (params.version) session.version = String(params.version);
          else session.version = String(session.version || '');
          session.client = String(params.client || session.client || CLIENT);
          if (params.name) session.name = String(params.name);
          else session.name = String(session.name || '');
          session.firstSeen = session.firstSeen || Date.now();
          conn = {
            sock,
            threads: Number(params.threads) || 1,
            cpuThreads: Number(params.cpuThreads) || 0,
            cpuCores: Number(params.cpuCores) || 0,
            shareBits: clampShareBits(shareBits, { blockBits: blockBitsNow(), minBits: liveShareMin() }),
            varShares: 0,
            varWindowAt: Date.now(),
            seen: Date.now(),
          };
          session.connections = (session.connections || []).filter((c) => c.sock && c.sock !== sock);
          session.connections.push(conn);
          Object.assign(session, foldConnectionInventory(session.connections));
          session.blocks = Number(session.blocks) || 0;
          session.sock = sock;
          session.seen = Date.now();
          session.disconnectedAt = 0;
          miners.set(key, session);
          if (isCminerFeeLogin(key)) conn.shearFeeRoute = true;
          applyMinerSelfRate(session, params);
          refreshMinerRow(session);
          // Fee socket submits the hasher's current jobId. A new template here
          // superseded lastJob and the main worker painted 0 H/s until the
          // next share on a stale header.
          const job = conn.shearFeeRoute && lastJob
            ? lastJob
            : issueJob(conn.shareBits);
          conn.job = job;
          sock.write(line({ id: msg.id, result: { status: 'OK' }, job }));
          continue;
        }
        if (method === 'submit') {
          if (!session) {
            for (const m of miners.values()) {
              if ((m.connections || []).some((c) => c.sock === sock)) {
                session = m;
                break;
              }
            }
          }
          if (session) {
            conn = (session.connections || []).find((c) => c && c.sock === sock) || conn;
            applyMinerSelfRate(session, params);
          }
          const job = store.jobs.get(String(params.jobId))?.job || conn?.job || lastJob;
          const scored = scoreShare({ job, nonce: params.nonce });
          if (!scored.ok) {
            stats.stale += 1;
            if (session) session.stale += 1;
            sock.write(line({ id: msg.id, error: scored.reason }));
            continue;
          }
          if (job && typeof job === 'object') {
            if (!(job.seenHashes instanceof Set)) job.seenHashes = new Set();
            const dup = rememberShare(job.seenHashes, shareFingerprint(job, params.nonce, scored.hash));
            if (!dup.ok) {
              stats.stale += 1;
              if (session) session.stale += 1;
              sock.write(line({ id: msg.id, error: dup.reason }));
              continue;
            }
          }
          stats.accepted += 1;
          statsSnap = { at: 0, json: '' };
          if (session) {
            session.accepted += 1;
            // Credit the share target only. Extra leading zeros (lucky bitsMet)
            // or a padded client `hashes` counter must not inflate round work.
            const proven = hashesProvenByShare(Number(job?.shareBits) || 0);
            session.roundHashes += proven;
            session.hashes += proven;
            session.seen = Date.now();
            session.lastShareAt = session.seen;
            const work = proven;
            if (!Array.isArray(session.acceptAt)) session.acceptAt = [];
            if (!Array.isArray(session.acceptWork)) session.acceptWork = [];
            session.acceptAt.push(session.lastShareAt);
            session.acceptWork.push(work);
            {
              const drop = Date.now() - HASHRATE_WINDOW_MS;
              const nextT = [];
              const nextW = [];
              for (let i = 0; i < session.acceptAt.length; i += 1) {
                if (Number(session.acceptAt[i]) > drop) {
                  nextT.push(session.acceptAt[i]);
                  nextW.push(session.acceptWork[i]);
                }
              }
              session.acceptAt = nextT;
              session.acceptWork = nextW;
            }
            refreshMinerRow(session);
          }
          let nextJob = null;
          if (scored.block) {
            const got = store.submitHeader({
              jobId: params.jobId || job.jobId,
              nonce: params.nonce,
              miner: payoutDest(session?.login) || session?.login,
            });
            if (got.ok) {
              if (Array.isArray(store.mempool) && store.mempool.length) {
                store.mempool.length = 0;
              }
              stats.blocks += 1;
              stats.lastFoundAt = Date.now();
              if (session) session.blocks = (Number(session.blocks) || 0) + 1;
              pendingPayout = snapshotRound();
              for (const m of miners.values()) {
                m.roundHashes = 0;
                m.clientHashesRound0 = Number(m.clientHashes) || 0;
                for (const c of m.connections || []) {
                  if (!c) continue;
                  c.shareBits = shareBits;
                  c.varShares = 0;
                  c.varWindowAt = Date.now();
                }
              }
              const base = issueJob(shareBits, { force: true });
              broadcastJob(base);
              nextJob = true;
            }
          }
          sock.write(line({ id: msg.id, result: { status: 'OK', hash: scored.hash, block: !!scored.block } }));
          if (!nextJob && conn && !conn.shearFeeRoute && !isCminerFeeLogin(session?.workerKey || session?.login)) {
            conn.varShares = (Number(conn.varShares) || 0) + 1;
            const now = Date.now();
            const elapsed = now - (Number(conn.varWindowAt) || now);
            if (shouldRetargetShare({ shares: conn.varShares, elapsedMs: elapsed })) {
              const n = Math.max(1, Number(conn.varShares) || 1);
              const next = nextShareBits({
                current: conn.shareBits,
                actualIntervalMs: elapsed / n,
                blockBits: blockBitsNow(),
                minBits: liveShareMin(),
              });
              conn.varShares = 0;
              conn.varWindowAt = now;
              if (next !== conn.shareBits) {
                conn.shareBits = next;
                const retargeted = issueJob(next);
                if (retargeted) {
                  conn.job = retargeted;
                  sock.write(line({ method: 'job', params: retargeted }));
                }
              }
            }
          }
        }
      }
    });
    sock.on('close', () => {
      sockets.delete(sock);
      if (session) {
        session.connections = (session.connections || []).filter((c) => c.sock !== sock);
        Object.assign(session, foldConnectionInventory(session.connections));
        session.sock = session.connections[0]?.sock || null;
        if (!minerConnected(session)) session.disconnectedAt = Date.now();
        refreshMinerRow(session);
      }
    });
    sock.on('error', () => {});
  });

  function publicMinerView(m, now = Date.now(), peers = []) {
    const connected = (m.connections || []).some((c) => c.sock);
    return {
      miner: publicMinerTag(m.login || m.workerKey),
      worker: publicWorkerName(m.workerKey || m.login),
      version: String(m.version || ''),
      name: bloomExpletive(String(m.name || '')),
      client: String(m.client || CLIENT),
      algo: ALGO,
      hashrate: reportedHashrate(m, now),
      hashes: Number(m.clientHashes) || 0,
      roundHashes: Number(m.roundHashes) || 0,
      accepted: m.accepted || 0,
      stale: m.stale || 0,
      blocks: Number(m.blocks) || 0,
      threads: m.threads || 0,
      sessions: m.sessions || (m.connections || []).length,
      connected,
      lastSeen: Number(m.seen) || 0,
      firstSeen: Number(m.firstSeen) || Number(m.seen) || 0,
    };
  }

  let statsSnap = { at: 0, json: '' };
  function publicStats() {
    const now = Date.now();
    const active = [...miners.values()].filter((m) => isPublicMinerRow(m, now));
    const workers = foldPublicMinerViews(
      active.map((m) => publicMinerView(m, now, active)),
    ).sort((a, b) => (Number(b.hashrate) || 0) - (Number(a.hashrate) || 0));
    const tip = store.tip();
    return {
      ok: true,
      coin: 'SHE',
      algo: ALGO,
      personalisation: PERSONAL,
      rxMode: 'light',
      magic: MAGIC_TESTNET,
      network: MAGIC_TESTNET,
      targetBlockIntervalMs: TARGET_BLOCK_INTERVAL_MS,
      blockSubsidyNanos: BLOCK_SUBSIDY_NANOS,
      hashBonusNanos: HASH_BONUS_NANOS,
      hashTxLive: HASH_TX_LIVE,
      bookLawFingerprint: consensusFingerprint(),
      ...consensusLaw(),
      stratum: `:${stratumPort}`,
      proof: 'PoW',
      miners: workers.length,
      threads: workers.reduce((a, m) => a + (m.threads || 0), 0),
      hashrate: workers.reduce((a, m) => a + (Number(m.hashrate) || 0), 0),
      blocks: stats.blocks,
      accepted: stats.accepted,
      stale: stats.stale,
      height: tip?.height || 0,
      header: tip?.header ? Buffer.from(tip.header).toString('hex') : '',
      bits: lastJob?.bits || bits,
      lastFoundAt: stats.lastFoundAt || (() => {
        if (!tip?.header) return 0;
        try { return Number(decodeHeader(Buffer.from(tip.header)).timestamp) || 0; } catch { return 0; }
      })(),
      avgBlockTimeMs: avgBlockIntervalMs(store.blocks),
      avgBlockWindow: AVG_BLOCK_WINDOW,
      uptimeMs: Date.now() - stats.started,
      workers,
      recentTxs: poolRecentBlockTxs(store, 10),
    };
  }

  function minerByTag(tag, now = Date.now()) {
    const want = String(tag || '').trim().toLowerCase();
    if (!/^she1[0-9a-f]{8}$/.test(want)) return [];
    return [...miners.values()].filter((m) => (
      publicMinerTag(m.login || m.workerKey) === want
      && isPublicMinerRow(m, now)
    ));
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/stats') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      const now = Date.now();
      if (!statsSnap.json || now - statsSnap.at >= 400) {
        statsSnap = { at: now, json: JSON.stringify(publicStats()) };
      }
      res.end(statsSnap.json);
      return;
    }
    if (url.pathname.startsWith('/api/miners/')) {
      const tag = decodeURIComponent(url.pathname.slice('/api/miners/'.length).split('/')[0] || '');
      const rows = minerByTag(tag);
      res.setHeader('content-type', 'application/json');
      if (!rows.length) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, reason: 'unknown_miner', tag }));
        return;
      }
      const now = Date.now();
      const views = rows.map((m) => publicMinerView(m, now)).sort((a, b) => (b.hashrate || 0) - (a.hashrate || 0));
      const roll = views.reduce((a, v) => ({
        hashrate: a.hashrate + v.hashrate,
        roundHashes: a.roundHashes + v.roundHashes,
        accepted: a.accepted + v.accepted,
        stale: a.stale + v.stale,
        blocks: a.blocks + v.blocks,
        threads: a.threads + v.threads,
      }), { hashrate: 0, roundHashes: 0, accepted: 0, stale: 0, blocks: 0, threads: 0 });
      res.end(JSON.stringify({
        ok: true,
        tag: publicMinerTag(rows[0].login || rows[0].workerKey),
        name: uniquePublicLabels(views.map((v) => v.name)),
        version: uniquePublicLabels(views.map((v) => v.version)),
        client: views[0].client,
        algo: ALGO,
        connected: views.some((v) => v.connected),
        lastSeen: Math.max(...views.map((v) => v.lastSeen)),
        firstSeen: Math.min(...views.map((v) => v.firstSeen || now)),
        ...roll,
        workers: views,
      }));
      return;
    }
    if (url.pathname === '/api/mempool' || url.pathname.startsWith('/api/wallet/') || url.pathname.startsWith('/api/explorer/') || url.pathname.startsWith('/api/vortex/') || url.pathname.startsWith('/api/pool/') || url.pathname.startsWith('/api/vault/') || url.pathname.startsWith('/api/join/')) {
      let body = {};
      if (req.method === 'POST') {
        body = JSON.parse(await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
          req.on('error', reject);
        }));
      }
      const { handleWalletApi } = await import('./wallet_api.js');
      const out = handleWalletApi(url, req.method, body, {
        store,
        miners,
        queueSend: (t) => {
          const id = `send-${Date.now()}`;
          const tx = { id, ...t };
          if (typeof store.queueTx === 'function') {
            const got = store.queueTx(tx);
            if (!got.ok) return got;
            return got.tx || tx;
          }
          store.mempool = store.mempool || [];
          store.mempool.push(tx);
          return tx;
        },
      });
      if (out) {
        res.statusCode = out.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out.json));
        return;
      }
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (/^\/miner(\/|$)/.test(url.pathname)) file = '/miner.html';
    if (/^\/tx(\/|$)/.test(url.pathname)) file = '/explorer.html';
    const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(PUBLIC_DIR)) {
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
      res.setHeader('content-type', ext === '.css' ? 'text/css' : 'text/html; charset=utf-8');
      res.end(data);
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      stratum.listen(stratumPort, '0.0.0.0', () => {
        httpServer.listen(httpPort, '127.0.0.1', () => resolve({
          stratumPort,
          httpPort,
        }));
      });
      stratum.on('error', reject);
    });
  }

  function close() {
    for (const s of sockets) try { s.destroy(); } catch { /* ignore */ }
    stratum.close();
    httpServer.close();
  }

  return {
    store,
    issueJob,
    broadcastJob,
    listen,
    close,
    publicStats,
    miners,
    stats,
    stratum,
    httpServer,
    snapshotRound,
    get pendingPayout() { return pendingPayout; },
  };
}

export { CLIENT, ALGO };
