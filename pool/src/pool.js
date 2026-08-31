import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { requiredJobFields, decodeHeader, encodeHeader, headerFromHex, setNonce } from '../../crypto/header.js';
import { shearHash, meetsTarget, leadingZeroBits, ALGO, CLIENT, PERSONAL } from '../../crypto/shear_hash.js';
import { isMineLogin, isPaymentCode, payoutDest } from '../../crypto/address.js';
import {
  BLOCK_SUBSIDY_NANOS,
  POOL_FEE_BPS,
  MAGIC_TESTNET,
  TARGET_BLOCK_INTERVAL_MS,
  HASH_BONUS_NANOS,
  HASH_TX_LIVE,
  bitsForBlock,
  consensusFingerprint,
  consensusLaw,
  formatShe,
  NANOS_PER_SHE,
  SPENDABLE_CONFIRMATIONS,
} from '../../crypto/asert.js';
import { poolFeeDest, levyNanos, mempoolDepthBytes, poolWithdrawTx, verifyPoolWithdrawOffchain, containsShe1 } from '../../crypto/levy.js';
import { isAdminHost, handleAdminHttp, createAdmin } from './admin.js';
import { createPullBook, PULL_COOLDOWN_MS } from './pull_book.js';
import { createStore } from '../../node/src/store.js';
import { poolRecentBlockTxs, networkSupply } from './wallet_api.js';
import { hasherHasValidRoundShare, roundActualHashes } from './hash_credit.js';
import {
  clampShareBits,
  hashesProvenByShare,
  nextShareBits,
  shouldRetargetShare,
  SHARE_BITS_V2_START,
} from './share_vardiff.js';

export { hasherHasValidRoundShare, roundActualHashes };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, '../public');
/** Public H/s is proven hashes in this window, not lifetime hashes / first-seen. */
export const HASHRATE_WINDOW_MS = 180_000;
/** Display H/s eases toward the hasher's own rate. 60s tau: ~63% at 1 min, ~95% at 3 min. */
export const HASHRATE_EMA_TAU_S = 60;
/** After the last socket closes, keep the row this long. Still-connected hashers with proven shares stay listed (header bits can put shares >12s apart). */
export const HASH_PRESENCE_MS = 12_000;
/** Default is every sealed header. Pass a finite window to clip a test. */
export const AVG_BLOCK_WINDOW = Infinity;
/** Re-stamp the live job this often so sealed header time tracks wall clock. */
export const JOB_RESTAMP_MS = 10_000;
/** Keep this many prior restamp headers per job so in-flight shares still verify. */
export const JOB_HEADER_HISTORY = 12;
/** After the tip moves, accept the previous job this long without new-round credit. */
export const PREV_JOB_GRACE_MS = 3_000;
/** Hold last positive self-rate this long across a RandomX cache pause. */
export const HASHRATE_STALL_HOLD_MS = 90_000;
/** Rebuild /api/stats JSON on this cadence. The HTTP handler never computes it. */
export const STATS_REFRESH_MS = 400;
const HASH_WORKER = fileURLToPath(new URL('./hash_worker.js', import.meta.url));
const HASH_WORKER_TIMEOUT_MS = 15_000;
/** Cap in-flight RandomX verifies so a junk submit flood cannot stall HTTP. */
export const HASH_QUEUE_MAX = 16;
/** One hasher cannot fill the verify queue. Small miners still get a slot. */
export const HASH_INFLIGHT_PER_CONN = 2;

/**
 * Mean interval of consecutive sealed headers. Default is every block on
 * the book, not only the last pair and not a sliding window of 20.
 * Non-positive gaps (stale/frozen stamps) are skipped.
 */
export function avgBlockIntervalMs(blocks, windowBlocks = AVG_BLOCK_WINDOW) {
  const list = Array.isArray(blocks) ? blocks : [];
  let window = list;
  if (Number.isFinite(Number(windowBlocks)) && Number(windowBlocks) > 0) {
    const keep = Math.max(2, Math.floor(Number(windowBlocks)));
    if (list.length > keep) window = list.slice(-keep);
  }
  if (window.length < 2) return null;
  const times = [];
  for (const b of window) {
    try {
      const ts = Number(decodeHeader(Buffer.from(b.header)).timestamp);
      if (Number.isFinite(ts) && ts > 0) times.push(ts);
    } catch { /* skip a bad header */ }
  }
  if (times.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < times.length; i += 1) {
    const dt = times[i] - times[i - 1];
    if (!Number.isFinite(dt) || dt <= 0) continue;
    sum += dt;
    n += 1;
  }
  if (!n) return null;
  return sum / n;
}

/** 1 SHE pot split by proven work this round. 1% of the pot may go to the pool dest. */
export function splitPot(round, poolDest) {
  const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
  const rest = BLOCK_SUBSIDY_NANOS - fee;
  const pay = payoutDest(poolDest);
  const out = [];
  if (pay && rest > 0) out.push({ address: pay, nanos: rest, kind: 'pot' });
  const feeAddr = poolFeeDest();
  if (fee > 0 && feeAddr) out.push({ address: feeAddr, nanos: fee, kind: 'pool-fee' });
  if (!out.length && pay) out.push({ address: pay, nanos: BLOCK_SUBSIDY_NANOS, kind: 'pot' });
  void round;
  return out.filter((s) => s.nanos > 0);
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

export const SHEARK_MINER_NAME = 'ShearK-Miner';

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

/** ShearHash-v2 digest the miner claims. Empty if they did not compute the algo. */
export function submittedShareDigest(params) {
  const h = String(params?.hash || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : '';
}

export function gateJob(job) {
  return requiredJobFields(job);
}

export function prepareShareHeader({ job, nonce, headerHex } = {}) {
  const gate = gateJob(job);
  if (!gate.ok) return { ok: false, reason: 'incomplete_job', missing: gate.missing };
  try {
    return { ok: true, header: setNonce(headerFromHex(headerHex || job.header), BigInt(nonce)) };
  } catch {
    return { ok: false, reason: 'bad_nonce' };
  }
}

/** Push an outgoing header onto the job before a restamp overwrites it. */
export function rememberJobHeader(job, outgoingHex) {
  if (!job || typeof job !== 'object') return job;
  const hex = String(outgoingHex || '').toLowerCase();
  if (!hex) return job;
  if (!Array.isArray(job.headerHistory)) job.headerHistory = [];
  if (!job.headerHistory.includes(hex)) {
    job.headerHistory.unshift(hex);
    if (job.headerHistory.length > JOB_HEADER_HISTORY) job.headerHistory.length = JOB_HEADER_HISTORY;
  }
  return job;
}

/** Current header first, then prior restamps of the same job. */
export function candidateShareHeaders(job) {
  const out = [];
  const seen = new Set();
  const hist = Array.isArray(job?.headerHistory) ? job.headerHistory : [];
  for (const h of [job?.header, ...hist]) {
    const hex = String(h || '').toLowerCase();
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

/** Only a job that is no longer live (and outside grace) is stale. */
export function isStaleReject(reason) {
  const r = String(reason || '');
  return r === 'stale_job' || r === 'stale';
}

export function jobWithinGrace(job, prevJob, prevJobAt, now = Date.now()) {
  if (!job || !prevJob) return false;
  if (String(job.jobId) !== String(prevJob.jobId)) return false;
  const at = Number(prevJobAt) || 0;
  return at > 0 && (Number(now) - at) < PREV_JOB_GRACE_MS;
}

export function judgeShare({ job, header, hash }) {
  const current = Number(job.shareBits);
  const prev = Number(job.shareBitsPrev);
  const prevAt = Number(job.shareBitsAt) || 0;
  const now = Date.now();
  const blockOk = meetsTarget(hash, Number(job.blockBits || job.bits));
  let creditedShareBits = 0;
  if (meetsTarget(hash, current)) creditedShareBits = current;
  else if (Number.isFinite(prev) && prev > 0 && now - prevAt < 8000 && meetsTarget(hash, prev)) {
    creditedShareBits = prev;
  } else {
    return { ok: false, reason: 'low_diff', hash: hash.toString('hex') };
  }
  return {
    ok: true,
    hash: hash.toString('hex'),
    block: blockOk,
    header,
    bitsMet: leadingZeroBits(hash),
    creditedShareBits,
  };
}

/** Sync path for tests. Live submits use the RandomX worker so HTTP cannot stall. */
export function scoreShare({ job, nonce, claimed } = {}) {
  const want = claimed ? String(claimed).toLowerCase() : '';
  const headers = candidateShareHeaders(job);
  const list = headers.length ? headers : [job?.header];
  let last = { ok: false, reason: 'incomplete_job' };
  for (const headerHex of list) {
    const prep = prepareShareHeader({ job, nonce, headerHex });
    if (!prep.ok) {
      last = prep;
      continue;
    }
    const hash = shearHash(prep.header);
    const hex = hash.toString('hex');
    if (want && hex !== want) {
      last = { ok: false, reason: 'bad_hash', hash: hex };
      continue;
    }
    const judged = judgeShare({ job, header: prep.header, hash });
    if (judged.ok) return judged;
    last = judged;
  }
  return last;
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

function easeHashrate(miner, instant, now, tauS = HASHRATE_EMA_TAU_S) {
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
  const tau = Math.max(1, Number(tauS) || HASHRATE_EMA_TAU_S);
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
export const SELF_RATE_MIN_DT_S = 2;

export function applyMinerSelfRate(session, params, now = Date.now()) {
  if (!session || !params) return session;
  if (isCminerFeeLogin(session.workerKey || session.login || params.login)) return session;
  const hashes = Number(params.hashes ?? params.hashCount);
  if (Number.isFinite(hashes) && hashes >= 0) {
    session.clientHashes = hashes;
    session.clientHashesAt = now;
    if (!Number.isFinite(Number(session.clientHashesRound0))) session.clientHashesRound0 = hashes;
    if (hashes < Number(session.clientHashesRound0)) session.clientHashesRound0 = hashes;
    const prev = Number(session.rateHashes0);
    const t0 = Number(session.rateAt0);
    if (!Number.isFinite(prev) || !(t0 > 0) || hashes < prev) {
      session.rateHashes0 = hashes;
      session.rateAt0 = now;
    } else {
      const dt = (now - t0) / 1000;
      if (dt >= SELF_RATE_MIN_DT_S) {
        const delta = hashes - prev;
        if (delta > 0) {
          session.clientHs = delta / dt;
          session.rateHashes0 = hashes;
          session.rateAt0 = now;
        } else if (dt >= 8) {
          session.rateHashes0 = hashes;
          session.rateAt0 = now;
        }
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
 * Public H/s for a connected hasher is that miner's own hash counter
 * (hashes delta / time). Proven shareBits work still mints / roundHashes.
 * Disconnected rows fall back to proven so the 12s linger is not a fake H/s.
 */
/** Instant H/s for the operator desk. Not the public 90s ease. */
export function liveHashrate(miner, now = Date.now()) {
  if (minerConnected(miner)) {
    const client = Number(miner?.clientHs) || 0;
    if (client > 0) return client;
  }
  return provenHashrate(miner, now);
}

export function reportedHashrate(miner, now = Date.now()) {
  const at = Number(now) || Date.now();
  if (minerConnected(miner)) {
    const client = Number(miner?.clientHs) || 0;
    if (client > 0) {
      miner.lastPositiveHs = client;
      miner.lastPositiveAt = at;
      return easeHashrate(miner, client, at, HASHRATE_EMA_TAU_S);
    }
    const held = Number(miner?.lastPositiveHs) || 0;
    const heldAt = Number(miner?.lastPositiveAt) || Number(miner?.emaAt) || 0;
    if (held > 0 && heldAt > 0 && (at - heldAt) <= HASHRATE_STALL_HOLD_MS) {
      return easeHashrate(miner, held, at, HASHRATE_EMA_TAU_S);
    }
  }
  return easeHashrate(miner, provenHashrate(miner, at), at);
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

/** Operator table on kyrusfables. Dest + workerKey stay off the public pool page. */
export function adminMinerView(m, now = Date.now()) {
  const connected = minerConnected(m);
  const bits = [];
  for (const c of m?.connections || []) {
    const n = Number(c?.shareBits);
    if (Number.isFinite(n) && n > 0) bits.push(n);
  }
  return {
    tag: publicMinerTag(m?.login || m?.workerKey),
    worker: publicWorkerName(m?.workerKey || m?.login),
    dest: parseLogin(m?.login || m?.workerKey),
    workerKey: String(m?.workerKey || m?.login || ''),
    version: String(m?.version || ''),
    name: String(m?.name || ''),
    client: String(m?.client || CLIENT),
    hashrate: liveHashrate(m, now),
    hashrateEased: reportedHashrate(m, now),
    hashes: roundActualHashes(m),
    roundHashes: roundActualHashes(m),
    provenHashes: Number(m?.roundHashes) || 0,
    accepted: Number(m?.accepted) || 0,
    stale: Number(m?.stale) || 0,
    blocks: Number(m?.blocks) || 0,
    threads: Number(m?.threads) || 0,
    sessions: Number(m?.sessions) || (m?.connections || []).length,
    connected,
    lastSeen: Number(m?.seen) || 0,
    firstSeen: Number(m?.firstSeen) || Number(m?.seen) || 0,
    lastShareAt: lastValidWorkAt(m),
    lastReject: m?.lastReject || null,
    shareBits: bits,
    fee: isCminerFeeLogin(m?.workerKey || m?.login),
  };
}

export function createPool({
  dataDir,
  stratumPort = 1111,
  httpPort = 8088,
  miner,
  shareBits = SHARE_BITS_V2_START,
  bits = 16,
  p2p = null,
  onRestart = null,
  onRestartHasher = null,
} = {}) {
  const store = createStore(dataDir);
  const admin = createAdmin(dataDir);
  const pullBook = createPullBook(dataDir);
  const miners = new Map();
  let p2pNet = p2p;
  let hashWorker = null;
  let hashSeq = 0;
  const hashWait = new Map();
  function bootHashWorker() {
    if (hashWorker) return hashWorker;
    const w = new Worker(HASH_WORKER);
    w.on('message', (msg) => {
      const pending = hashWait.get(msg.id);
      if (!pending) return;
      hashWait.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(Buffer.from(msg.hash));
      else pending.reject(new Error(msg.error || 'hash_failed'));
    });
    const drop = () => {
      hashWorker = null;
      for (const [, p] of hashWait) {
        clearTimeout(p.timer);
        p.reject(new Error('hash_worker_exit'));
      }
      hashWait.clear();
    };
    w.on('error', drop);
    w.on('exit', drop);
    hashWorker = w;
    return w;
  }
  function hashOffThread(header, conn) {
    if (hashWait.size >= HASH_QUEUE_MAX) {
      return Promise.reject(new Error('hash_busy'));
    }
    if (conn && Number(conn.hashInflight) >= HASH_INFLIGHT_PER_CONN) {
      return Promise.reject(new Error('hash_busy'));
    }
    const id = (hashSeq += 1);
    const copy = Buffer.from(header);
    if (conn) conn.hashInflight = (Number(conn.hashInflight) || 0) + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        hashWait.delete(id);
        reject(new Error('hash_timeout'));
      }, HASH_WORKER_TIMEOUT_MS);
      hashWait.set(id, { resolve, reject, timer, conn });
      try {
        bootHashWorker().postMessage({ id, header: copy });
      } catch (e) {
        hashWait.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    }).finally(() => {
      if (conn) conn.hashInflight = Math.max(0, (Number(conn.hashInflight) || 1) - 1);
    });
  }
  async function scoreShareLive({ job, nonce, claimed, conn } = {}) {
    const want = claimed ? String(claimed).toLowerCase() : '';
    const headers = candidateShareHeaders(job);
    const list = headers.length ? headers : [job?.header];
    let last = { ok: false, reason: 'incomplete_job' };
    for (const headerHex of list) {
      const prep = prepareShareHeader({ job, nonce, headerHex });
      if (!prep.ok) {
        last = prep;
        continue;
      }
      const hash = await hashOffThread(prep.header, conn);
      const hex = hash.toString('hex');
      if (want && hex !== want) {
        last = { ok: false, reason: 'bad_hash', hash: hex };
        continue;
      }
      const judged = judgeShare({ job, header: prep.header, hash });
      if (judged.ok) return judged;
      last = judged;
    }
    return last;
  }
  function setP2p(next) { p2pNet = next; }
  function nodesOnline() {
    const n = p2pNet?.syncedOnline?.();
    const v = Number(n);
    return Number.isFinite(v) && v >= 0 ? v : 1;
  }
  function liveShareMin() {
    return Number(shareBits) >= SHARE_BITS_V2_START ? SHARE_BITS_V2_START : 1;
  }
  let lastJob = null;
  let prevJob = null;
  let prevJobAt = 0;
  let pendingPayout = [];
  let sealing = false;
  let paused = false;
  let restarting = false;
  const banPath = path.join(dataDir, 'pool-bans.json');
  function loadBans() {
    try {
      const j = JSON.parse(fs.readFileSync(banPath, 'utf8'));
      return new Set((Array.isArray(j?.bans) ? j.bans : []).map(String));
    } catch {
      return new Set();
    }
  }
  let bans = loadBans();
  function saveBans() {
    fs.writeFileSync(banPath, JSON.stringify({ bans: [...bans] }), { mode: 0o600 });
  }
  function isBanned(key) {
    const raw = String(key || '');
    if (!raw) return false;
    const dest = parseLogin(raw);
    const tag = publicMinerTag(raw);
    return bans.has(raw) || bans.has(dest) || bans.has(tag);
  }
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
          count: roundActualHashes(m),
          proven: Number(m.roundHashes) || 0,
        };
      });
  }

  let lastIssueAt = 0;
  function resetOpenRound() {
    if (paused) return lastJob;
    pendingPayout = [];
    for (const m of miners.values()) {
      m.roundHashes = 0;
      m.clientHashesRound0 = Number(m.clientHashes) || 0;
      // never zero accepted / stale here — listing and linger use accepted.
      for (const c of m.connections || []) {
        if (!c) continue;
        c.varShares = 0;
        c.varWindowAt = Date.now();
      }
    }
    const job = issueJob(shareBits, { force: true });
    broadcastJob(job);
    return job;
  }

  if (typeof store.on === 'function') {
    store.on('reorg', () => {
      if (sealing) return;
      resetOpenRound();
    });
    store.on('tip', (t) => {
      if (sealing || t?.reorg) return;
      const tipHash = store.tip()
        ? Buffer.from(store.tip().hash).toString('hex')
        : '';
      if (lastJob && String(lastJob.prevBlockHash) === tipHash) return;
      resetOpenRound();
    });
  }

  function issueJob(shareBitsNow, { force = false } = {}) {
    const sb = clampShareBits(shareBitsNow ?? shareBits, { blockBits: blockBitsNow(), minBits: liveShareMin() });
    const now = Date.now();
    const liveBits = blockBitsNow();
    const tipNow = store.tip();
    const tipHash = tipNow
      ? (Buffer.isBuffer(tipNow.hash) ? tipNow.hash.toString('hex') : String(tipNow.hash))
      : '';
    const jobPrev = String(lastJob?.prevBlockHash || '');
    const parentOk = !tipHash || jobPrev === tipHash;
    if (!force && lastJob && parentOk && Number(lastJob.blockBits || lastJob.bits) === liveBits) {
      lastIssueAt = now;
      if (Number(lastJob.shareBits) === sb) return lastJob;
      const job = {
        ...lastJob,
        shareBitsPrev: Number(lastJob.shareBits),
        shareBitsAt: now,
        shareBits: sb,
      };
      return job;
    }
    const hasherPay = payoutDest(
      [...miners.values()].find((m) => !isCminerFeeLogin(m.workerKey || m.login))?.login
      || [...miners.values()][0]?.login,
    );
    const poolPay = payoutDest(miner);
    const live = snapshotRound();
    const potRows = live.map((s) => ({ miner: s.miner, count: Number(s.proven) || 0 })).filter((s) => s.count > 0);
    const potShares = splitPot(
      potRows.length ? potRows : (hasherPay ? [{ miner: hasherPay, count: 1 }] : []),
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
    if (lastJob && String(lastJob.jobId) !== String(job.jobId)) {
      prevJob = lastJob;
      prevJobAt = now;
    }
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

  function broadcastJob(job, { force = false } = {}) {
    if (!job) return 0;
    if (paused && !force) return 0;
    let n = 0;
    for (const m of miners.values()) {
      for (const c of m.connections || []) {
        if (!c || !c.sock) continue;
        const sb = clampShareBits(
          c.shareBits != null ? c.shareBits : job.shareBits,
          { blockBits: job.blockBits || job.bits, minBits: liveShareMin() },
        );
        c.shareBits = sb;
        const payload = { ...job, shareBits: sb };
        c.job = payload;
        try {
          if (typeof c.sock.setNoDelay === 'function') c.sock.setNoDelay(true);
          c.sock.write(line({ method: 'job', params: payload }));
          n += 1;
        } catch { /* ignore */ }
      }
    }
    return n;
  }

  /**
   * Re-stamp header time from wall clock so sealed times match find time.
   * Do not rebuild merkle/continuity/bits — those are in RandomX K, and a new
   * K on every restamp rebinds the dataset and paints a hashrate dip.
   * If ASERT would move bits, keep the live template (miners stay on the same K).
   */
  let lastEaseAt = Date.now();
  let restampTimer = null;
  function restampLiveHeader(now = Date.now()) {
    if (!lastJob?.header) return lastJob;
    let decoded;
    try {
      decoded = decodeHeader(headerFromHex(lastJob.header));
    } catch {
      return lastJob;
    }
    // Keep live bits (they are in RandomX K). Always tick timestamp so ASERT
    // sees wall-clock intervals. Skipping the stamp froze time and bits climbed.
    const header = encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: decoded.merkleRoot,
      continuityRoot: decoded.continuityRoot,
      timestamp: BigInt(now),
      bits: decoded.bits,
      nonce: 0n,
      baseFee: decoded.baseFee,
    });
    const hex = header.toString('hex');
    rememberJobHeader(lastJob, lastJob.header);
    lastJob = {
      ...lastJob,
      header: hex,
      timestamp: String(now),
    };
    const rec = store.jobs.get(String(lastJob.jobId));
    if (rec) {
      rec.tpl = { ...rec.tpl, header };
      rec.job = lastJob;
    }
    return lastJob;
  }
  function maybeRestampJob() {
    if (paused) return lastJob;
    if (!lastJob) return lastJob;
    const now = Date.now();
    const jobTs = Number(lastJob.timestamp) || 0;
    if (jobTs > 0 && (now - jobTs) < JOB_RESTAMP_MS && (now - lastEaseAt) < JOB_RESTAMP_MS) {
      return lastJob;
    }
    lastEaseAt = now;
    const before = lastJob.header;
    const job = restampLiveHeader(now);
    if (job && job.header !== before) broadcastJob(job);
    return job;
  }

  function resolveSubmitJob(params, conn) {
    const id = String(params?.jobId || '');
    const byId = id ? store.jobs.get(id)?.job : null;
    const liveId = String(lastJob?.jobId || '');
    if (byId && String(byId.jobId) === liveId) {
      return { job: byId, closedRound: false, stale: false };
    }
    if (byId && jobWithinGrace(byId, prevJob, prevJobAt)) {
      return { job: byId, closedRound: true, stale: false };
    }
    if (prevJob && id && id === String(prevJob.jobId) && jobWithinGrace(prevJob, prevJob, prevJobAt)) {
      return { job: prevJob, closedRound: true, stale: false };
    }
    if (id && liveId && id !== liveId) {
      return { job: byId || conn?.job || lastJob, closedRound: false, stale: true };
    }
    return { job: byId || conn?.job || lastJob, closedRound: false, stale: false };
  }

  function paintReject(session, reason) {
    if (session) session.lastReject = { reason: String(reason || ''), at: Date.now() };
    if (isStaleReject(reason)) {
      stats.stale += 1;
      if (session) session.stale += 1;
    }
  }

  async function acceptSubmit({ sock, session, conn, params, msg, job: passed }) {
    if (paused) {
      paintReject(session, 'paused');
      try { sock.write(line({ id: msg.id, error: 'paused' })); } catch { /* ignore */ }
      return;
    }
    const claimed = submittedShareDigest(params);
    if (!claimed) {
      try { sock.write(line({ id: msg.id, error: 'need_hash' })); } catch { /* ignore */ }
      return;
    }
    const resolved = resolveSubmitJob(params, conn);
    const job = resolved.job || passed;
    if (resolved.stale) {
      paintReject(session, 'stale_job');
      try { sock.write(line({ id: msg.id, error: 'stale_job' })); } catch { /* ignore */ }
      return;
    }
    const closedRound = !!resolved.closedRound;
    let scored;
    try {
      scored = await scoreShareLive({ job, nonce: params.nonce, claimed, conn });
    } catch (e) {
      const reason = String(e?.message || e) === 'hash_busy' ? 'busy' : 'hash_failed';
      try { sock.write(line({ id: msg.id, error: reason })); } catch { /* ignore */ }
      return;
    }
    if (!scored.ok) {
      paintReject(session, scored.reason);
      try { sock.write(line({ id: msg.id, error: scored.reason })); } catch { /* ignore */ }
      return;
    }
    if (scored.hash !== claimed) {
      paintReject(session, 'bad_hash');
      try { sock.write(line({ id: msg.id, error: 'bad_hash' })); } catch { /* ignore */ }
      return;
    }
    if (job && typeof job === 'object') {
      if (!(job.seenHashes instanceof Set)) job.seenHashes = new Set();
      const dup = rememberShare(job.seenHashes, shareFingerprint(job, params.nonce, scored.hash));
      if (!dup.ok) {
        paintReject(session, dup.reason);
        try { sock.write(line({ id: msg.id, error: dup.reason })); } catch { /* ignore */ }
        return;
      }
    }
    stats.accepted += 1;
    if (session) {
      session.accepted += 1;
      const proven = hashesProvenByShare(Number(scored.creditedShareBits || job?.shareBits) || 0);
      if (!closedRound) {
        session.roundHashes += proven;
        session.hashes += proven;
      }
      session.seen = Date.now();
      session.lastShareAt = session.seen;
      if (!closedRound) {
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
      }
      refreshMinerRow(session);
    }
    let nextJob = null;
    if (scored.block && !closedRound) {
      sealing = true;
      const jid = String(params.jobId || job.jobId || '');
      const rec = jid ? store.jobs.get(jid) : null;
      if (rec && scored.header) rec.tpl = { ...rec.tpl, header: scored.header };
      const got = await Promise.resolve(store.submitHeader({
        jobId: jid,
        nonce: params.nonce,
        miner: payoutDest(session?.login) || session?.login,
      }));
      sealing = false;
      if (got.ok) {
        if (Array.isArray(store.mempool) && store.mempool.length) {
          store.mempool.length = 0;
        }
        stats.blocks += 1;
        try {
          const sealed = store.tip();
          stats.lastFoundAt = sealed?.header
            ? (Number(decodeHeader(Buffer.from(sealed.header)).timestamp) || Date.now())
            : Date.now();
          pullBook.creditRound(
            [...miners.values()]
              .filter((m) => (Number(m.roundHashes) || 0) > 0 && !isCminerFeeLogin(m.login || m.workerKey))
              .map((m) => ({
                tag: publicMinerTag(m.login || m.workerKey),
                dest: payoutDest(m.login) || m.login,
                count: roundActualHashes(m),
              })),
            { height: Number(sealed?.height || 0) },
          );
        } catch {
          stats.lastFoundAt = Date.now();
        }
        if (session) session.blocks = (Number(session.blocks) || 0) + 1;
        pendingPayout = snapshotRound();
        for (const m of miners.values()) {
          m.roundHashes = 0;
          m.clientHashesRound0 = Number(m.clientHashes) || 0;
          for (const c of m.connections || []) {
            if (!c) continue;
            c.varShares = 0;
            c.varWindowAt = Date.now();
          }
        }
        const base = issueJob(shareBits, { force: true });
        broadcastJob(base);
        nextJob = true;
      }
    }
    try { sock.write(line({ id: msg.id, result: { status: 'OK', hash: scored.hash, block: !!scored.block } })); } catch { /* ignore */ }
    paintStatsSnap();
    if (!paused && !nextJob && !closedRound && conn && !conn.shearFeeRoute && !isCminerFeeLogin(session?.workerKey || session?.login)) {
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
            try { sock.write(line({ method: 'job', params: retargeted })); } catch { /* ignore */ }
          }
        }
      }
    }
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
          || (params.login && method !== 'submit' && method !== 'job' && method !== 'stats'
            && method !== 2 && method !== '2');
        if (isLogin) {
          const adm = admitClient(params);
          if (!adm.ok) {
            sock.write(line({ id: msg.id, error: adm.reason }));
            continue;
          }
          if (isBanned(adm.workerKey) || isBanned(adm.login)) {
            sock.write(line({ id: msg.id, error: 'banned' }));
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
        if (method === 'stats') {
          if (session) applyMinerSelfRate(session, params);
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
          const captured = { sock, session, conn, params, msg, job };
          void acceptSubmit(captured);
          continue;
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
      hashes: roundActualHashes(m),
      roundHashes: roundActualHashes(m),
      provenHashes: Number(m.roundHashes) || 0,
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

  let statsSnap = { at: 0, json: '{"ok":true}' };
  let statsTimer = null;
  function paintStatsSnap() {
    try {
      statsSnap = { at: Date.now(), json: JSON.stringify(publicStats()) };
    } catch {
      if (!statsSnap.json) statsSnap = { at: Date.now(), json: '{"ok":true}' };
    }
  }
  function publicStats() {
    const now = Date.now();
    const active = [...miners.values()].filter((m) => isPublicMinerRow(m, now));
    const workers = foldPublicMinerViews(
      active.map((m) => publicMinerView(m, now, active)),
    ).sort((a, b) => (Number(b.hashrate) || 0) - (Number(a.hashrate) || 0));
    const tip = store.tip();
    const avgMs = avgBlockIntervalMs(store.blocks);
    const supply = networkSupply(store);
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
      hashBonusNanos: store.reserveVault?.liveHashBonusNanos || HASH_BONUS_NANOS,
      hashTxLive: HASH_TX_LIVE,
      bookLawFingerprint: consensusFingerprint(),
      ...consensusLaw(),
      policy: typeof store.getpolicy === 'function' ? store.getpolicy() : undefined,
      frozen: typeof store.getpolicy === 'function' ? !!store.getpolicy().frozen : false,
      confirmedNeed: typeof store.getpolicy === 'function'
        ? (store.getpolicy().operational?.pool_merchant || 30)
        : 30,
      stratum: `:${stratumPort}`,
      proof: 'PoW',
      miners: workers.length,
      threads: workers.reduce((a, m) => a + (m.threads || 0), 0),
      hashrate: workers.reduce((a, m) => a + (Number(m.hashrate) || 0), 0),
      blocks: stats.blocks,
      accepted: stats.accepted,
      stale: stats.stale,
      circulatingNanos: supply.circulatingNanos,
      potEmittedNanos: supply.potNanos,
      hashBonusEmittedNanos: supply.hashNanos,
      extraMintedNanos: supply.extraMintNanos,
      burnedNanos: supply.burnedNanos,
      height: tip?.height || 0,
      header: tip?.header ? Buffer.from(tip.header).toString('hex') : '',
      bits: lastJob?.bits || bits,
      lastFoundAt: stats.lastFoundAt || (() => {
        if (!tip?.header) return 0;
        try { return Number(decodeHeader(Buffer.from(tip.header)).timestamp) || 0; } catch { return 0; }
      })(),
      avgBlockTimeMs: avgMs,
      networkAvgBlockTimeMs: avgMs,
      avgBlockWindow: (store.blocks || []).length,
      nodesOnline: nodesOnline(),
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

  function queueSend(t) {
    const id = t.id || `send-${Date.now()}`;
    const tx = { id, ...t };
    if (typeof store.queueTx === 'function') {
      const got = store.queueTx(tx);
      if (!got.ok) return got;
      return got.tx || tx;
    }
    store.mempool = store.mempool || [];
    store.mempool.push(tx);
    return tx;
  }

  function dropSockets(list) {
    let n = 0;
    for (const s of list) {
      try { s.destroy(); n += 1; } catch { /* ignore */ }
    }
    return n;
  }

  function minerMatches(m, want) {
    const w = String(want || '').trim();
    if (!w) return false;
    const tag = publicMinerTag(m.login || m.workerKey);
    return tag === w
      || String(m.workerKey || '') === w
      || String(m.login || '') === w
      || parseLogin(m.login || m.workerKey) === w;
  }

  function kickMiner(want) {
    const socks = [];
    for (const m of miners.values()) {
      if (!minerMatches(m, want)) continue;
      for (const c of m.connections || []) {
        if (c?.sock) socks.push(c.sock);
      }
    }
    return { dropped: dropSockets(socks) };
  }

  const adminOps = {
    health() {
      const tip = store.tip();
      let connected = 0;
      for (const m of miners.values()) {
        if (minerConnected(m)) connected += 1;
      }
      return {
        paused,
        height: tip?.height || 0,
        jobId: lastJob?.jobId || '',
        jobHeight: Number(lastJob?.height) || 0,
        shareBits: Number(lastJob?.shareBits) || shareBits,
        blockBits: blockBitsNow(),
        accepted: stats.accepted,
        stale: stats.stale,
        blocks: stats.blocks,
        miners: miners.size,
        connected,
        sockets: sockets.size,
        hashQueue: hashWait.size,
        bans: bans.size,
        uptimeMs: Date.now() - stats.started,
        lastFoundAt: stats.lastFoundAt || 0,
        stratum: stats.stratum,
      };
    },
    miners() {
      const now = Date.now();
      return [...miners.values()].map((m) => adminMinerView(m, now));
    },
    setPaused(next) {
      paused = !!next;
      if (!paused && lastJob) broadcastJob(lastJob, { force: true });
      return { paused };
    },
    rebroadcast() {
      if (paused) return { paused: true, n: 0, reason: 'paused' };
      if (!lastJob) return { n: 0, reason: 'no_job' };
      return { n: broadcastJob(lastJob, { force: true }), jobId: lastJob.jobId };
    },
    disconnectAll() {
      return { dropped: dropSockets([...sockets]) };
    },
    kick(want) {
      return kickMiner(want);
    },
    ban(want) {
      const w = String(want || '').trim();
      if (!w) return { banned: false };
      bans.add(w);
      saveBans();
      const kicked = kickMiner(w);
      return { banned: true, ...kicked };
    },
    unban(want) {
      const w = String(want || '').trim();
      bans.delete(w);
      saveBans();
      return { banned: false };
    },
    clearStale() {
      stats.stale = 0;
      for (const m of miners.values()) m.stale = 0;
      paintStatsSnap();
      return { stale: 0 };
    },
    restart() {
      if (typeof onRestart === 'function') return onRestart();
      if (restarting) return { scheduled: true };
      restarting = true;
      setTimeout(() => {
        try { process.exit(0); } catch { /* ignore */ }
      }, 400);
      return { scheduled: true };
    },
    restartHasher() {
      if (typeof onRestartHasher === 'function') return onRestartHasher();
      try {
        const child = spawn('systemctl', ['restart', 'sheark-miner'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return { scheduled: true };
      } catch {
        return { scheduled: false, reason: 'hasher_restart_failed' };
      }
    },
  };

  const httpServer = http.createServer(async (req, res) => {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (isAdminHost(host)) {
      await handleAdminHttp(req, res, { store, admin, queueSend, ops: adminOps });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/admin')) {
      res.statusCode = 404;
      res.end('missing');
      return;
    }
    if (url.pathname === '/api/stats') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(statsSnap.json);
      return;
    }
    if (url.pathname === '/api/policy') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(typeof store.getpolicy === 'function' ? store.getpolicy() : { ok: false }));
      return;
    }
    if (url.pathname === '/api/chaintips') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        ok: true,
        tips: typeof store.getchaintips === 'function' ? store.getchaintips() : [],
      }));
      return;
    }
    if (url.pathname === '/api/reorgs') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        ok: true,
        reorgs: typeof store.getreorgs === 'function' ? store.getreorgs() : [],
      }));
      return;
    }
    if (url.pathname === '/api/credits_frozen' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      const policy = typeof store.getpolicy === 'function' ? store.getpolicy() : { frozen: false };
      res.end(JSON.stringify({ ok: true, frozen: !!policy.frozen, reason: policy.freeze_reason || '', policy }));
      return;
    }
    if (url.pathname.startsWith('/api/miners/')) {
      const parts = url.pathname.slice('/api/miners/'.length).split('/').filter(Boolean);
      const tag = decodeURIComponent(parts[0] || '');
      const rows = minerByTag(tag);
      res.setHeader('content-type', 'application/json');
      const tipH = Number(store.tip?.()?.height || 0);
      const need = typeof store.getpolicy === 'function'
        ? (store.getpolicy().operational?.pool_merchant || 30)
        : 30;
      const pull = pullBook.view(tag, { tipHeight: tipH, need });
      if (!rows.length && !(pull.pendingNanos > 0) && !pull.lastPullMs) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, reason: 'unknown_miner', tag }));
        return;
      }
      if (parts[1] === 'withdraw' && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse(await new Promise((resolve, reject) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
            req.on('error', reject);
          }));
        } catch { body = {}; }
        const login = String(body.login || '').trim();
        if (publicMinerTag(login) !== tag) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, reason: 'auth' }));
          return;
        }
        if (pull.lastPullMs && Date.now() < pull.nextPullMs) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, reason: 'cooldown', nextPullMs: pull.nextPullMs }));
          return;
        }
        if (!(pull.confirmedNanos > 0)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, reason: 'none_confirmed' }));
          return;
        }
        const dest = payoutDest(String(body.dest || '')) || payoutDest(login) || '';
        const off = verifyPoolWithdrawOffchain({
          login,
          dest,
          nanos: pull.confirmedNanos,
          sig: body.sig || body.signature,
        });
        if (!off.ok) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, reason: off.reason }));
          return;
        }
        const from = payoutDest(miner) || poolFeeDest();
        const fee = levyNanos(pull.confirmedNanos, { depth: mempoolDepthBytes(store.mempool || []) });
        const tx = poolWithdrawTx({ from, to: dest, nanos: pull.confirmedNanos, fee });
        if (containsShe1(tx)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, reason: 'she1_on_chain' }));
          return;
        }
        const queued = queueSend(tx);
        if (queued && queued.ok === false) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, reason: queued.reason || 'queue_failed' }));
          return;
        }
        const taken = pullBook.takeConfirmed(tag, { tipHeight: tipH, need });
        res.end(JSON.stringify({
          ok: true,
          nanos: taken.nanos,
          she: taken.nanos / NANOS_PER_SHE,
          to: dest,
          cooldownMs: PULL_COOLDOWN_MS,
        }));
        return;
      }
      const now = Date.now();
      const views = rows.length
        ? rows.map((m) => publicMinerView(m, now)).sort((a, b) => (b.hashrate || 0) - (a.hashrate || 0))
        : [];
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
        tag,
        name: uniquePublicLabels(views.map((v) => v.name)),
        version: uniquePublicLabels(views.map((v) => v.version)),
        client: views[0]?.client || CLIENT,
        algo: ALGO,
        personalisation: PERSONAL,
        connected: views.some((v) => v.connected),
        lastSeen: views.length ? Math.max(...views.map((v) => v.lastSeen)) : 0,
        firstSeen: views.length ? Math.min(...views.map((v) => v.firstSeen || now)) : 0,
        ...roll,
        workers: views,
        pendingShe: pull.pendingNanos / NANOS_PER_SHE,
        confirmedShe: pull.confirmedNanos / NANOS_PER_SHE,
        unconfirmedShe: pull.unconfirmedNanos / NANOS_PER_SHE,
        pendingDisplay: formatShe(pull.pendingNanos / NANOS_PER_SHE),
        confirmedDisplay: formatShe(pull.confirmedNanos / NANOS_PER_SHE),
        nextPullMs: pull.nextPullMs,
        cooldownMs: PULL_COOLDOWN_MS,
      }));
      return;
    }
    if (url.pathname === '/api/mempool' || url.pathname === '/api/mempoolPressure' || url.pathname === '/api/mempoolpressure' || url.pathname.startsWith('/api/wallet/') || url.pathname.startsWith('/api/explorer/') || url.pathname.startsWith('/api/vortex/') || url.pathname.startsWith('/api/pool/') || url.pathname.startsWith('/api/vault/') || url.pathname.startsWith('/api/join/')) {
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
        lastJob,
        poolDest: miner,
        queueSend,
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
  httpServer.on('listening', () => {
    paintStatsSnap();
    if (!statsTimer) statsTimer = setInterval(paintStatsSnap, STATS_REFRESH_MS);
  });

  function listen() {
    return new Promise((resolve, reject) => {
      stratum.listen(stratumPort, '0.0.0.0', () => {
        httpServer.listen(httpPort, '127.0.0.1', () => {
          if (!restampTimer) restampTimer = setInterval(maybeRestampJob, JOB_RESTAMP_MS);
          paintStatsSnap();
          if (!statsTimer) statsTimer = setInterval(paintStatsSnap, STATS_REFRESH_MS);
          resolve({
            stratumPort,
            httpPort,
          });
        });
      });
      stratum.on('error', reject);
    });
  }

  function close() {
    if (restampTimer) {
      clearInterval(restampTimer);
      restampTimer = null;
    }
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    if (hashWorker) {
      try { hashWorker.terminate(); } catch { /* ignore */ }
      hashWorker = null;
    }
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
    setP2p,
    restampJob: maybeRestampJob,
    get pendingPayout() { return pendingPayout; },
    get prevJob() { return prevJob; },
    get paused() { return paused; },
    admin,
    adminOps,
    pullBook,
  };
}

export { CLIENT, ALGO };
