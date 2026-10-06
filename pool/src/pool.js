import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { spawn, spawnSync } from 'node:child_process';
import { requiredJobFields, decodeHeader, encodeHeader, headerFromHex, setNonce } from '../../crypto/header.js';
import { shearHash, meetsTarget, leadingZeroBits, ALGO, CLIENT, PERSONAL } from '../../crypto/shear_hash.js';
import { isMineLogin, isPaymentCode, payoutDest, isDestAddress, isShearAddress, hash20FromAddress, ED25519_SPKI_PREFIX } from '../../crypto/address.js';
import { hasherPayoutDest } from '../../crypto/flow_sheet.js';
import { destBoundShareHash, noteCommitOfShare, shareMeetsFloor } from '../../crypto/share_batch.js';
import {
  BLOCK_SUBSIDY_NANOS,
  POOL_FEE_BPS,
  MAGIC_TESTNET,
  TARGET_BLOCK_INTERVAL_MS,
  HASH_BONUS_NANOS,
  hashBonusUnitNanos,
  HASH_TX_LIVE,
  nextBits,
  templateStampMs,
  medianTimePast,
  MTP_WINDOW,
  MTP_FUTURE_MS,
  HEADER_AHEAD_MS,
  consensusFingerprint,
  consensusLaw,
  epochView,
  formatShe,
  NANOS_PER_SHE,
  SPENDABLE_CONFIRMATIONS,
  GENESIS_BITS,
  GENESIS_BITS_PACKED,
  LIVE_MIN_BITS,
  MAX_BITS,
  SHARE_FLOOR_BITS,
  displayBits,
  bitsAcceptAsert,
  SHEARK_MINER_VERSION,
  PRODUCT_VERSION,
  PI_SHE_NANOS,
} from '../../crypto/asert.js';
import { poolFeeDest, levyNanos, mempoolDepthBytes, poolWithdrawTx, verifyPoolWithdrawOffchain, containsShe1 } from '../../crypto/levy.js';
import { ownerPubFromOpening } from '../../crypto/eip712.js';
import { isAdminHost, handleAdminHttp, createAdmin } from './admin.js';
import {
  THIS_POOL_DIRECT_FEE_DEST,
  configuredFeeIdentity,
  stratumListenPlan,
  authPubGate,
  intervalCertify,
  narrowPublicStats,
} from './posture.js';
export { THIS_POOL_DIRECT_FEE_DEST, V10_POOL_FEE_DEST, V11_POOL_FEE_DEST, configuredFeeIdentity, feeIdentityCheck, stratumListenPlan, authPubGate, intervalCertify, CERTIFY_WINDOW } from './posture.js';
import { createPullBook, PULL_COOLDOWN_MS, AUTO_PAYOUT_MIN_NANOS } from './pull_book.js';
import {
  buildAutoPayoutTx,
  redactSsa1,
} from './auto_payout.js';
import { bootPoolOperator } from './pool_ident.js';
import { createStore } from '../../node/src/store.js';
import { potSharesFromBatch, hashBonusByMiner, retarget, retargetQuote } from '../../node/src/chain.js';
import { sortShares, selectBlockShares, rememberLiveSharePow } from '../../crypto/share_batch.js';
import { pullBookHashLeg } from '../../crypto/share_dag.js';
import { poolRecentBlockTxs, networkSupply, openRoundHashRows } from './wallet_api.js';
import { hasherHasValidRoundShare, roundActualHashes } from './hash_credit.js';
import { withdrawNonces, withdrawDigests } from './withdraw_state.js';
import {
  carriedShareBits,
  clampShareBits,
  destVardiffOnShare,
  hashesProvenByShare,
  liveShareBits as selectLiveShareBits,
  SHARE_BITS_V2_START,
  SHARE_VARDIFF_CLIMB_MAX,
  SHARE_VARDIFF_CLEAR_EASE_MS,
  SHARE_VARDIFF_DEADBAND_LOW_MS,
  SHARE_VARDIFF_EASE_MAX,
  SHARE_VARDIFF_RETARGET_MS,
  SHARE_VARDIFF_RETARGET_SHARES,
  SHARE_VARDIFF_TARGET_MS,
  mintShareMinBits,
} from './share_vardiff.js';

export { hasherHasValidRoundShare, roundActualHashes };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, '../public');
const REPO_ROOT = path.join(__dirname, '../..');

export function gitHeadOf(cwd = REPO_ROOT) {
  // The advertised head is this tree. SHEAR_GIT_HEAD must not label another book.
  void process.env.SHEAR_GIT_HEAD;
  try {
    const gitDir = path.join(cwd, '.git');
    let head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^ref:/.test(head)) {
      head = fs.readFileSync(path.join(gitDir, head.slice(4).trim()), 'utf8').trim();
    }
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.toLowerCase();
  } catch { /* packed-refs or missing */ }
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const h = String(r.stdout || '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(h)) return h.toLowerCase();
  } catch { /* not a git checkout */ }
  return '';
}
/** Public H/s is proven hashes in this window, not lifetime hashes / first-seen. */
export const HASHRATE_WINDOW_MS = 180_000;
/** Display H/s eases toward hashes/dt. 8s tau matches ShearK RATE_TAU so miner and pool agree. */
export const HASHRATE_EMA_TAU_S = 8;
/** After the last socket closes, keep the row this long. Still-connected hashers with proven shares stay listed (header bits can put shares >12s apart). */
export const HASH_PRESENCE_MS = 12_000;
/** Default is every sealed header. Pass a finite window to clip a test. */
export const AVG_BLOCK_WINDOW = Infinity;
/** Re-stamp the live job this often so sealed header time tracks wall clock. */
export const JOB_RESTAMP_MS = 10_000;
/** Keep this many prior restamp headers per job so in-flight shares still verify. */
export const JOB_HEADER_HISTORY = 12;
/** After the tip moves, accept the previous job this long without new-round credit. */
export const PREV_JOB_GRACE_MS = 12_000;
/** Hold last positive self-rate this long across a RandomX cache pause. */
export const HASHRATE_STALL_HOLD_MS = 90_000;
/** Mixed hashing+K-pause windows often land at 50–90% of the true rate. */
export const HASHRATE_HOLD_FRAC = 0.9;
/** Rebuild /api/stats JSON on this cadence. The HTTP handler never computes it. */
export const STATS_REFRESH_MS = 400;
/** Auto-payout sweep cadence. Hourly, so the book walk does not stall the pool page. */
export const PAYOUT_SWEEP_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.SHEAR_PAYOUT_SWEEP_MS) || (60 * 60 * 1000),
);
/** One due miner per tick so a slow queueTx cannot monopolize the loop. */
export const PAYOUT_SWEEP_MAX_ROWS = 1;
/** Wall-clock budget for one sweep pass. Remaining due rows reschedule. */
export const PAYOUT_SWEEP_BUDGET_MS = Math.max(
  20,
  Number(process.env.SHEAR_PAYOUT_SWEEP_BUDGET_MS) || 200,
);
const HASH_WORKER = fileURLToPath(new URL('./hash_worker.js', import.meta.url));
const HASH_WORKER_TIMEOUT_MS = 15_000;
/** Cap in-flight RandomX verifies so a junk submit flood cannot stall HTTP. */
export const HASH_QUEUE_MAX = 16;
/** One hasher cannot fill the verify queue. Small miners still get a slot. */
export const HASH_INFLIGHT_PER_CONN = 2;
/**
 * Connected hasher with zero accepted ShearHash-v3 shares is dropped after
 * this. RandomX light cache init is seconds, not minutes; 90s is several
 * expected share intervals at ~50 H/s and opening shareBits 8.
 */
export const NO_VALID_SHARE_MS = 90_000;

/**
 * Mean interval of consecutive sealed headers. Default is every block on
 * the book, not only the last pair and not a sliding window of 20.
 * Non-positive gaps (stale/frozen stamps) are skipped.
 */
export function avgWallFindIntervalMs(findTimes) {
  const times = (Array.isArray(findTimes) ? findTimes : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
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

/** Long-window EWMA half-life in blocks (matches ASERT 288). */
export const AVG_BLOCK_EWMA_HALFLIFE = 288;
export const AVG_BLOCK_MEDIAN_WINDOW = 288;
export const AVG_BLOCK_SAMPLE_MIN_MS = TARGET_BLOCK_INTERVAL_MS / 8;
export const AVG_BLOCK_SAMPLE_MAX_MS = TARGET_BLOCK_INTERVAL_MS * 8;

export function intervalDeltasMs(findTimes) {
  const times = (Array.isArray(findTimes) ? findTimes : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  const dts = [];
  for (let i = 1; i < times.length; i += 1) {
    const dt = times[i] - times[i - 1];
    if (Number.isFinite(dt) && dt > 0) dts.push(dt);
  }
  return dts;
}

export function clampBlockIntervalMs(dt) {
  const n = Number(dt);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(AVG_BLOCK_SAMPLE_MIN_MS, Math.min(AVG_BLOCK_SAMPLE_MAX_MS, n));
}

/** Stall-resistant long EWMA. A 12h gap cannot pull the public average to hours. */
export function ewmaBlockIntervalMs(dts, {
  halfLife = AVG_BLOCK_EWMA_HALFLIFE,
  target = TARGET_BLOCK_INTERVAL_MS,
} = {}) {
  const h = Math.max(1, Number(halfLife) || AVG_BLOCK_EWMA_HALFLIFE);
  const alpha = 1 - 2 ** (-1 / h);
  let ewma = target;
  let n = 0;
  for (const raw of Array.isArray(dts) ? dts : []) {
    const dt = clampBlockIntervalMs(raw);
    if (dt == null) continue;
    ewma = alpha * dt + (1 - alpha) * ewma;
    n += 1;
  }
  return n ? ewma : null;
}

export function medianBlockIntervalMs(dts, window = AVG_BLOCK_MEDIAN_WINDOW) {
  const keep = Math.max(1, Math.floor(Number(window) || AVG_BLOCK_MEDIAN_WINDOW));
  const clamped = (Array.isArray(dts) ? dts : [])
    .map(clampBlockIntervalMs)
    .filter((x) => x != null)
    .slice(-keep);
  if (!clamped.length) return null;
  const s = [...clamped].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

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

/** PROP of (pot - 100 bps) across hasher dests. Fee dest gets only the fee. */
export function splitPot(round, poolDest, potNanos = BLOCK_SUBSIDY_NANOS, feeDest = null) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const fee = Math.floor(pot * POOL_FEE_BPS / 10000);
  const rest = pot - fee;
  const named = feeDest && isDestAddress(feeDest) ? feeDest : '';
  const feeAddr = named || poolFeeDest() || payoutDest(poolDest);
  const by = new Map();
  for (const r of Array.isArray(round) ? round : []) {
    const dest = String(r.miner || r.address || r.dest || '').trim();
    if (!isDestAddress(dest)) continue;
    const n = Math.max(0, Math.floor(Number(r.count || r.units || r.proven || 0)));
    if (n <= 0) continue;
    by.set(dest, (by.get(dest) || 0) + n);
  }
  const total = [...by.values()].reduce((a, n) => a + n, 0);
  const out = [];
  if (!total) return out;
  let paid = 0;
  const dests = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 0; i < dests.length; i += 1) {
    const [addr, n] = dests[i];
    const nanos = i === dests.length - 1 ? rest - paid : Math.floor(rest * n / total);
    paid += nanos;
    if (nanos > 0) out.push({ address: addr, nanos, kind: 'pot' });
  }
  if (fee > 0 && feeAddr && isDestAddress(feeAddr)) {
    const existing = out.find((s) => s.address === feeAddr);
    if (existing) existing.nanos += fee;
    else out.push({ address: feeAddr, nanos: fee, kind: 'pool-fee' });
  }
  return out.filter((s) => s.nanos > 0);
}

/**
 * Pot for the job being issued. A proven lag-1 batch wins. Otherwise the
 * live round's proven counts are split. An empty proven round returns no
 * miner rows from this splitter. issueJob adds this block's pool-fee note
 * and carries the miner remainder. The fee dest never receives the pot.
 */
export function potRoundShares({ lag1Shares = [], potRows = [], feeTo, wantPot } = {}) {
  if (Array.isArray(lag1Shares) && lag1Shares.length) {
    return potSharesFromBatch(lag1Shares, feeTo, wantPot);
  }
  const rows = (Array.isArray(potRows) ? potRows : [])
    .filter((s) => Math.floor(Number(s.count) || 0) > 0);
  if (rows.length) return splitPot(rows, feeTo, wantPot, feeTo);
  return [];
}

/**
 * Job identity for lag-1 trust: every field except nonce. Shares found on
 * the sealed parent (any nonce) are the same job; a restamp is not.
 * Exact-header compare kept only the finder's winning nonce, so every other
 * hasher dest was dropped when one stale row poisoned verifyShareBatch.
 */
export function shareJobId(header) {
  if (!header) return '';
  try {
    const buf = Buffer.isBuffer(header)
      ? Buffer.from(header)
      : headerFromHex(String(header));
    return setNonce(buf, 0n).toString('hex').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Lag-1 shares must verify against the sealed parent. A restamped share or a
 * bech32-as-dest20 row that fails share_pow/miner_addr must not freeze the
 * next template. Drop the bad rows; an empty batch is still sealable.
 */
export function provenLag1Shares(parentHeader, shares) {
  const list = Array.isArray(shares) ? shares : [];
  if (!list.length || !parentHeader) return [];
  const parentId = shareJobId(parentHeader);
  const trusted = [];
  for (const s of list) {
    const id = shareJobId(s?.verifiedHeader);
    if (id && parentId && id === parentId) trusted.push(s);
  }
  // Never RandomX leftovers on the event loop. A restamp / missing
  // verifiedHeader cannot freeze the next job; drop it.
  return sortShares(trusted);
}

/** Dest (ssa1) or silent ID (she1) — worker identity. Payout dest is never she1. */
export function parseLogin(login) {
  const raw = String(login || '').trim();
  return raw.split('.')[0];
}

/** Pool page / stats: opaque tag. Never she1, dest, IP, or worker personal data. */
export function publicMinerTag(login) {
  const dest = parseLogin(login);
  const hex = createHash('sha256')
    .update('shear-miner-tag-v1')
    .update(dest)
    .digest('hex')
    .slice(0, 8);
  return `m${hex}`;
}

/** Proven hashes from every miner this open round. One hash is one nano. */
export function networkRoundHashesOf(miners, openRows = []) {
  const seen = new Set();
  let n = 0;
  const book = miners && typeof miners.values === 'function'
    ? [...miners.values()]
    : (Array.isArray(miners) ? miners : []);
  for (const m of book) {
    const login = String(m?.workerKey || m?.login || '');
    if (!m || isCminerFeeLogin(login) || /\.fee$/i.test(login)) continue;
    const count = Math.floor(Number(roundActualHashes(m)) || 0);
    if (count < 1) continue;
    n += count;
    seen.add(publicMinerTag(m.login || m.workerKey));
  }
  for (const r of openRows || []) {
    const tag = String(r?.tag || '').trim().toLowerCase();
    const count = Math.floor(Number(r?.count) || 0);
    if (!/^m[0-9a-f]{8}$/.test(tag) || count < 1 || seen.has(tag)) continue;
    seen.add(tag);
    n += count;
  }
  return n;
}

/** Serialized miner row for disk/dashboard. dest20-derived tag + hashrate only. */
export function serializeMinerRow(m) {
  const pay = String(m?.payoutDest || '');
  const login = String(m?.login || m?.workerKey || '');
  const dest = pay || (login.startsWith('ssa1') ? login.split('.')[0] : '');
  return {
    tag: publicMinerTag(dest || login),
    hashrate: Number(m?.hashrate || 0),
  };
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

/** Dual-login fee identity is deleted. Every hasher row is public. */
export function isCminerFeeLogin() {
  return false;
}

export const SHEARK_MINER_NAME = 'ShearK-Miner';
export { SHEARK_MINER_VERSION };

/** Major.minor compare. Pre-2.0 ShearK is refused. */
export function minerVersionAtLeast(version, min = '2.0') {
  const parse = (s) => {
    const m = String(s || '').trim().match(/^(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]) };
  };
  const got = parse(version);
  const need = parse(min);
  if (!got || !need) return false;
  if (got.major !== need.major) return got.major > need.major;
  return got.minor >= need.minor;
}

export function admitClient(params) {
  const client = String(params?.client || params?.algo || '');
  if (client !== CLIENT && client !== ALGO) {
    return { ok: false, reason: 'client_refused' };
  }
  if (!minerVersionAtLeast(params?.version)) {
    return { ok: false, reason: 'miner_version' };
  }
  const raw = String(params?.login || params?.user || '').trim();
  const dest = parseLogin(raw);
  if (!raw) return { ok: false, reason: 'bad_login' };
  if (isShearAddress(dest)) return { ok: false, reason: 'bad_login' };
  if (!isMineLogin(dest)) {
    return { ok: true, login: dest, workerKey: raw || dest, payoutDest: '', ramAlias: true };
  }
  const payout = hasherPayoutDest(dest, { dest: params?.dest || params?.payout });
  const worker = raw.split('.').slice(1).filter(Boolean).join('.') || 'worker';
  if (isPaymentCode(dest)) {
    if (!payout) return { ok: true, login: dest, workerKey: raw || dest, payoutDest: '', ramAlias: true };
    return {
      ok: true,
      login: payout,
      workerKey: `${payout}.${worker}`,
      payoutDest: payout,
      ramAlias: true,
    };
  }
  return { ok: true, login: dest, workerKey: raw || dest, payoutDest: payout || (isDestAddress(dest) ? dest : '') };
}

/** Wrong-algo login or a submit that is not a ShearHash-v3 digest. */
export function isWrongAlgoReject(reason) {
  const r = String(reason || '');
  return r === 'client_refused' || r === 'bad_hash' || r === 'need_hash';
}

/**
 * Drop the TCP session: refused algo, nonce-only (not hashing), or a
 * bad_hash before any accepted ShearHash-v3 share. A hasher that already
 * scored stays up through one restamp-history miss.
 */
export function shouldDropOnReject(session, reason) {
  const r = String(reason || '');
  if (r === 'client_refused' || r === 'need_hash' || r === 'miner_version') return true;
  if (r === 'bad_hash') return !(Number(session?.accepted) || 0);
  return false;
}

/**
 * Dest + worker + public tag for a hasher whose software is not ShearHash.
 * Never an IP — another wallet on the same box with real ShearK must still
 * be able to mine. Operator unban is dest/tag.
 */
export function banInvalidKeys({ login, workerKey } = {}) {
  const keys = [];
  const wk = String(workerKey || login || '').trim();
  const dest = parseLogin(wk || login);
  if (wk) keys.push(wk);
  if (dest) {
    keys.push(dest);
    keys.push(publicMinerTag(dest));
  }
  return [...new Set(keys.filter(Boolean))];
}

/** Unauthenticated first-contact cannot durable-ban a dest. */
export const DEST_BAN_MIN_ACCEPTS = 3;
export const IP_SOFT_STRIKES = 8;
export const BAN_TTL_MS = 6 * 3600 * 1000;

export function shouldDurableDestBan(session) {
  return (Number(session?.accepted) || 0) >= DEST_BAN_MIN_ACCEPTS;
}

export function sockIp(sock) {
  let a = String(sock?.remoteAddress || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a;
}

export function normalizeBanBook(raw, now = Date.now()) {
  const list = Array.isArray(raw?.bans) ? raw.bans : [];
  const bans = [];
  for (const b of list) {
    const rec = typeof b === 'string'
      ? { key: b, kind: 'dest', until: now + BAN_TTL_MS, strikes: 1 }
      : { key: String(b?.key || ''), kind: String(b?.kind || 'dest'), until: Number(b?.until) || 0, strikes: Number(b?.strikes) || 1 };
    if (!rec.key) continue;
    if (rec.until && rec.until < now) continue;
    bans.push(rec);
  }
  return { version: 2, bans };
}

export function destBannedInBook(book, dest, now = Date.now()) {
  const want = String(dest || '');
  if (!want) return false;
  return (book?.bans || []).some((b) => (
    b.kind !== 'ip'
    && (b.key === want || b.key === publicMinerTag(want))
    && (!b.until || b.until >= now)
  ));
}

export function stratumBindHost(override) {
  const h = String(override ?? process.env.SHEAR_STRATUM_BIND ?? '127.0.0.1').trim();
  return h || '127.0.0.1';
}

/** Loopback (or empty → default loopback) is the unit BIND. */
export function isLoopbackBind(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '' || h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/**
 * Ops-drift: non-loopback bind with AUTH off. Alert on /api/stats.
 * Refuse-start only when a prod profile is set — testnet soak still boots.
 */
export function stratumDriftAlert({ bind, requireLoginAuth } = {}) {
  const host = stratumBindHost(bind);
  return !isLoopbackBind(host) && requireLoginAuth !== true;
}

export function stratumProdProfile({
  env = process.env,
  prodProfile,
} = {}) {
  if (prodProfile === true) return true;
  if (prodProfile === false) return false;
  const e = env || {};
  return String(e.SHEAR_STRATUM_PROD_PROFILE || '') === '1'
    || String(e.SHEAR_NETWORK || '') === 'shear-v1';
}

export function stratumDriftShouldRefuse({
  bind,
  requireLoginAuth,
  prodProfile,
  env = process.env,
} = {}) {
  return stratumProdProfile({ env, prodProfile })
    && stratumDriftAlert({ bind, requireLoginAuth });
}

/** tip unit defaults vs soak drop-in. Override with SHEAR_STRATUM_CONFIG_SOURCE. */
export function stratumConfigSourceOf({ bind, requireLoginAuth, env = process.env } = {}) {
  const forced = String((env || {}).SHEAR_STRATUM_CONFIG_SOURCE || '').trim();
  if (forced === 'unit' || forced === 'drop-in') return forced;
  const host = stratumBindHost(bind);
  if (isLoopbackBind(host) && requireLoginAuth === true) return 'unit';
  return 'drop-in';
}

export function explorerHostList() {
  const extra = String(process.env.SHEAR_EXPLORER_HOST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return ['explorer.shear.digital', ...extra];
}

export function isExplorerHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  return explorerHostList().includes(h);
}

/** Static HTML for a Host + path. Explorer vhost never gets the pool dashboard. */
export function publicHtmlFile(host, pathname) {
  const p = String(pathname || '/');
  if (/^\/miner(\/|$)/.test(p)) return '/miner.html';
  if (/^\/tx(\/|$)/.test(p)) return '/explorer.html';
  if (p === '/explorer' || p === '/explorer/' || p === '/explorer.html') return '/explorer.html';
  if (p === '/' || p === '/index.html') {
    return isExplorerHost(host) ? '/explorer.html' : '/index.html';
  }
  return p;
}

export function gateStratumLogin(params, { requireLoginAuth = false, boundAuthPub = '' } = {}) {
  const adm = admitClient(params);
  if (!adm.ok) return adm;
  if (!requireLoginAuth) return { ok: true, ...adm };
  const presented = String(params?.authPub || params?.spendPub || '');
  const pin = authPubGate({
    requireAuth: true,
    boundPub: boundAuthPub,
    presentedPub: presented,
  });
  if (!pin.ok) {
    if (pin.reason === 'auth_pub_unbound' && !presented && !params?.authSig && !params?.sig) {
      return { ok: false, reason: 'need_auth', challenge: makeLoginChallenge() };
    }
    return { ok: false, reason: pin.reason, challenge: makeLoginChallenge() };
  }
  const okAuth = verifyStratumLoginAuth({
    dest: adm.login,
    challenge: params?.challenge || params?.authChallenge,
    sig: params?.authSig || params?.sig,
    pub: params?.authPub || params?.spendPub,
  });
  if (!okAuth) return { ok: false, reason: 'need_auth', challenge: makeLoginChallenge() };
  return { ok: true, ...adm };
}

/** Height-flat and floor-dwell page after this long. Not a process restart. */
export const TIP_STALL_MS = 15 * 60 * 1000;

/**
 * Pure. Alert and restamp when the tip is flat, or bits sit on the floor
 * while finds are stalled, and hashrate, miners, or shares are above zero.
 * restart is always false. Callers must not bounce the pool or the node.
 * An empty mempool is not this decision. Pending [] does not explain a stall
 * while hashrate is above zero.
 */
export function tipStallDecision({
  now = 0,
  heightSinceMs = 0,
  bits = null,
  lastFoundAt = 0,
  hashrate = 0,
  miners = 0,
  shares = 0,
  liveMinBits = LIVE_MIN_BITS,
  stallMs = TIP_STALL_MS,
} = {}) {
  const activity = Number(hashrate) > 0 || Number(miners) > 0 || Number(shares) > 0;
  const flatFor = Number(now) - Number(heightSinceMs);
  const foundAgo = Number(now) - Number(lastFoundAt);
  const heightFlat = Number.isFinite(flatFor) && flatFor > Number(stallMs);
  const findsStalled = Number.isFinite(foundAgo) && foundAgo > Number(stallMs);
  const atFloor = Number.isFinite(Number(bits)) && Number(bits) <= Number(liveMinBits) + 1e-9;
  const restamp = activity && (heightFlat || (atFloor && (findsStalled || heightFlat)));
  let reason = '';
  if (restamp && atFloor && (findsStalled || heightFlat)) reason = 'floor_dwell';
  else if (restamp) reason = 'tip_stall';
  return { restamp, alert: restamp, restart: false, reason };
}

/**
 * Cause of a long tip age. Low hashrate with a tip that can still seal is not
 * a dead tip and is never a bounce. Frozen is no seal progress, a stuck
 * peer-max, and dead IBD together. restart/bounce stay false.
 */
export function tipStallClass({
  tipAgeMs = 0,
  lastFoundAgeMs = 0,
  hashrate = 0,
  miners = 0,
  sealProgress = false,
  peerMaxStuck = false,
  ibdDead = false,
  stallMs = TIP_STALL_MS,
} = {}) {
  const age = Number(tipAgeMs);
  const foundAge = Number(lastFoundAgeMs);
  const thin = !(Number(hashrate) > 0) || Number(hashrate) < 1000 || Number(miners) <= 1;
  const highAge = Number.isFinite(age) && age > Number(stallMs);
  const foundStale = Number.isFinite(foundAge) && foundAge > Number(stallMs);
  if (!sealProgress && peerMaxStuck && ibdDead) {
    return {
      klass: 'frozen',
      deadTip: true,
      bounce: false,
      restart: false,
      text: 'tip frozen — no seal progress, peer-max stuck, IBD dead',
    };
  }
  if (highAge && foundStale && thin) {
    return {
      klass: 'low-h',
      deadTip: false,
      bounce: false,
      restart: false,
      text: 'low-H / tipAge — seals still possible',
    };
  }
  return { klass: 'none', deadTip: false, bounce: false, restart: false, text: '' };
}

export const ALERT_CONCENTRATION = Number(process.env.SHEAR_ALERT_CONCENTRATION || 0.5) || 0.5;
export const ALERT_SHARE_BLOCK = Number(process.env.SHEAR_ALERT_SHARE_BLOCK || 10_000) || 10_000;
export const SUBMIT_PER_IP_MAX = Math.max(4, Number(process.env.SHEAR_SUBMIT_PER_IP_MAX || 32) || 32);
export const SUBMIT_PER_IP_WINDOW_MS = Math.max(200, Number(process.env.SHEAR_SUBMIT_PER_IP_WINDOW_MS || 1000) || 1000);

export function statsAlerts({
  topDestSharePct: pct,
  shareBlockRatio: ratio,
  concentration = ALERT_CONCENTRATION,
  shareBlock = ALERT_SHARE_BLOCK,
  stratumBind,
  requireLoginAuth,
} = {}) {
  return {
    concentration: Number(pct) >= Number(concentration),
    shareBlock: Number(ratio) >= Number(shareBlock),
    stratumDrift: stratumDriftAlert({ bind: stratumBind, requireLoginAuth }),
  };
}

export function noteIpSubmit(book, ip, now = Date.now(), {
  max = SUBMIT_PER_IP_MAX,
  windowMs = SUBMIT_PER_IP_WINDOW_MS,
} = {}) {
  const key = String(ip || '');
  if (!key || !book || typeof book.get !== 'function') return { ok: true };
  const cut = Number(now) - Number(windowMs);
  const prev = (book.get(key) || []).filter((t) => Number(t) > cut);
  if (prev.length >= Number(max)) {
    book.set(key, prev);
    return { ok: false, reason: 'busy' };
  }
  prev.push(Number(now));
  book.set(key, prev);
  return { ok: true };
}

export function destShareBitsKey(login) {
  return parseLogin(login) || String(login || '');
}

export function rememberDestShareBits(book, dest, bits) {
  const key = destShareBitsKey(dest);
  if (!key || !book || typeof book.set !== 'function') return bits;
  const n = Number(bits);
  if (!Number.isFinite(n)) return bits;
  book.set(key, n);
  return n;
}

export function destShareBitsOf(book, dest, fallback) {
  const key = destShareBitsKey(dest);
  if (!key || !book || typeof book.get !== 'function') return fallback;
  const got = book.get(key);
  return Number.isFinite(Number(got)) ? Number(got) : fallback;
}

export const SHARE_BITS_FILE = 'share-bits.json';

export function loadDestShareBitsMap(dataDir) {
  const book = new Map();
  if (!dataDir) return book;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, SHARE_BITS_FILE), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return book;
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n >= 1) book.set(k, n);
    }
  } catch { /* first boot */ }
  return book;
}

export function persistDestShareBitsMap(dataDir, book) {
  if (!dataDir || !book || typeof book.entries !== 'function') return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const obj = {};
    for (const [k, v] of book.entries()) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n >= 1) obj[k] = n;
    }
    fs.writeFileSync(path.join(dataDir, SHARE_BITS_FILE), `${JSON.stringify(obj)}\n`);
  } catch { /* keep memory book */ }
}

export function openShareFingerprint(job, nonce, hashHex) {
  return shareFingerprint(job, nonce, hashHex);
}

export function rememberOpenShare(openShares, rec) {
  const list = Array.isArray(openShares) ? openShares : [];
  const fp = rec?.fp || openShareFingerprint(rec, rec?.nonce, rec?.hash);
  if (!fp) return { ok: false, reason: 'bad_share', list };
  if (list.some((s) => String(s.fp || '') === fp)) return { ok: false, reason: 'duplicate_share', list };
  list.push({ ...rec, fp });
  return { ok: true, list };
}

export function makeLoginChallenge() {
  return randomBytes(16).toString('hex');
}

export function verifyStratumLoginAuth({ dest, challenge, sig, pub } = {}) {
  if (!dest || !challenge || !sig || !pub) return false;
  try {
    const raw = Buffer.from(String(pub), 'hex');
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    const msg = Buffer.from(`shear-stratum-login-v1:${challenge}:${dest}`);
    return verifyEd25519(null, msg, key, Buffer.from(String(sig), 'hex'));
  } catch {
    return false;
  }
}

export function topDestSharePct(workers) {
  const total = (workers || []).reduce((a, w) => a + (Number(w.hashrate) || 0), 0);
  const top = Number(workers?.[0]?.hashrate) || 0;
  return total > 0 ? top / total : 0;
}

/** ShearHash-v3 digest the miner claims. Empty if they did not compute the algo. */
export function submittedShareDigest(params) {
  const h = String(params?.hash || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : '';
}

/** Map hash-worker throws to a stratum reject the miner can print. */
export function hashWorkerRejectReason(err) {
  const m = String(err?.message || err || '');
  if (m === 'hash_busy') return 'busy';
  // close() rejects in-flight hashes with this. It is shutdown, not a bad digest.
  if (m === 'closed') return 'closed';
  if (m.includes('native addon missing') || m.includes('ShearK-Miner not built')) return 'native_missing';
  if (m.includes('header must be')) return 'bad_header';
  if (m === 'hash_timeout' || m === 'hash_worker_exit') return 'hash_timeout';
  if (m.includes('verify parse') || m.includes('verify failed')) return 'native_missing';
  return 'hash_failed';
}

export function gateJob(job) {
  return requiredJobFields(job);
}

/** Stratum payload. headerHistory is pool-side only — a 12-header blob
 *  blew up the miner recv line so ShearK never submitted after restamp. */
function headerWorkBits(header) {
  try {
    if (!header) return null;
    const buf = Buffer.isBuffer(header) ? header : headerFromHex(header);
    return decodeHeader(buf).bits;
  } catch {
    return null;
  }
}

export function wireJob(job, shareBits) {
  if (!job || typeof job !== 'object') return job;
  const { headerHistory, shareBitsHist, ...rest } = job;
  void headerHistory;
  void shareBitsHist;
  const out = { ...rest };
  if (shareBits != null) out.shareBits = shareBits;
  out.shareBind = 'dest';
  const sealed = headerWorkBits(out.header);
  if (sealed != null) {
    out.bits = sealed;
    out.blockBits = sealed;
  }
  return out;
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

export function judgeShare({ job, header, hash, dest, shareBits } = {}) {
  const current = Number(shareBits ?? job?.shareBits);
  const prev = Number(job.shareBitsPrev);
  const prevAt = Number(job.shareBitsAt) || 0;
  const now = Date.now();
  // Block credit is the sealed header target. shareBits and a substituted
  // job.blockBits are not that target.
  const sealedBits = headerWorkBits(header || job?.header);
  const blockTarget = sealedBits != null ? sealedBits : Number(job.blockBits || job.bits);
  const blockOk = meetsTarget(hash, blockTarget);
  const pay = String(dest || job?.dest || '').trim();
  let shareHash = hash;
  if (pay) {
    const nc = noteCommitOfShare({ dest: pay });
    if (!nc || nc.length !== 32) {
      return { ok: false, reason: 'miner_addr', hash: hash.toString('hex') };
    }
    shareHash = destBoundShareHash(hash, nc);
  }
  let creditedShareBits = 0;
  if (meetsTarget(shareHash, current)) creditedShareBits = current;
  const hist = [
    ...(Number.isFinite(prev) && prev > 0 ? [{ bits: prev, at: prevAt }] : []),
    ...(Array.isArray(job.shareBitsHist) ? job.shareBitsHist : []),
  ];
  for (const row of hist) {
    const b = Number(row?.bits);
    const at = Number(row?.at) || 0;
    if (!(b > 0) || b === current) continue;
    if (now - at >= 12_000) continue;
    if (meetsTarget(shareHash, b) && b > creditedShareBits) creditedShareBits = b;
  }
  /* Dest-bound miners still submit RandomX block hits (shareBits often
   * equals unpacked header bits). Those are blocks, not low_diff. */
  if (creditedShareBits > 0) {
    return {
      ok: true,
      hash: hash.toString('hex'),
      block: blockOk,
      header,
      bitsMet: leadingZeroBits(shareHash),
      creditedShareBits,
    };
  }
  if (blockOk) {
    return {
      ok: true,
      hash: hash.toString('hex'),
      block: true,
      header,
      bitsMet: leadingZeroBits(hash),
      creditedShareBits: 0,
    };
  }
  return { ok: false, reason: 'low_diff', hash: hash.toString('hex') };
}

/** Sync path for tests. Live submits use the RandomX worker so HTTP cannot stall. */
export function scoreShare({ job, nonce, claimed, dest } = {}) {
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
      if (last.reason !== 'low_diff' && last.reason !== 'miner_addr') {
        last = { ok: false, reason: 'bad_hash', hash: hex, hashedHeader: headerHex };
      }
      continue;
    }
    const judged = judgeShare({ job, header: prep.header, hash, dest });
    if (judged.ok) return judged;
    last = judged;
    /* Claimed digest matched this header. Later restamp candidates are a
     * different preimage — do not overwrite low_diff with bad_hash. */
    if (want) return judged;
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

/**
 * Sockets on a hasher that never scored a valid share and have been
 * authed longer than timeoutMs. low_diff / stale / duplicate stay;
 * only the idle never-shared case. Fee sockets are not public workers.
 */
export function idleDropSocks(session, now = Date.now(), timeoutMs = NO_VALID_SHARE_MS) {
  if (!session) return [];
  if ((Number(session.accepted) || 0) > 0) return [];
  if (isCminerFeeLogin(session.workerKey || session.login)) return [];
  const wait = Number(timeoutMs);
  const ms = Number.isFinite(wait) && wait > 0 ? wait : NO_VALID_SHARE_MS;
  const out = [];
  for (const c of session.connections || []) {
    if (!c?.sock) continue;
    if (Number(c.hashInflight) > 0) continue;
    const start = Number(c.authedAt) || 0;
    if (start > 0 && (now - start) >= ms) out.push(c.sock);
  }
  return out;
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

function collectWorkerNames(view) {
  const raw = [];
  if (Array.isArray(view?.workerNames)) raw.push(...view.workerNames);
  if (view?.worker) raw.push(view.worker);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const s = String(item || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** One dashboard row per public miner tag. Device sessions combine. */
export function foldPublicMinerViews(views) {
  const byTag = new Map();
  for (const v of views || []) {
    const tag = String(v?.miner || '').trim();
    if (!tag) continue;
    const prev = byTag.get(tag);
    const proven = Number(v.provenHashes ?? v.proven_round ?? v.roundHashes) || 0;
    if (!prev) {
      byTag.set(tag, {
        ...v,
        workerNames: collectWorkerNames(v),
        hashrate: Number(v.hashrate) || 0,
        hashes: Number(v.hashes) || 0,
        roundHashes: Number(v.roundHashes) || 0,
        provenHashes: proven,
        proven_round: proven,
        accepted: Number(v.accepted) || 0,
        stale: Number(v.stale) || 0,
        blocks: Number(v.blocks) || 0,
        blocksSession: Number(v.blocksSession ?? v.blocks) || 0,
        blocksLifetime: Number(v.blocksLifetime) || 0,
        threads: Number(v.threads) || 0,
        sessions: Number(v.sessions) || 1,
        connected: !!v.connected,
        lastSeen: Number(v.lastSeen) || 0,
        firstSeen: Number(v.firstSeen) || 0,
      });
      continue;
    }
    const sameWorker = String(prev.worker || '') !== '' && String(prev.worker) === String(v.worker || '');
    if (sameWorker) prev.hashrate = Math.max(prev.hashrate, Number(v.hashrate) || 0);
    else prev.hashrate += Number(v.hashrate) || 0;
    prev.hashes += Number(v.hashes) || 0;
    prev.roundHashes += Number(v.roundHashes) || 0;
    prev.provenHashes = (Number(prev.provenHashes) || 0) + proven;
    prev.proven_round = (Number(prev.proven_round) || 0) + proven;
    prev.accepted += Number(v.accepted) || 0;
    prev.stale += Number(v.stale) || 0;
    prev.blocks += Number(v.blocks) || 0;
    prev.blocksSession = (Number(prev.blocksSession) || 0) + (Number(v.blocksSession ?? v.blocks) || 0);
    prev.blocksLifetime = Math.max(Number(prev.blocksLifetime) || 0, Number(v.blocksLifetime) || 0);
    prev.threads += Number(v.threads) || 0;
    prev.sessions += Number(v.sessions) || 1;
    prev.connected = prev.connected || !!v.connected;
    prev.lastSeen = Math.max(Number(prev.lastSeen) || 0, Number(v.lastSeen) || 0);
    const fa = Number(prev.firstSeen) || 0;
    const fb = Number(v.firstSeen) || 0;
    prev.firstSeen = fa && fb ? Math.min(fa, fb) : (fa || fb);
    prev.workerNames = collectWorkerNames({
      workerNames: [...(prev.workerNames || []), ...(Array.isArray(v.workerNames) ? v.workerNames : [])],
      worker: v.worker,
    });
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
  if (work <= 0) return 0;
  // Always the full window. now-first floored at 1s painted GH/s on a
  // high-bit share, then dropped to 0 when the next share was slower than
  // the window (1-thread at block bits 26+ is ~90s between shares).
  return work / (HASHRATE_WINDOW_MS / 1000);
}

/** After a sealed header, rebase round counters only. Keep hashes/dt window and eased H/s. */
export function resetMinerRoundDisplay(m, now = Date.now()) {
  if (!m || typeof m !== 'object') return m;
  m.roundHashes = 0;
  m.clientHashesRound0 = Number(m.clientHashes) || 0;
  return m;
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
 * Display H/s is hashes/dt over SELF_RATE_MIN_DT_S (ShearK RATE_MIN_DT=2).
 * EMA tau 8s matches ShearK. Miner `hashrate` clamps a 2× hashes/dt stick.
 * Mint stays proven 2^creditedShareBits.
 */
/** Match ShearK `RATE_MIN_DT` (2s). 8s hid the miner paint and left proven 2^bits as HUD. */
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
  }
  if (!Number.isFinite(hashes) || hashes < 0) return session;
  const threads = Math.max(1, Number(session.threads) || Number(session.claimedThreads) || Number(params.threads) || 1);
  const cap = threads * 2500;
  const claimed = Number(params.hashrate);
  if (Number.isFinite(claimed) && claimed > 1 && claimed <= cap) {
    session.minerPaintHs = claimed;
    session.minerPaintHsAt = now;
  }
  const prev = Number(session.rateHashes0);
  const t0 = Number(session.rateAt0);
  if (!Number.isFinite(prev) || !(t0 > 0) || hashes < prev) {
    session.rateHashes0 = hashes;
    session.rateAt0 = now;
    return session;
  }
  const dt = (now - t0) / 1000;
  if (dt >= SELF_RATE_MIN_DT_S) {
    const delta = hashes - prev;
    if (delta > 0) {
      const inst = delta / dt;
      const prevHs = Number(session.clientHs) || 0;
      const jumped = prevHs > 1 && inst > prevHs * 8 && inst > threads * 800;
      if (inst > cap || jumped) {
        session.rateHashes0 = hashes;
        session.rateAt0 = now;
      } else if (prevHs > 0 && inst < prevHs * HASHRATE_HOLD_FRAC) {
        const paint = Number(session.minerPaintHs) || 0;
        const stall = inst < prevHs * 0.3;
        if (stall && paint <= 0) {
          session.rateHashes0 = hashes;
          session.rateAt0 = now;
        } else {
          const tau = Math.max(1, HASHRATE_EMA_TAU_S);
          const alpha = 1 - Math.exp(-dt / tau);
          const toward = paint > 1 && paint <= cap ? paint : inst;
          session.clientHs = prevHs + alpha * (toward - prevHs);
          session.clientHsAt = now;
          session.rateHashes0 = hashes;
          session.rateAt0 = now;
        }
      } else {
        const tau = Math.max(1, HASHRATE_EMA_TAU_S);
        const alpha = 1 - Math.exp(-dt / tau);
        session.clientHs = prevHs > 0 ? prevHs + alpha * (inst - prevHs) : inst;
        session.clientHsAt = now;
        session.rateHashes0 = hashes;
        session.rateAt0 = now;
      }
    } else {
      session.rateHashes0 = hashes;
      session.rateAt0 = now;
    }
  }
  const paint = Number(session.minerPaintHs) || 0;
  const hs = Number(session.clientHs) || 0;
  if (paint > 1 && paint <= cap && hs > paint * 1.25) {
    session.clientHs = paint;
    session.clientHsAt = now;
  }
  return session;
}

/**
 * Instant H/s is the hasher's hashes/dt (same formula ShearK paints).
 * Bonus mint is still proven 2^shareBits, never this number.
 */
export function liveHashrate(miner, now = Date.now()) {
  if (minerConnected(miner)) {
    const client = Number(miner?.clientHs) || 0;
    if (client > 0) return client;
  }
  return provenHashrate(miner, now);
}

/**
 * Public HUD H/s: EMA toward hashes/dt so miner and pool agree.
 * Dips below HOLD_FRAC and stalls keep the last ease. Do not cap a
 * hasher's real rate — only ignore junk discontinuities in applyMinerSelfRate.
 */
export function reportedHashrate(miner, now = Date.now()) {
  const at = Number(now) || Date.now();
  const hs = liveHashrate(miner, at);
  const held = Number(miner?.clientHs) || 0;
  const t0 = Number(miner?.clientHsAt) || 0;
  const hold = held > 0 && t0 > 0 && (at - t0) < HASHRATE_STALL_HOLD_MS;
  if (hold && (!(hs > 0) || hs < held * HASHRATE_HOLD_FRAC)) return held;
  return hs > 0 ? hs : (hold ? held : 0);
}

/** HUD: miner's own hash counter this round. Never a mint path. */
export function liveRoundHashes(miner) {
  const h = Math.floor(Number(miner?.clientHashes) || 0);
  const z = Math.floor(Number(miner?.clientHashesRound0) || 0);
  const d = h - z;
  return d > 0 ? d : 0;
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

/** Operator table on the admin desk. Dest + workerKey stay off the public pool page. */
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
    hashrate: reportedHashrate(m, now),
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
  stratumBind = process.env.SHEAR_STRATUM_BIND || '127.0.0.1',
  requireLoginAuth = String(process.env.SHEAR_STRATUM_AUTH || '') === '1',
  tlsCert = process.env.SHEAR_STRATUM_TLS_CERT || '',
  tlsKey = process.env.SHEAR_STRATUM_TLS_KEY || '',
  // Process listener. Public miners dial :443. Port 1113 does not receive
  // public SYNs; nginx ssl_preread forwards a no-ALPN ClientHello here.
  tlsPort = Number(process.env.SHEAR_STRATUM_TLS_PORT || 1113),
  requireTls = String(process.env.SHEAR_STRATUM_REQUIRE_TLS || '') === '1',
  labCleartext = String(process.env.SHEAR_STRATUM_LAB_CLEARTEXT || '') === '1',
  boundAuthPub = process.env.SHEAR_STRATUM_AUTH_PUB || '',
  miner,
  operatorSpendKey = null,
  shareBits = SHARE_BITS_V2_START,
  bits = GENESIS_BITS_PACKED,
  lockBits = false,
  p2p = null,
  onRestart = null,
  onRestartHasher = null,
  noValidShareMs = NO_VALID_SHARE_MS,
} = {}) {
  const store = createStore(dataDir);
  const admin = createAdmin(dataDir);
  const pullBook = createPullBook(dataDir);
  const miners = new Map();
  const destShareBits = loadDestShareBitsMap(dataDir);
  const destVarWindows = new Map();
  console.log(JSON.stringify({
    event: 'vardiff_arm',
    targetMs: SHARE_VARDIFF_TARGET_MS,
    minShares: SHARE_VARDIFF_RETARGET_SHARES,
    minWindowMs: SHARE_VARDIFF_RETARGET_MS,
    stepBits: SHARE_VARDIFF_CLIMB_MAX,
    easeBits: SHARE_VARDIFF_EASE_MAX,
    clearEaseMs: SHARE_VARDIFF_CLEAR_EASE_MS,
    deadbandLowMs: SHARE_VARDIFF_DEADBAND_LOW_MS,
    easeAboveMs: SHARE_VARDIFF_TARGET_MS,
    floorBits: SHARE_FLOOR_BITS,
  }));
  function pushDestShareBits(destKey, next) {
    rememberDestShareBits(destShareBits, destKey, next);
    persistDestShareBitsMap(dataDir, destShareBits);
    for (const m of miners.values()) {
      if (destShareBitsKey(m.login || m.payoutDest) !== destKey) continue;
      for (const c of m.connections || []) {
        if (!c || c.shearFeeRoute) continue;
        c.shareBits = next;
        const live = lastJob || c.job;
        if (!live || !c.sock) continue;
        c.job = live;
        try { c.sock.write(line({ method: 'job', params: wireJob(live, next) })); } catch { /* ignore */ }
      }
    }
  }
  const ipSubmitAt = new Map();
  let p2pNet = p2p;
  let hashWorker = null;
  let hashSeq = 0;
  let hashLive = 0;
  const hashWait = new Map();
  // terminate() during native ShearHash is an access violation on Windows.
  // The worker stays referenced until the in-flight call posts its result.
  function releaseHashWorker() {
    if (!stopped || hashLive > 0 || !hashWorker) return;
    const worker = hashWorker;
    hashWorker = null;
    try { worker.unref?.(); } catch { /* ignore */ }
    try { void Promise.resolve(worker.terminate()).catch(() => {}); } catch { /* ignore */ }
  }
  function finishHashJob() {
    hashLive = Math.max(0, hashLive - 1);
    releaseHashWorker();
  }
  function bootHashWorker() {
    if (hashWorker) return hashWorker;
    const w = new Worker(HASH_WORKER);
    w.on('message', (msg) => {
      const pending = hashWait.get(msg.id);
      if (pending && !pending.settled) {
        pending.settled = true;
        hashWait.delete(msg.id);
        clearTimeout(pending.timer);
        try {
          if (msg.ok) pending.resolve(Buffer.from(msg.hash));
          else pending.reject(new Error(msg.error || 'hash_failed'));
        } catch { /* late worker message after close */ }
      }
      finishHashJob();
    });
    const drop = () => {
      hashWorker = null;
      hashLive = 0;
      for (const [, p] of hashWait) {
        if (p.settled) continue;
        p.settled = true;
        clearTimeout(p.timer);
        try { p.reject(new Error('hash_worker_exit')); } catch { /* ignore */ }
      }
      hashWait.clear();
    };
    w.on('error', drop);
    w.on('exit', drop);
    hashWorker = w;
    return w;
  }
  function hashOffThread(header, conn) {
    if (stopped) return Promise.reject(new Error('closed'));
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
        const pending = hashWait.get(id);
        if (!pending || pending.settled) return;
        pending.settled = true;
        hashWait.delete(id);
        reject(new Error('hash_timeout'));
      }, HASH_WORKER_TIMEOUT_MS);
      timer.unref?.();
      hashWait.set(id, { resolve, reject, timer, conn, settled: false });
      try {
        bootHashWorker().postMessage({ id, headerHex: copy.toString('hex') });
        hashLive += 1;
      } catch (e) {
        hashWait.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    }).finally(() => {
      if (conn) conn.hashInflight = Math.max(0, (Number(conn.hashInflight) || 1) - 1);
    });
  }
  async function scoreShareLive({ job, nonce, claimed, conn, dest } = {}) {
    const want = claimed ? String(claimed).toLowerCase() : '';
    const headers = candidateShareHeaders({
      ...job,
      header: job?.header || conn?.job?.header,
      headerHistory: [
        ...(Array.isArray(job?.headerHistory) ? job.headerHistory : []),
        conn?.job?.header,
      ].filter(Boolean),
    });
    const list = headers.length ? headers : [job?.header || conn?.job?.header];
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
        if (last.reason !== 'low_diff' && last.reason !== 'miner_addr') {
          last = { ok: false, reason: 'bad_hash', hash: hex, hashedHeader: headerHex };
        }
        continue;
      }
      const judged = judgeShare({
        job,
        header: prep.header,
        hash,
        dest,
        shareBits: conn?.shareBits ?? job?.shareBits,
      });
      if (judged.ok) return judged;
      last = judged;
      if (want) return judged;
    }
    return last;
  }
  let networkView = null;
  let stopped = false;
  function setP2p(next) { p2pNet = next; }
  function setNetworkView(view) {
    if (!view || !Array.isArray(view.txs)) return;
    const txs = [];
    for (const m of view.txs) {
      const id = String(m?.id || '');
      if (!id) continue;
      txs.push({
        id,
        kind: String(m.kind || 'send'),
        fee: Number(m.fee) || 0,
        weight: Number(m.weight) || 0,
      });
    }
    const rounds = [];
    for (const r of Array.isArray(view.rounds) ? view.rounds : []) {
      const tag = String(r?.tag || '').toLowerCase();
      if (!/^m[0-9a-f]{8}$/.test(tag)) continue;
      const count = Math.floor(Number(r.count) || 0);
      if (count < 1) continue;
      rounds.push({ tag, count, source: r.source === 'local' ? 'local' : 'peer' });
    }
    const synced = Number(view.synced);
    networkView = {
      txs,
      rounds,
      synced: Number.isFinite(synced) && synced >= 0 ? synced : null,
    };
    try { paintStatsSnap(); } catch { /* snap is rebuilt on the stats cadence */ }
  }
  function nodesOnline() {
    if (networkView && networkView.synced != null) return networkView.synced;
    const n = p2pNet?.syncedOnline?.() ?? p2pNet?.liveOnline?.();
    const v = Number(n);
    return Number.isFinite(v) && v >= 0 ? v : 1;
  }
  function liveShareMin() {
    return mintShareMinBits();
  }
  let lastJob = null;
  let prevJob = null;
  let prevJobAt = 0;
  // Mempool ids last packed into a template. Membership change rebuilds once.
  // A painted hold that stays queued does not churn the job id; a tip change
  // still force-rebuilds, so a hold that becomes fundable is packed then.
  let packedMempoolKey = '';
  let pendingPayout = [];
  let lag1Shares = [];
  let openShares = [];
  let sealing = false;
  let paused = false;
  let restarting = false;
  const banPath = path.join(dataDir, 'pool-bans.json');
  function loadBans() {
    try {
      const j = JSON.parse(fs.readFileSync(banPath, 'utf8'));
      const book = normalizeBanBook(j);
      return new Set(book.bans.filter((b) => b.kind !== 'ip').map((b) => b.key));
    } catch {
      return new Set();
    }
  }
  let bans = loadBans();
  const ipStrikes = new Map();
  const ipDeniedUntil = new Map();
  function saveBans() {
    const now = Date.now();
    const recs = [...bans].map((key) => ({ key, kind: 'dest', until: now + BAN_TTL_MS, strikes: DEST_BAN_MIN_ACCEPTS }));
    fs.writeFileSync(banPath, JSON.stringify({ version: 2, bans: recs }), { mode: 0o600 });
  }
  function isBanned(key) {
    const raw = String(key || '');
    if (!raw) return false;
    const dest = parseLogin(raw);
    const tag = publicMinerTag(raw);
    return bans.has(raw) || bans.has(dest) || bans.has(tag);
  }
  function isIpDenied(sock, now = Date.now()) {
    const ip = sockIp(sock);
    if (!ip) return false;
    const until = Number(ipDeniedUntil.get(ip)) || 0;
    return until > now;
  }
  const lostPath = path.join(dataDir, 'lost-work.json');
  function loadLostWork() {
    try {
      const j = JSON.parse(fs.readFileSync(lostPath, 'utf8'));
      return {
        lostWorkHashes: Math.max(0, Math.floor(Number(j.lostWorkHashes) || 0)),
        lostWorkEvents: Math.max(0, Math.floor(Number(j.lostWorkEvents) || 0)),
      };
    } catch {
      return { lostWorkHashes: 0, lostWorkEvents: 0 };
    }
  }
  function saveLostWork() {
    try {
      fs.writeFileSync(lostPath, JSON.stringify({
        lostWorkHashes: Number(stats.lostWorkHashes) || 0,
        lostWorkEvents: Number(stats.lostWorkEvents) || 0,
      }));
    } catch { /* datadir may be read-only in tests */ }
  }
  const persistedLost = loadLostWork();
  const stats = {
    started: Date.now(),
    lastFoundAt: 0,
    findAt: [],
    foundAtByHeight: {},
    accepted: 0,
    stale: 0,
    blocks: 0,
    dropped: 0,
    lostWorkHashes: persistedLost.lostWorkHashes,
    lostWorkEvents: persistedLost.lostWorkEvents,
    hashBusy: 0,
    coin: 'SHE',
    algo: ALGO,
    stratum: `${stratumBindHost(stratumBind)}:${stratumPort}`,
  };
  function rememberPoolFind(height) {
    stats.lastFoundAt = Date.now();
    stats.findAt = Array.isArray(stats.findAt) ? stats.findAt : [];
    stats.findAt.push(stats.lastFoundAt);
    if (stats.findAt.length > 256) stats.findAt = stats.findAt.slice(-256);
    if (!stats.foundAtByHeight || typeof stats.foundAtByHeight !== 'object') stats.foundAtByHeight = {};
    const h = Math.floor(Number(height) || 0);
    if (h >= 1) stats.foundAtByHeight[String(h)] = stats.lastFoundAt;
    const keys = Object.keys(stats.foundAtByHeight);
    if (keys.length > 256) {
      keys.sort((a, b) => Number(a) - Number(b));
      for (let i = 0; i < keys.length - 256; i += 1) delete stats.foundAtByHeight[keys[i]];
    }
  }
  const pendingPulls = new Map();
  const idleMs = Number.isFinite(Number(noValidShareMs)) && Number(noValidShareMs) > 0
    ? Number(noValidShareMs)
    : NO_VALID_SHARE_MS;
  let dropTimer = null;

  function endSock(sock, payload) {
    if (!sock) return;
    try {
      if (payload) sock.end(payload);
      else sock.end();
    } catch {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    stats.dropped = (Number(stats.dropped) || 0) + 1;
  }

  function replyLine(sock, obj, { drop = false } = {}) {
    const payload = line(obj);
    if (drop) endSock(sock, payload);
    else {
      try { sock.write(payload); } catch { /* ignore */ }
    }
  }

  function rememberInvalid(session, extraLogin, sock) {
    const ip = sockIp(sock);
    if (!shouldDurableDestBan(session)) {
      if (ip) {
        const n = (Number(ipStrikes.get(ip)) || 0) + 1;
        ipStrikes.set(ip, n);
        if (n >= IP_SOFT_STRIKES) ipDeniedUntil.set(ip, Date.now() + BAN_TTL_MS);
      }
      return [];
    }
    const keys = banInvalidKeys({
      login: extraLogin || session?.login,
      workerKey: session?.workerKey || extraLogin,
    });
    let added = 0;
    for (const k of keys) {
      if (bans.has(k)) continue;
      bans.add(k);
      added += 1;
    }
    if (added) saveBans();
    return keys;
  }

  function rejectSubmit(sock, session, msg, reason) {
    paintReject(session, reason);
    const drop = shouldDropOnReject(session, reason);
    if (drop) rememberInvalid(session, undefined, sock);
    replyLine(sock, { id: msg.id, error: reason }, { drop });
  }

  function parentIntervalBits(at = null) {
    // Same quote template() seals: aserti3-2d for this header stamp.
    // A null here made sealReject ignore an undercut and leave the easier header up.
    try {
      const rows = store.blocks || [];
      let stamp = Number(at);
      if (!Number.isFinite(stamp)) {
        const tip = store.tip();
        if (tip?.header) {
          const parent = decodeHeader(Buffer.from(tip.header));
          const mtp = medianTimePast((rows).slice(-MTP_WINDOW).map((b) => {
            try { return Number(decodeHeader(Buffer.from(b.header)).timestamp); } catch { return 0; }
          }));
          stamp = templateStampMs(parent.timestamp, Date.now(), null, mtp);
        }
      }
      return retarget(rows, Number.isFinite(stamp) ? stamp : undefined);
    } catch {
      return null;
    }
  }

  function blockBitsNow() {
    const stable = parentIntervalBits();
    if (stable != null) return stable;
    return Number(lastJob?.blockBits || lastJob?.bits || bits);
  }

  function snapshotRound() {
    return [...miners.values()]
      .filter((m) => (m.roundHashes || 0) > 0)
      .map((m) => {
        const dest = hasherPayoutDest(m.login, {
          dest: m.payoutDest,
          height: Number(store.tip()?.height || 0) + 1,
        });
        if (!dest) return null;
        return {
          miner: dest,
          nonce: String(m.hashes || 0),
          tag: publicMinerTag(m.login || dest),
          count: roundActualHashes(m),
          proven: Number(m.roundHashes) || 0,
        };
      })
      .filter(Boolean);
  }

  let lastIssueAt = 0;
  let stallHeight = Number(store.tip()?.height || 0);
  let stallHeightSince = Date.now();
  let tipStallAlert = null;
  let stallReissueAt = 0;
  let stallReissueSeal = '';
  function noteStallHeight(now = Date.now()) {
    const h = Number(store.tip()?.height || 0);
    if (h !== stallHeight) {
      stallHeight = h;
      stallHeightSince = now;
    }
  }
  // '' when the live job can still seal on this tip. Otherwise a fail-closed
  // reason. Consensus bits are retarget(); this does not invent an easier target.
  let sidecarTip = null;
  let jobHoldLogged = false;
  /** Hold new jobs when the sidecar tip is strictly taller. The pool tip is not consensus. */
  const SIDECAR_AHEAD_HOLD = 1;
  function noteSidecarTip(tip) {
    const height = Number(tip?.height);
    if (!Number.isFinite(height)) return;
    sidecarTip = {
      height,
      hash: String(tip?.hash || '').replace(/^0x/i, '').toLowerCase(),
    };
    if (!sidecarAhead()) jobHoldLogged = false;
  }
  function sidecarAhead() {
    if (!sidecarTip) return false;
    const local = Number(store.tip()?.height || 0);
    return (sidecarTip.height - local) >= SIDECAR_AHEAD_HOLD;
  }
  function logJobHold() {
    if (jobHoldLogged || !sidecarTip) return;
    jobHoldLogged = true;
    try {
      console.error(JSON.stringify({
        event: 'job_hold',
        reason: 'sidecar_ahead',
        height: Number(store.tip()?.height || 0),
        sidecarHeight: Number(sidecarTip.height),
        gap: Number(sidecarTip.height) - Number(store.tip()?.height || 0),
      }));
    } catch { /* ignore */ }
  }
  function jobHoldReason() {
    return sidecarAhead() ? 'sidecar_ahead' : '';
  }
  function sealReject(now = Date.now()) {
    if (sidecarAhead()) return 'sidecar_ahead';
    if (!lastJob?.header) return 'no_job';
    const tip = store.tip();
    const tipHash = tip?.hash
      ? (Buffer.isBuffer(tip.hash) ? tip.hash.toString('hex') : String(tip.hash).replace(/^0x/i, '')).toLowerCase()
      : '';
    const prev = String(lastJob.prevBlockHash || '').replace(/^0x/i, '').toLowerCase();
    if (tipHash && prev !== tipHash) return 'parent';
    let decoded;
    try { decoded = decodeHeader(headerFromHex(lastJob.header)); }
    catch { return 'header'; }
    const ts = Number(decoded.timestamp);
    if (!tip?.header) {
      if (Number(decoded.bits) !== Number(GENESIS_BITS_PACKED)) return 'bits';
    } else {
      const quote = retargetQuote(store.blocks || [], ts);
      if (!quote?.ok || !bitsAcceptAsert(Number(decoded.bits), quote)) return 'bits';
    }
    if (!(ts > 0) || ts > Number(now) + HEADER_AHEAD_MS) return 'timestamp';
    if (tip?.header) {
      let parent;
      try { parent = decodeHeader(Buffer.from(tip.header)); }
      catch { return 'parent_header'; }
      if (!(ts > Number(parent.timestamp))) return 'timestamp';
      const mtp = medianTimePast((store.blocks || []).slice(-MTP_WINDOW).map((b) => {
        try { return Number(decodeHeader(Buffer.from(b.header)).timestamp); } catch { return 0; }
      }));
      if (ts > Number(mtp) + MTP_FUTURE_MS) return 'timestamp';
    }
    return '';
  }

  function liveJobCanSeal(now = Date.now()) {
    return sealReject(now) === '';
  }

  function watchTipStall(now = Date.now(), probe = null) {
    if (paused && !probe) {
      return { restamp: false, alert: false, restart: false, reason: '', restamped: false, reissued: false, seal: '' };
    }
    noteStallHeight(now);
    const rows = [...miners.values()];
    const live = {
      now,
      heightSinceMs: stallHeightSince,
      bits: displayBits(blockBitsNow()),
      lastFoundAt: Number(stats.lastFoundAt || 0),
      hashrate: rows.reduce((a, m) => a + (Number(m.hashrate) || 0), 0),
      miners: rows.length,
      shares: Number(stats.accepted || 0),
    };
    const decision = tipStallDecision(probe ? { ...live, ...probe, now: probe.now ?? now } : live);
    const stallClass = tipStallClass({
      tipAgeMs: Number(now) - Number(live.heightSinceMs || now),
      lastFoundAgeMs: Number(now) - Number(live.lastFoundAt || now),
      hashrate: live.hashrate,
      miners: live.miners,
      sealProgress: liveJobCanSeal(now),
      peerMaxStuck: false,
      ibdDead: false,
    });
    if (stallClass.klass === 'low-h' && liveJobCanSeal(now)) {
      tipStallAlert = {
        at: now,
        reason: 'low_h',
        jobId: lastJob ? String(lastJob.jobId || '') : '',
        reissued: false,
        text: stallClass.text,
      };
      return {
        restamp: false,
        alert: true,
        restart: false,
        reason: 'low_h',
        restamped: false,
        reissued: false,
        seal: 'ok',
        text: stallClass.text,
      };
    }
    if (!decision.restamp) {
      tipStallAlert = null;
      return { ...decision, restamped: false, reissued: false, seal: sealReject(now) || 'ok' };
    }
    // Keep a sealable header. A new job every restamp tick throws away the
    // multi-minute search miners are already hashing. Reissue only when this
    // header cannot seal, and only once per stall window while it still cannot.
    let job = lastJob;
    let reissued = false;
    if (!liveJobCanSeal(now)) {
      const why = sealReject(now);
      const due = (Number(now) - stallReissueAt) >= TIP_STALL_MS || why !== stallReissueSeal;
      if (due) {
        stallReissueAt = Number(now);
        stallReissueSeal = why;
        const next = issueJob(undefined, { force: true });
        if (next && liveJobCanSeal(now)) {
          job = next;
          reissued = true;
          broadcastJob(job);
          stallReissueSeal = '';
        } else if (next) {
          job = next;
        }
      }
    }
    const seal = sealReject(now);
    tipStallAlert = {
      at: now,
      reason: seal ? `${decision.reason}:${seal}` : decision.reason,
      jobId: job ? String(job.jobId || '') : '',
      reissued,
    };
    // A sealable header stays up. Reissue above runs only when this header
    // cannot seal. This watch does not log a restamp and it does not bounce.
    return {
      ...decision,
      restamped: !!(job && !seal),
      reissued,
      seal: seal || 'ok',
      jobId: tipStallAlert.jobId,
      blockBits: job ? Number(job.blockBits || job.bits) : null,
    };
  }
  function resetOpenRound({ sealed = false } = {}) {
    if (paused) return lastJob;
    if (!sealed) {
      for (const m of miners.values()) {
        const n = roundActualHashes(m);
        if (n > 0) {
          stats.lostWorkHashes = (Number(stats.lostWorkHashes) || 0) + n;
          stats.lostWorkEvents = (Number(stats.lostWorkEvents) || 0) + 1;
          saveLostWork();
        }
      }
    }
    pendingPayout = [];
    for (const m of miners.values()) {
      resetMinerRoundDisplay(m);
      // Share bits and the dest window stay. A new round is not a floor reset.
    }
    if (typeof store.clearOpenRound === 'function') store.clearOpenRound();
    const job = issueJob(undefined, { force: true });
    broadcastJob(job);
    return job;
  }

  if (typeof store.on === 'function') {
    store.on('reorg', () => {
      if (sealing) return;
      lag1Shares = [];
      openShares = [];
      resetOpenRound();
    });
    store.on('tip', (t) => {
      noteStallHeight(Date.now());
      if (sealing || t?.reorg) return;
      const tipHash = store.tip()
        ? Buffer.from(store.tip().hash).toString('hex')
        : '';
      if (lastJob && String(lastJob.prevBlockHash) === tipHash) return;
      resetOpenRound();
    });
  }

  function mempoolKey(list) {
    const ids = [];
    for (const t of list || []) {
      if (!t || t.coinbase) continue;
      const id = String(t.id || '');
      if (id) ids.push(id);
    }
    ids.sort();
    return ids.join('\n');
  }

  function mempoolDrifted() {
    return mempoolKey(store.mempool) !== packedMempoolKey;
  }

  function issueJob(shareBitsNow, { force = false } = {}) {
    if (sidecarAhead()) {
      logJobHold();
      return lastJob;
    }
    jobHoldLogged = false;
    // No explicit dial: keep the live job's bits. The opening floor is only
    // for the first template, before any dest has stepped.
    const carriedTemplate = shareBitsNow != null
      ? shareBitsNow
      : (Number(lastJob?.shareBits) > 0 ? lastJob.shareBits : shareBits);
    const sb = clampShareBits(carriedTemplate, { blockBits: blockBitsNow(), minBits: liveShareMin() });
    const now = Date.now();
    const liveBits = blockBitsNow();
    const tipNow = store.tip();
    const tipHash = tipNow
      ? (Buffer.isBuffer(tipNow.hash) ? tipNow.hash.toString('hex') : String(tipNow.hash))
      : '';
    const jobPrev = String(lastJob?.prevBlockHash || '');
    const parentOk = !tipHash || jobPrev === tipHash;
    // Same parent keeps the jobId while the mempool set is unchanged.
    // A gain or loss rebuilds so the job miners hash now includes that tx.
    // The previous job stays inside the share grace window.
    if (!force && lastJob && parentOk && !mempoolDrifted()) {
      lastIssueAt = now;
      if (Number(lastJob.shareBits) === sb) return lastJob;
      const hist = [...(lastJob.shareBitsHist || []), { bits: Number(lastJob.shareBits), at: now }]
        .filter((r) => now - Number(r.at || 0) < 12_000)
        .slice(-8);
      const job = {
        ...lastJob,
        shareBitsPrev: Number(lastJob.shareBits),
        shareBitsAt: now,
        shareBits: sb,
        shareBitsHist: hist,
      };
      lastJob = job;
      const rec = job.jobId ? store.jobs?.get?.(String(job.jobId)) : null;
      if (rec && rec.job) rec.job = job;
      return job;
    }
    const hasherRow = [...miners.values()].find((m) => !isCminerFeeLogin(m.workerKey || m.login))
      || [...miners.values()][0];
    const hasherPay = hasherPayoutDest(hasherRow?.login, {
      dest: hasherRow?.payoutDest,
      height: Number(store.tip()?.height || 0) + 1,
    });
    const poolPay = payoutDest(miner);
    const tipHdr = store.tip()?.header || null;
    lag1Shares = selectBlockShares(provenLag1Shares(tipHdr, lag1Shares));
    const live = snapshotRound();
    const potRows = live.map((s) => ({ miner: s.miner, count: Number(s.proven) || 0 })).filter((s) => s.count > 0);
    const wantPot = wantLivePot();
    // Pool path only. 99% PROP to this round's hashers, 1% to the fee wallet.
    // Solo never reaches this function.
    const ident = configuredFeeIdentity();
    if (!ident.ok) {
      console.error(JSON.stringify({ event: 'fee_dest_mismatch', reason: ident.reason }));
      return null;
    }
    const feeTo = ident.feeDest;
    const emptyRound = !lag1Shares.length && !potRows.length;
    const carryIn = Math.max(0, Math.floor(Number(store.tip()?.txs?.[0]?.carryNanos) || 0));
    // Fee is this block's subsidy only. Parent carry is miner pot and is not fee'd again.
    const feeNanos = Math.floor(wantPot * POOL_FEE_BPS / 10000);
    let potShares;
    if (emptyRound) {
      potShares = feeNanos > 0 && isDestAddress(feeTo)
        ? [{ address: feeTo, nanos: feeNanos, kind: 'pool-fee' }]
        : [];
    } else {
      potShares = potRoundShares({ lag1Shares, potRows, feeTo, wantPot });
      if (carryIn > 0) {
        const pots = potShares.filter((s) => s.kind !== 'pool-fee');
        if (pots.length) pots[pots.length - 1].nanos += carryIn;
      }
    }
    // she1 login may have no dest yet (dest arrives as owned ssa1). The header
    // still issues; shareBatch credit stays hasher dests only. An empty proven
    // round carries the miner pot and pays only this block's fee note.
    const payout = hasherPay
      || potShares.find((s) => s.kind === 'pot')?.address
      || poolPay
      || feeTo
      || poolFeeDest();
    if (!payout) return null;
    const samples = pendingPayout.filter((s) => (s.count || 0) > 0);
    // Block target is consensus next-work for this parent (retarget → nextBits).
    // `bits` / lockBits may size an empty book only. A live parent never
    // keeps that override. A share that misses the issued target is not a block.
    void lockBits;
    const { job, tpl } = store.template({
      miner: payout,
      samples,
      potShares,
      shareBits: sb,
      shareBatch: lag1Shares,
      poolDest: poolPay,
      wallIntervalMs: avgWallFindIntervalMs(stats.findAt),
    });
    const gate = gateJob(job);
    if (!gate.ok) return null;
    packedMempoolKey = mempoolKey(store.mempool);
    console.error(JSON.stringify({
      event: 'issue_job',
      jobId: job.jobId,
      userTxs: (tpl?.txs || []).slice(1).length,
      mempool: (store.mempool || []).length,
    }));
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
          // Do not copy the template shareBits onto the connection.
          // That value is the opening floor on a fresh job and slapped
          // stepped miners back to 8.
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
        const destKey = destShareBitsKey(m.login || m.payoutDest);
        const saved = destKey
          ? (destVarWindows.get(destKey)?.bits ?? destShareBitsOf(destShareBits, destKey, NaN))
          : NaN;
        const sb = carriedShareBits({
          saved: Number.isFinite(Number(saved)) ? Number(saved) : null,
          conn: c.shareBits,
          template: job.shareBits,
        }, { blockBits: blockBitsNow(), minBits: liveShareMin() });
        c.shareBits = sb;
        const payload = wireJob(job, sb);
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

  /** Public and admin shareBits. Min connected dest dial, never the template floor. */
  function liveShareBits() {
    const rows = [];
    for (const m of miners.values()) {
      if (!minerConnected(m)) continue;
      if (isCminerFeeLogin(m.workerKey || m.login)) continue;
      const destKey = destShareBitsKey(m.login || m.payoutDest);
      let saved = null;
      if (destKey) {
        const win = Number(destVarWindows.get(destKey)?.bits);
        if (Number.isFinite(win) && win > 0) saved = win;
        else {
          const disk = destShareBitsOf(destShareBits, destKey, NaN);
          if (Number.isFinite(disk) && disk > 0) saved = disk;
        }
      }
      let conn = null;
      for (const c of m.connections || []) {
        if (!c?.sock || c.shearFeeRoute) continue;
        const n = Number(c.shareBits);
        if (Number.isFinite(n) && n > 0 && (conn == null || n < conn)) conn = n;
      }
      rows.push({ connected: true, fee: false, saved, conn });
    }
    const jobBits = Number(lastJob?.shareBits);
    return selectLiveShareBits(rows, {
      blockBits: blockBitsNow(),
      minBits: liveShareMin(),
      fallback: Number.isFinite(jobBits) && jobBits > 0 ? jobBits : shareBits,
    });
  }

  /**
   * Every JOB_RESTAMP_MS, advance the live header timestamp on the same jobId.
   * Bits stay on the parent solve interval. A short in-progress stamp must not
   * retarget. rememberJobHeader keeps the previous header so in-flight shares
   * still count.
   */
  let lastEaseAt = Date.now();
  let restampTimer = null;
  function restampLiveHeader(now = Date.now()) {
    if (sidecarAhead()) {
      logJobHold();
      return lastJob;
    }
    if (!lastJob?.header) return lastJob;
    let decoded;
    try {
      decoded = decodeHeader(headerFromHex(lastJob.header));
    } catch {
      return lastJob;
    }
    const wall = Number(now);
    let stamp = wall;
    let overMtp = false;
    const tip = store.tip();
    if (tip?.header) {
      try {
        const parent = decodeHeader(Buffer.from(tip.header));
        const mtp = medianTimePast((store.blocks || []).slice(-MTP_WINDOW).map((b) => {
          try { return Number(decodeHeader(Buffer.from(b.header)).timestamp); } catch { return 0; }
        }));
        stamp = templateStampMs(parent.timestamp, wall, null, mtp);
        overMtp = Number(decoded.timestamp) > Number(mtp) + MTP_FUTURE_MS;
      } catch { /* keep live stamp */ }
    }
    if (stamp > wall && !overMtp) return lastJob;
    if (stamp <= Number(decoded.timestamp) && !overMtp) return lastJob;
    const header = encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: decoded.merkleRoot,
      continuityRoot: decoded.continuityRoot,
      timestamp: BigInt(stamp),
      bits: decoded.bits,
      nonce: 0n,
      baseFee: decoded.baseFee,
    });
    const hex = header.toString('hex');
    rememberJobHeader(lastJob, lastJob.header);
    lastJob = {
      ...lastJob,
      header: hex,
      timestamp: String(stamp),
    };
    const rec = store.jobs.get(String(lastJob.jobId));
    if (rec) {
      rec.tpl = { ...rec.tpl, header };
      rec.job = lastJob;
    }
    return lastJob;
  }
  function maybeRestampJob(now = Date.now()) {
    watchTipStall(now);
    if (paused) return lastJob;
    if (!lastJob) return lastJob;
    const wall = Number(now);
    if ((wall - lastEaseAt) < JOB_RESTAMP_MS) return lastJob;
    lastEaseAt = wall;
    const tip = store.tip();
    if (tip?.header) {
      try {
        const parent = decodeHeader(Buffer.from(tip.header));
        const decoded = decodeHeader(headerFromHex(lastJob.header));
        const mtp = medianTimePast((store.blocks || []).slice(-MTP_WINDOW).map((b) => {
          try { return Number(decodeHeader(Buffer.from(b.header)).timestamp); } catch { return 0; }
        }));
        const stamp = templateStampMs(parent.timestamp, wall, null, mtp);
        const quote = retargetQuote(store.blocks || [], stamp);
        // Past 8·T the same job eases to the verify floor. Before that window
        // a sealable header stays up so a short tick does not restart the search.
        const easing = !!(quote?.ok && quote.easeBits > 0);
        const wantBits = quote?.ok
          ? (easing ? quote.eased : quote.packed)
          : (parentIntervalBits(stamp) ?? decoded.bits);
        const liveTs = Number(decoded.timestamp);
        const overMtp = liveTs > Number(mtp) + MTP_FUTURE_MS;
        if (!easing && !overMtp && Number(decoded.bits) === Number(wantBits)) {
          if (liveJobCanSeal(wall)) return lastJob;
          const before = String(lastJob.header || '');
          const job = restampLiveHeader(wall);
          if (job && String(job.header || '') !== before) broadcastJob(job);
          return job;
        }
        const header = encodeHeader({
          version: decoded.version,
          prevBlockHash: decoded.prevBlockHash,
          merkleRoot: decoded.merkleRoot,
          continuityRoot: decoded.continuityRoot,
          timestamp: BigInt(stamp),
          bits: wantBits,
          nonce: 0n,
          baseFee: decoded.baseFee,
        });
        rememberJobHeader(lastJob, lastJob.header);
        lastJob = {
          ...lastJob,
          header: header.toString('hex'),
          timestamp: String(stamp),
          bits: wantBits,
          blockBits: wantBits,
        };
        const rec = store.jobs.get(String(lastJob.jobId));
        if (rec) {
          rec.tpl = { ...rec.tpl, header, bits: wantBits };
          rec.job = lastJob;
        }
        broadcastJob(lastJob);
        return lastJob;
      } catch { /* keep live job */ }
    }
    return lastJob;
  }

  function resolveSubmitJob(params, conn) {
    const id = String(params?.jobId || '');
    const byId = id ? store.jobs.get(id)?.job : null;
    const liveId = String(lastJob?.jobId || '');
    if (byId && String(byId.jobId) === liveId) {
      return { job: byId, closedRound: false, stale: false };
    }
    const livePrev = String(lastJob?.prevBlockHash || '');
    const byPrev = String(byId?.prevBlockHash || '');
    if (byId && livePrev && byPrev === livePrev) {
      /* Same parent, new jobId is a new round (force template / next block).
       * Credit accepted, but do not add to this round's hash-bonus. */
      return { job: byId, closedRound: true, stale: false };
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
      replyLine(sock, { id: msg.id, error: 'paused' });
      return;
    }
    const claimed = submittedShareDigest(params);
    if (!claimed) {
      rejectSubmit(sock, session, msg, 'need_hash');
      return;
    }
    const resolved = resolveSubmitJob(params, conn);
    const job = resolved.job || passed;
    if (resolved.stale) {
      paintReject(session, 'stale_job');
      replyLine(sock, { id: msg.id, error: 'stale_job' });
      return;
    }
    const closedRound = !!resolved.closedRound;
    const destPay = hasherPayoutDest(session?.login, {
      dest: session?.payoutDest,
      height: Number(store.tip()?.height || 0) + 1,
    });
    let scored;
    try {
      scored = await scoreShareLive({ job, nonce: params.nonce, claimed, conn, dest: destPay });
    } catch (e) {
      const reason = hashWorkerRejectReason(e);
      // A share already accepted can still have a sibling hash in flight.
      // close() rejects that hash with "closed". That is not a hash failure.
      if (reason === 'closed') return;
      if (reason === 'busy') stats.hashBusy = (Number(stats.hashBusy) || 0) + 1;
      try {
        console.error(JSON.stringify({
          event: 'share_hash_backend',
          reason,
          error: String(e?.message || e).slice(0, 180),
          worker: String(session?.workerKey || session?.login || ''),
        }));
      } catch { /* ignore */ }
      replyLine(sock, { id: msg.id, error: reason });
      return;
    }
    if (!scored.ok) {
      if (scored.reason === 'bad_hash') {
        try {
          console.error(JSON.stringify({
            event: 'share_bad_hash',
            nonce: String(params.nonce || ''),
            claimed,
            computed: scored.hash || '',
            jobId: job?.jobId || '',
            hist: Array.isArray(job?.headerHistory) ? job.headerHistory.length : 0,
            header: String(scored.hashedHeader || job?.header || ''),
            worker: String(session?.workerKey || session?.login || ''),
          }));
        } catch { /* ignore */ }
      }
      rejectSubmit(sock, session, msg, scored.reason);
      return;
    }
    if (scored.hash !== claimed) {
      try {
        console.error(JSON.stringify({
          event: 'share_bad_hash',
          nonce: String(params.nonce || ''),
          claimed,
          computed: scored.hash || '',
          jobId: job?.jobId || '',
          hist: Array.isArray(job?.headerHistory) ? job.headerHistory.length : 0,
          header: String(job?.header || ''),
          worker: String(session?.workerKey || session?.login || ''),
        }));
      } catch { /* ignore */ }
      rejectSubmit(sock, session, msg, 'bad_hash');
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
      const hashBuf = Buffer.from(String(scored.hash || ''), 'hex');
      if (isDestAddress(destPay) && hashBuf.length === 32 && shareMeetsFloor(hashBuf, { dest: destPay }, SHARE_FLOOR_BITS)) {
        const rec = {
          dest: destPay,
          dest20: hash20FromAddress(destPay),
          nonce: BigInt(params.nonce),
          hash: String(scored.hash || ''),
          jobId: String(job?.jobId || ''),
          lz: Number(scored.bitsMet) & 0xff,
          verifiedHeader: Buffer.isBuffer(scored.header)
            ? scored.header.toString('hex').toLowerCase()
            : String(job?.header || '').toLowerCase(),
        };
        const opened = rememberOpenShare(openShares, rec);
        if (opened.ok) rememberLiveSharePow(scored.header || job?.header, params.nonce);
      }
      const credited = Number(scored.creditedShareBits || 0);
      const proven = credited > 0 ? hashesProvenByShare(credited) : 0;
      if (!closedRound && proven > 0) {
        session.roundHashes += proven;
        session.hashes += proven;
      }
      session.seen = Date.now();
      session.lastShareAt = session.seen;
      if (!closedRound && proven > 0) {
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
    let sealedBlock = false;
    if (scored.block && !closedRound && sidecarAhead()) {
      logJobHold();
    } else if (scored.block && !closedRound) {
      sealing = true;
      const jid = String(params.jobId || job.jobId || '');
      const rec = jid ? store.jobs.get(jid) : null;
      if (rec && scored.header) rec.tpl = { ...rec.tpl, header: scored.header };
      const got = await Promise.resolve(store.submitHeader({
        jobId: jid,
        nonce: params.nonce,
        miner: hasherPayoutDest(session?.login, {
          dest: session?.payoutDest,
          height: Number(store.tip()?.height || 0) + 1,
        }),
        powHash: scored.hash,
      }, { trusted: true }));
      sealing = false;
      if (got?.ok) {
        sealedBlock = true;
        stats.blocks += 1;
        lag1Shares = selectBlockShares(openShares.slice());
        openShares = [];
        try {
          const sealed = store.tip();
          // Wall clock, not header time: the job stamp may be 90s ahead of now.
          const sealedH = Number(sealed?.height || 0);
          rememberPoolFind(sealedH);
          const unit = hashBonusUnitNanos(store.reserveVault?.liveHashBonusNanos);
          const hashPays = hashBonusByMiner([], unit, lag1Shares);
          pullBook.creditRound(
            [...miners.values()]
              .filter((m) => (Number(m.roundHashes) || 0) > 0 && !isCminerFeeLogin(m.login || m.workerKey))
              .map((m) => ({
                tag: publicMinerTag(m.login || m.workerKey),
                dest: hasherPayoutDest(m.login, {
                  dest: m.payoutDest,
                  height: sealedH,
                }),
                count: roundActualHashes(m),
              })),
            {
              height: sealedH,
              nanos: 0,
              hashByDest: pullBookHashLeg(hashPays),
              hashUnit: unit,
              finderTag: publicMinerTag(session?.login || session?.workerKey),
              finderWorker: publicWorkerName(session?.workerKey || session?.login),
            },
          );
        } catch {
          rememberPoolFind(Number(store.tip()?.height || 0));
        }
        if (session) session.blocks = (Number(session.blocks) || 0) + 1;
        pendingPayout = snapshotRound();
        for (const m of miners.values()) resetMinerRoundDisplay(m);
        if (typeof store.clearOpenRound === 'function') store.clearOpenRound();
        const base = issueJob(undefined, { force: true });
        broadcastJob(base);
        console.log(JSON.stringify({
          event: 'vardiff_carry',
          template: Number(base?.shareBits) || 0,
          live: [...destVarWindows.values()].map((w) => Number(w?.bits)).filter((n) => n > 0),
          touched: false,
        }));
        nextJob = true;
      } else {
        console.error(JSON.stringify({
          event: 'seal_failed',
          reason: String(got?.reason || 'append'),
          error: got?.error,
          jobId: jid,
          height: Number(store.tip()?.height || 0) + 1,
        }));
        try {
          const base = issueJob(undefined, { force: true });
          if (base) {
            broadcastJob(base);
            nextJob = true;
          }
        } catch { /* keep live job */ }
      }
    }
    try {
      sock.write(line({
        id: msg.id,
        result: { status: 'OK', hash: scored.hash, block: sealedBlock },
      }));
    } catch { /* ignore */ }
    if (!paused && !nextJob && !closedRound && conn && !conn.shearFeeRoute && !isCminerFeeLogin(session?.workerKey || session?.login) && Number(scored.creditedShareBits) > 0) {
      const destKey = destShareBitsKey(session?.login || session?.payoutDest);
      if (destKey) {
        const now = Date.now();
        const curBits = clampShareBits(
          destVarWindows.get(destKey)?.bits ?? destShareBitsOf(destShareBits, destKey, conn.shareBits),
          { blockBits: blockBitsNow(), minBits: liveShareMin() },
        );
        const prev = destVarWindows.get(destKey) || {
          shares: 0,
          windowAt: now,
          bits: curBits,
          lastStepAt: 0,
          suppressClimb: false,
        };
        const step = destVardiffOnShare({
          state: { ...prev, bits: curBits },
          now,
          blockBits: blockBitsNow(),
          minBits: liveShareMin(),
        });
        destVarWindows.set(destKey, {
          shares: step.shares,
          windowAt: step.windowAt,
          bits: step.bits,
          lastStepAt: step.lastStepAt || 0,
          suppressClimb: step.suppressClimb === true,
        });
        if (Number.isFinite(Number(step.intervalMs)) && !step.stepped && !step.heldClimb) {
          console.log(JSON.stringify({
            event: 'vardiff_window',
            destTail: String(destKey).slice(-4),
            from: step.from,
            to: step.bits,
            move: step.move,
            reason: step.reason,
            shares: step.sampleShares,
            elapsedMs: Math.round(Number(step.elapsedMs) || 0),
            intervalMs: Math.round(Number(step.intervalMs) || 0),
            targetMs: SHARE_VARDIFF_TARGET_MS,
            deadbandLowMs: SHARE_VARDIFF_DEADBAND_LOW_MS,
            easeAboveMs: SHARE_VARDIFF_TARGET_MS,
            findTouched: false,
            window: true,
          }));
        }
        if (step.heldClimb) {
          console.log(JSON.stringify({
            event: 'vardiff_hold',
            destTail: String(destKey).slice(-4),
            from: step.from,
            to: step.bits,
            move: 'hold',
            reason: 'post_ease_hold',
            shares: step.sampleShares,
            elapsedMs: Math.round(Number(step.elapsedMs) || 0),
            intervalMs: Math.round(Number(step.intervalMs) || 0),
            targetMs: SHARE_VARDIFF_TARGET_MS,
            deadbandLowMs: SHARE_VARDIFF_DEADBAND_LOW_MS,
            easeAboveMs: SHARE_VARDIFF_TARGET_MS,
            findTouched: false,
            window: true,
          }));
        }
        if (step.stepped) {
          /* Dest aggregate. Never rewrite lastJob.shareBits — a farm target
           * on the shared job rejected 1-thread dest-bound shares as low_diff. */
          console.log(JSON.stringify({
            event: 'vardiff_step',
            destTail: String(destKey).slice(-4),
            from: step.from,
            to: step.bits,
            move: step.move,
            movedBits: step.movedBits,
            reason: step.reason,
            shares: step.sampleShares,
            elapsedMs: Math.round(Number(step.elapsedMs) || 0),
            intervalMs: Math.round(Number(step.intervalMs) || 0),
            targetMs: SHARE_VARDIFF_TARGET_MS,
            deadbandLowMs: SHARE_VARDIFF_DEADBAND_LOW_MS,
            easeAboveMs: SHARE_VARDIFF_TARGET_MS,
            findTouched: false,
            window: true,
          }));
          pushDestShareBits(destKey, step.bits);
        }
      }
    }
  }

  const sockets = new Set();
  function onStratum(sock) {
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
          const adm = gateStratumLogin(params, { requireLoginAuth, boundAuthPub });
          if (!adm.ok) {
            if (isWrongAlgoReject(adm.reason)) {
              rememberInvalid(null, String(params.login || params.user || ''), sock);
            }
            const extra = adm.reason === 'need_auth' && adm.challenge ? { challenge: adm.challenge } : {};
            replyLine(sock, { id: msg.id, error: adm.reason, ...extra }, { drop: true });
            continue;
          }
          if (isIpDenied(sock) || isBanned(adm.workerKey) || isBanned(adm.login)) {
            replyLine(sock, { id: msg.id, error: 'banned' }, { drop: true });
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
            payoutDest: adm.payoutDest || '',
          };
          if (adm.payoutDest) {
            session.payoutDest = adm.payoutDest;
            if (typeof pullBook.bindDest === 'function') {
              pullBook.bindDest(publicMinerTag(adm.login), adm.payoutDest);
            }
          }
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
            shareBits: clampShareBits(
              destShareBitsOf(destShareBits, adm.login, shareBits),
              { blockBits: blockBitsNow(), minBits: liveShareMin() },
            ),
            varShares: 0,
            varWindowAt: Date.now(),
            seen: Date.now(),
            authedAt: Date.now(),
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
          sock.write(line({ id: msg.id, result: { status: 'OK' }, job: wireJob(job, conn.shareBits) }));
          continue;
        }
        if (method === 'stats') {
          if (session) applyMinerSelfRate(session, params);
          continue;
        }
        if (method === 'submit') {
          const ipBudget = noteIpSubmit(ipSubmitAt, sockIp(sock));
          if (!ipBudget.ok) {
            stats.hashBusy = (Number(stats.hashBusy) || 0) + 1;
            replyLine(sock, { id: msg.id, error: 'busy' });
            continue;
          }
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
          // Close can reject an in-flight hash after the socket handler has
          // moved on. A floating rejection there must not fail the process.
          void acceptSubmit(captured).catch((err) => {
            try {
              console.error(JSON.stringify({
                event: 'share_submit_unhandled',
                error: String(err?.message || err).slice(0, 180),
              }));
            } catch { /* ignore */ }
          });
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
  }

  const stratum = net.createServer(onStratum);
  let stratumTls = null;

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
      provenHashes: roundActualHashes(m),
      proven_round: roundActualHashes(m),
      accepted: m.accepted || 0,
      stale: m.stale || 0,
      blocks: Number(m.blocks) || 0,
      blocksSession: Number(m.blocks) || 0,
      blocksLifetime: Number(pullBook.view(publicMinerTag(m.login || m.workerKey)).foundBlocks) || 0,
      threads: m.threads || 0,
      sessions: m.sessions || (m.connections || []).length,
      connected,
      lastSeen: Number(m.seen) || 0,
      firstSeen: Number(m.firstSeen) || Number(m.seen) || 0,
    };
  }

  let statsSnap = { at: 0, json: '{"ok":true}' };
  let statsTimer = null;
  let payoutTimer = null;
  let payoutSweepBusy = false;
  let payoutSweepAgain = false;
  let autoPayoutLastError = null;
  let jobDirty = false;
  function paintStatsSnap() {
    try {
      const rows = openRoundHashRows(miners, hashBonusUnitNanos(store.reserveVault?.liveHashBonusNanos))
        .map((r) => ({ tag: r.tag, count: r.count }));
      if (typeof store.noteOpenRound === 'function') store.noteOpenRound(rows, { source: 'local' });
      if (typeof p2pNet?.publishWork === 'function') p2pNet.publishWork(rows);
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
    const findDts = intervalDeltasMs(stats.findAt);
    const avgMs = ewmaBlockIntervalMs(findDts);
    const medianMs = medianBlockIntervalMs(findDts);
    const supply = networkSupply(store);
    let genesisMs = Date.now();
    try {
      const g = store.blocks?.[0];
      if (g?.header) genesisMs = Number(decodeHeader(Buffer.from(g.header)).timestamp) || genesisMs;
    } catch { /* wall */ }
    const ev = epochView({ nowMs: Date.now(), genesisMs, magic: MAGIC_TESTNET });
    const feeIdent = configuredFeeIdentity();
    const feePublish = feeIdent.ok && isDestAddress(feeIdent.feeDest)
      ? feeIdent.feeDest
      : THIS_POOL_DIRECT_FEE_DEST;
    return narrowPublicStats({
      ok: true,
      coin: 'SHE',
      algo: ALGO,
      personalisation: PERSONAL,
      rxMode: 'light',
      magic: MAGIC_TESTNET,
      network: MAGIC_TESTNET,
      targetBlockIntervalMs: TARGET_BLOCK_INTERVAL_MS,
      blockSubsidyNanos: ev.potNanos,
      epoch: ev.epoch,
      epochDays: ev.epochDays,
      nextPotNanos: ev.nextPotNanos,
      potFloorNanos: ev.floorNanos,
      tailActive: ev.tailActive,
      epochRemainMs: ev.remainMs,
      hashBonusNanos: hashBonusUnitNanos(store.reserveVault?.liveHashBonusNanos),
      hashTxLive: HASH_TX_LIVE,
      admit: 'ADMITv2',
      bookLawFingerprint: consensusFingerprint(),
      ...consensusLaw(),
      policy: typeof store.getpolicy === 'function' ? store.getpolicy() : undefined,
      frozen: typeof store.getpolicy === 'function' ? !!store.getpolicy().frozen : false,
      confirmedNeed: (typeof store.getpolicy === 'function' ? (store.getpolicy().operational?.pool_merchant || 30) : 30),
      stratum: `:${stratumPort}`,
      stratumBind: stratumBindHost(stratumBind),
      poolFeeBps: POOL_FEE_BPS,
      feeDest: feePublish,
      feeDestTail: String(feePublish).slice(-4),
      lostWorkHashes: Number(stats.lostWorkHashes) || 0,
      lostWorkEvents: Number(stats.lostWorkEvents) || 0,
      hashBusy: Number(stats.hashBusy) || 0,
      hashQueue: hashWait.size,
      topDestSharePct: topDestSharePct(workers),
      shareBlockRatio: (Number(stats.blocks) || 0) > 0
        ? (Number(stats.accepted) || 0) / Number(stats.blocks)
        : 0,
      alerts: {
        ...statsAlerts({
          topDestSharePct: topDestSharePct(workers),
          shareBlockRatio: (Number(stats.blocks) || 0) > 0
            ? (Number(stats.accepted) || 0) / Number(stats.blocks)
            : 0,
          stratumBind,
          requireLoginAuth,
        }),
        tipStall: !!tipStallAlert,
        tipStallReason: tipStallAlert?.reason || '',
        tipStallJobId: tipStallAlert?.jobId || '',
        tipStallAt: Number(tipStallAlert?.at || 0),
        tipStallReissued: !!tipStallAlert?.reissued,
      },
      blockBitsLabel: 'consensus blockBits (median11 next-work). Not share vardiff.',
      shareBitsLabel: 'shareBits (vardiff). Not a retarget.',
      stratumConfigSource: stratumConfigSourceOf({ bind: stratumBind, requireLoginAuth }),
      stratumCleartext: stratumListenPlan({
        bind: stratumBind, hasTls: !!(tlsCert && tlsKey), requireTls, labCleartext,
      }).cleartext,
      stratumTls: stratumListenPlan({
        bind: stratumBind, hasTls: !!(tlsCert && tlsKey), requireTls, labCleartext,
      }).tls,
      stratumListenOk: stratumListenPlan({
        bind: stratumBind, hasTls: !!(tlsCert && tlsKey), requireTls, labCleartext,
      }).ok,
      stratumTlsPort: (tlsCert && tlsKey) ? Number(tlsPort) : 0,
      stratumCleartextWarning: 'Stratum cleartext stays only for loopback or an explicit lab flag. Public bind needs TLS.',
      autoPayoutMinNanos: AUTO_PAYOUT_MIN_NANOS,
      autoPayoutMinShe: AUTO_PAYOUT_MIN_NANOS / NANOS_PER_SHE,
      autoPayoutDest: 'ssa1',
      autoPayoutLastError,
      poolFeeOnPotOnly: true,
      hashBonusPoolFeeBps: 0,
      loginAuth: requireLoginAuth ? 'ed25519' : 'dest-only',
      bootPoolOperator: { signed: !!operatorSpendKey },
      gitHead: gitHeadOf(),
      productVersion: PRODUCT_VERSION,
      proof: 'PoW',
      miners: workers.length,
      threads: workers.reduce((a, m) => a + (m.threads || 0), 0),
      hashrate: workers.reduce((a, m) => a + (Number(m.hashrate) || 0), 0),
      networkRoundHashes: networkRoundHashesOf(
        miners,
        [
          ...(typeof store.openRoundRows === 'function' ? store.openRoundRows() : []),
          ...(Array.isArray(networkView?.rounds) ? networkView.rounds : []),
        ],
      ),
      blocks: stats.blocks,
      blocksSession: stats.blocks,
      blocksLifetime: typeof pullBook.sealsLifetime === 'function' ? pullBook.sealsLifetime() : 0,
      sealsLifetime: typeof pullBook.sealsLifetime === 'function' ? pullBook.sealsLifetime() : 0,
      rewardIdentity: 'shareBatch-prop-after-fee',
      rewardCopy: 'Rewards share the block pot by round work after the 1% pool fee — not one SHE per block you found.',
      reconcile: typeof pullBook.reconcile === 'function' ? pullBook.reconcile() : undefined,
      accepted: stats.accepted,
      stale: stats.stale,
      circulatingNanos: supply.circulatingNanos,
      supplyStatus: supply.supplyStatus === 'verified' ? 'verified' : 'mismatch',
      supplyDifferenceNanos: Number(supply.differenceNanos) || 0,
      schedulePotNanos: Number(supply.schedulePotNanos) || 0,
      potEmittedNanos: supply.potNanos,
      hashBonusEmittedNanos: supply.hashNanos,
      extraMintedNanos: supply.extraMintNanos,
      burnedNanos: supply.burnedNanos,
      reserveMintedNanos: supply.reserveMintedNanos || 0,
      reserveVaultNanos: supply.vaultNanos || 0,
      accruingNanos: supply.accruingNanos || 0,
      height: tip?.height || 0,
      header: tip?.header ? Buffer.from(tip.header).toString('hex') : '',
      bits: displayBits(blockBitsNow()),
      bitsPacked: Number(blockBitsNow()),
      liveMinBits: LIVE_MIN_BITS,
      maxBits: MAX_BITS,
      blockBits: Number(blockBitsNow()),
      shareBits: liveShareBits(),
      lastFoundAt: stats.lastFoundAt || 0,
      avgBlockTimeMs: avgMs,
      networkAvgBlockTimeMs: avgBlockIntervalMs(store.blocks),
      interval: intervalCertify({
        sealedSamples: Math.max(0, (Array.isArray(store.blocks) ? store.blocks.length : 0) - 1),
        ewmaMs: avgMs,
        sealedMeanMs: avgBlockIntervalMs(store.blocks),
      }),
      avgBlockTimeMedianMs: medianMs,
      avgBlockWindow: findDts.length,
      nodesOnline: nodesOnline(),
      uptimeMs: Date.now() - stats.started,
      workers,
      gossipWorkers: (networkView?.rounds || []).map((r) => ({
        miner: r.tag,
        worker: r.tag,
        connected: true,
        roundHashes: r.count,
      })),
      recentTxs: poolRecentBlockTxs(store, 10).map((t) => {
        const h = Number(t?.height) || 0;
        const stored = (typeof pullBook.finderOf === 'function') ? pullBook.finderOf(h) : null;
        let tag = stored?.tag || '';
        let worker = stored?.worker || '';
        if (!tag && h >= 1) {
          const blocks = Array.isArray(store?.blocks) ? store.blocks : [];
          const b = blocks.find((x) => Number(x?.height) === h);
          if (b?.miner) tag = publicMinerTag(b.miner);
        }
        if (tag && !worker) {
          const live = minerByTag(tag);
          const names = new Set();
          for (const m of live) names.add(publicWorkerName(m.workerKey || m.login));
          if (names.size === 1) worker = [...names][0];
        }
        const wall = Math.floor(Number(stats.foundAtByHeight?.[String(h)] || 0));
        const attributed = !!((stored && stored.tag) || wall > 0);
        const row = {
          ...t,
          finder: tag || '',
          finderWorker: worker || '',
          foundAt: wall > 0 ? wall : 0,
        };
        if (attributed) row.poolFound = true;
        else if (!tag) row.poolFound = false;
        return row;
      }),
    });
  }
  paintStatsSnap();

  function minerByTag(tag, now = Date.now()) {
    const want = String(tag || '').trim().toLowerCase();
    if (!/^m[0-9a-f]{8}$/.test(want)) return [];
    return [...miners.values()].filter((m) => (
      publicMinerTag(m.login || m.workerKey) === want
      && isPublicMinerRow(m, now)
    ));
  }

  function publicMinerLedger(rows) {
    return (Array.isArray(rows) ? rows : []).map((r) => {
      const block = Math.floor(Number(r?.blockRwdNanos) || 0);
      const fee = Math.floor(Number(r?.poolFeeNanos) || 0);
      return {
        height: Number(r?.height) || 0,
        blockRwdNanos: block,
        poolFeeNanos: fee,
        totalNanos: block,
      };
    });
  }

  /** Pot shares already on the public ledger, split at the spendable floor.
   *  Hash amounts stay off this object. */
  function publicPotBanner(rows, tipHeight) {
    let pending = 0;
    let confirmed = 0;
    let block = 0;
    let fee = 0;
    let earned = 0;
    const tip = Number(tipHeight) || 0;
    for (const r of rows) {
      const pot = Math.floor(Number(r?.blockRwdNanos) || 0);
      const rowFee = Math.floor(Number(r?.poolFeeNanos) || 0);
      const rowTotal = Math.floor(Number(r?.totalNanos) || 0);
      block += pot;
      fee += rowFee;
      earned += rowTotal;
      const h = Number(r?.height) || 0;
      const confs = tip >= h && h >= 1 ? tip - h + 1 : 0;
      if (confs >= SPENDABLE_CONFIRMATIONS) confirmed += pot;
      else pending += pot;
    }
    return { pending, confirmed, block, fee, earned };
  }

  function minerPublicJson(tag, now = Date.now()) {
    const rows = minerByTag(tag, now);
    const tipH = Number(store.tip?.()?.height || 0);
    const policy = typeof store.getpolicy === 'function' ? store.getpolicy() : {};
    const need = (policy?.operational?.pool_merchant || 30);
    const pull = pullBook.view(tag, { tipHeight: tipH, need });
    const held = pullBook.ledger(tag);
    const known = typeof pullBook.hasTag === 'function' ? pullBook.hasTag(tag) : false;
    if (!rows.length && !(pull.pendingNanos > 0) && !pull.lastPullMs && !held.length && !known) {
      return { ok: false, reason: 'unknown_miner', tag };
    }
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
    const liveDest = rows.map((m) => hasherPayoutDest(m.login, { dest: m.payoutDest })).find(Boolean) || '';
    const dest = pull.dest || liveDest;
    const ledger = publicMinerLedger(typeof pullBook.ledger === 'function' ? pullBook.ledger(tag) : []);
    const banner = publicPotBanner(ledger, tipH);
    return {
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
      blocksSession: Number(roll.blocks) || 0,
      blocksLifetime: Number(pull.foundBlocks) || 0,
      blocks: Math.max(Number(roll.blocks) || 0, Number(pull.foundBlocks) || 0),
      confirmRemain: Number(pull.confirmRemain) || 0,
      oldestUnconfirmedHeight: Number(pull.oldestUnconfirmedHeight) || 0,
      workers: views,
      pendingShe: pull.pendingNanos / NANOS_PER_SHE,
      confirmedShe: pull.sentNanos / NANOS_PER_SHE,
      unconfirmedShe: pull.unconfirmedNanos / NANOS_PER_SHE,
      unconfirmedDisplay: formatShe(pull.unconfirmedNanos / NANOS_PER_SHE),
      creditConfirmedShe: pull.confirmedNanos / NANOS_PER_SHE,
      creditConfirmedDisplay: formatShe(pull.confirmedNanos / NANOS_PER_SHE),
      confirmNeed: need,
      frozen: !!policy.frozen,
      freeze_reason: policy.freeze_reason || '',
      freeze_banner: policy.freeze_banner || '',
      pendingDisplay: formatShe(pull.pendingNanos / NANOS_PER_SHE),
      confirmedDisplay: formatShe(pull.sentNanos / NANOS_PER_SHE),
      sentNanos: pull.sentNanos,
      sentShe: pull.sentNanos / NANOS_PER_SHE,
      sentDisplay: formatShe(pull.sentNanos / NANOS_PER_SHE),
      destRedacted: dest ? redactSsa1(dest) : (pull.destRedacted || 'ssa1********'),
      hasPayoutDest: !!dest,
      confirmedSentLabel: dest
        ? `Confirmed sent to ${redactSsa1(dest)}`
        : 'No valid ssa1 on this miner login',
      pendingConfirmShe: banner.pending / NANOS_PER_SHE,
      pendingConfirmDisplay: formatShe(banner.pending / NANOS_PER_SHE),
      confirmedSentShe: banner.confirmed / NANOS_PER_SHE,
      confirmedSentDisplay: formatShe(banner.confirmed / NANOS_PER_SHE),
      totals: {
        blockRwdNanos: banner.block,
        poolFeeNanos: banner.fee,
        totalNanos: banner.earned,
      },
      autoPayoutMinNanos: AUTO_PAYOUT_MIN_NANOS,
      autoPayoutMinShe: AUTO_PAYOUT_MIN_NANOS / NANOS_PER_SHE,
      lastPullMs: pull.lastPullMs,
      nextPullMs: pull.nextPullMs,
      cooldownMs: PULL_COOLDOWN_MS,
      ledger,
      ...(autoPayoutLastError && autoPayoutLastError.tag === tag
        ? { autoPayoutLastError }
        : {}),
    };
  }

  function wantLivePot() {
    try {
      const g = store.blocks?.[0];
      const genesisMs = g?.header
        ? Number(decodeHeader(Buffer.from(g.header)).timestamp) || Date.now()
        : Date.now();
      return epochView({ nowMs: Date.now(), genesisMs, magic: MAGIC_TESTNET }).potNanos;
    } catch {
      return BLOCK_SUBSIDY_NANOS;
    }
  }

  function runAutoPayoutSweep() {
    if (payoutSweepBusy) {
      payoutSweepAgain = true;
      return Promise.resolve([]);
    }
    payoutSweepBusy = true;
    const t0 = Date.now();
    console.error(JSON.stringify({ event: 'auto_payout_begin', at: t0 }));
    return (async () => {
      try {
        return await sweepAutoPayouts({
          maxRows: PAYOUT_SWEEP_MAX_ROWS,
          budgetMs: PAYOUT_SWEEP_BUDGET_MS,
        });
      } catch (err) {
        console.error(JSON.stringify({
          event: 'auto_payout_error',
          error: String(err && err.message ? err.message : err),
        }));
        return [];
      } finally {
        console.error(JSON.stringify({ event: 'auto_payout_end', ms: Date.now() - t0 }));
        payoutSweepBusy = false;
        if (payoutSweepAgain) {
          payoutSweepAgain = false;
          setImmediate(runAutoPayoutSweep);
        }
      }
    })();
  }

  function refreshOperatorSpendKey() {
    if (operatorSpendKey) return operatorSpendKey;
    try {
      const boot = bootPoolOperator({ dataDir, minerEnv: miner });
      if (boot.operatorSpendKey) operatorSpendKey = boot.operatorSpendKey;
    } catch { /* keep unsigned until a matching seed is on disk */ }
    return operatorSpendKey;
  }

  function recordAutoPayoutError({ tag, reason, have, need, from } = {}) {
    autoPayoutLastError = {
      at: Date.now(),
      tag: String(tag || ''),
      reason: String(reason || ''),
      have: Math.max(0, Math.floor(Number(have) || 0)),
      need: Math.max(0, Math.floor(Number(need) || 0)),
      fromRedacted: redactSsa1(from),
    };
    try { paintStatsSnap(); } catch { /* keep in-memory error even if snap fails */ }
  }

  function clearAutoPayoutError() {
    autoPayoutLastError = null;
    try { paintStatsSnap(); } catch { /* ignore */ }
  }

  async function sweepAutoPayouts({
    maxRows = PAYOUT_SWEEP_MAX_ROWS,
    budgetMs = PAYOUT_SWEEP_BUDGET_MS,
  } = {}) {
    const tipH = Number(store.tip?.()?.height || 0);
    const need = (typeof store.getpolicy === 'function' ? (store.getpolicy().operational?.pool_merchant || 30) : 30);
    const from = payoutDest(miner) || poolFeeDest();
    if (!isDestAddress(from) || containsShe1(from)) return [];
    const spendKey = refreshOperatorSpendKey();
    const due = pullBook.dueAuto({ tipHeight: tipH, need });
    const sent = [];
    const fee = levyNanos(0, { depth: mempoolDepthBytes(store.mempool || []) });
    const cap = Math.max(1, Math.floor(Number(maxRows) || PAYOUT_SWEEP_MAX_ROWS));
    const budget = Math.max(20, Math.floor(Number(budgetMs) || PAYOUT_SWEEP_BUDGET_MS));
    if (!spendKey && due.length) {
      const row = due[0];
      console.error(JSON.stringify({
        event: 'auto_payout_unsigned',
        reason: 'need_spend_key',
        tag: row.tag,
      }));
      recordAutoPayoutError({
        tag: row.tag,
        reason: 'unsigned',
        have: 0,
        need: row.nanos,
        from,
      });
      return [];
    }
    const t0 = Date.now();
    let n = 0;
    for (const row of due) {
      if (n >= cap) {
        payoutSweepAgain = true;
        break;
      }
      if (n > 0 && Date.now() - t0 >= budget) {
        payoutSweepAgain = true;
        break;
      }
      await new Promise((resolve) => { setImmediate(resolve); });
      n += 1;
      const built = buildAutoPayoutTx({ from, to: row.dest, nanos: row.nanos, fee, spendKey });
      if (!built.ok) {
        if (built.reason === 'need_spend_key') {
          console.error(JSON.stringify({
            event: 'auto_payout_unsigned',
            reason: 'need_spend_key',
            tag: row.tag,
          }));
          recordAutoPayoutError({
            tag: row.tag,
            reason: 'unsigned',
            have: 0,
            need: row.nanos,
            from,
          });
        }
        continue;
      }
      const q0 = Date.now();
      const queued = await Promise.resolve(queueSend(built.tx));
      console.error(JSON.stringify({
        event: 'queue_tx_ms',
        id: built.tx && built.tx.id,
        kind: 'pool-withdraw',
        ok: !(queued && queued.ok === false),
        reason: queued && queued.reason,
        have: queued && queued.have,
        need: queued && queued.need,
        from: built.tx && built.tx.from,
        ms: Date.now() - q0,
      }));
      if (queued && queued.ok === false) {
        recordAutoPayoutError({
          tag: row.tag,
          reason: queued.reason,
          have: queued.have,
          need: queued.need,
          from,
        });
        continue;
      }
      const taken = pullBook.takeConfirmed(row.tag, {
        tipHeight: tipH,
        need,
        amountNanos: row.nanos,
        skipCooldown: true,
      });
      if (taken.ok) {
        clearAutoPayoutError();
        sent.push({ ...row, nanos: taken.nanos });
      }
    }
    // The fee-wallet sweep is off. Miner π auto-payout above is the only send.
    return sent;
  }

  function queueSend(t, meta) {
    const id = t.id || `send-${Date.now()}`;
    const tx = { id, ...t };
    const owedRaw = Number(meta && meta.paintedOwedNanos);
    const paintedOwedNanos = Number.isFinite(owedRaw) && owedRaw > 0 ? Math.floor(owedRaw) : 0;
    if (typeof store.queueTx === 'function') {
      const got = store.queueTx(tx, paintedOwedNanos > 0 ? { paintedOwedNanos } : {});
      if (!got.ok) return got;
      jobDirty = true;
      setImmediate(flushDirtyJob);
      return got.tx || tx;
    }
    store.mempool = store.mempool || [];
    store.mempool.push(tx);
    return tx;
  }

  function flushDirtyJob() {
    if (!jobDirty) return;
    jobDirty = false;
    const t0 = Date.now();
    try {
      const next = issueJob(undefined, { force: true });
      if (next) broadcastJob(next);
    } catch { /* mempool drift on the next issueJob still rebuilds */ }
    console.error(JSON.stringify({ event: 'issue_job_force_ms', ms: Date.now() - t0 }));
  }

  if (typeof store.on === 'function') {
    store.on('tx', () => {
      jobDirty = true;
      setImmediate(flushDirtyJob);
    });
  }

  function dropSockets(list) {
    let n = 0;
    for (const s of list) {
      try { s.destroy(); n += 1; } catch { /* ignore */ }
    }
    return n;
  }

  function pruneNeverShared() {
    for (const [k, m] of miners) {
      if (minerConnected(m)) continue;
      if ((Number(m.accepted) || 0) > 0) continue;
      miners.delete(k);
    }
  }

  function sweepIdleMiners(now = Date.now()) {
    if (paused) {
      pruneNeverShared();
      return { dropped: 0 };
    }
    const socks = [];
    for (const m of miners.values()) {
      for (const s of idleDropSocks(m, now, idleMs)) socks.push(s);
    }
    let n = 0;
    for (const s of socks) {
      endSock(s, line({ method: 'error', error: 'no_valid_share' }));
      n += 1;
    }
    pruneNeverShared();
    return { dropped: n };
  }

  {
    const dropEvery = Math.max(25, Math.min(STATS_REFRESH_MS, Math.floor(idleMs / 2) || STATS_REFRESH_MS));
    dropTimer = setInterval(() => sweepIdleMiners(), dropEvery);
    dropTimer.unref?.();
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
      const policy = typeof store.getpolicy === 'function' ? store.getpolicy() : {};
      return {
        paused,
        height: tip?.height || 0,
        jobId: lastJob?.jobId || '',
        jobHeight: Number(lastJob?.height) || 0,
        shareBits: liveShareBits(),
        blockBits: blockBitsNow(),
        accepted: stats.accepted,
        stale: stats.stale,
        dropped: Number(stats.dropped) || 0,
        blocks: stats.blocks,
        miners: miners.size,
        connected,
        sockets: sockets.size,
        hashQueue: hashWait.size,
        bans: bans.size,
        uptimeMs: Date.now() - stats.started,
        lastFoundAt: stats.lastFoundAt || 0,
        stratum: stats.stratum,
        frozen: !!policy.frozen,
        freeze_reason: policy.freeze_reason || '',
        freeze_banner: policy.freeze_banner || '',
        h_ratio: Number.isFinite(Number(policy.h_ratio)) ? Number(policy.h_ratio) : 1,
        side_lead: Number(policy.side_lead) || 0,
        confirmedNeed: (policy?.operational?.pool_merchant || 30),
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
    const url = new URL(req.url, 'http://127.0.0.1');
    if (
      isAdminHost(host)
      || url.pathname === '/admin'
      || url.pathname.startsWith('/admin/')
      || url.pathname.startsWith('/api/admin')
    ) {
      await handleAdminHttp(req, res, {
        store, admin, queueSend, ops: adminOps, pendingPulls,
        poolDest: payoutDest(miner) || miner,
        pullBook,
      });
      return;
    }
    if (url.pathname === '/api/stats') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(statsSnap.json);
      return;
    }
    if (
      url.pathname === '/fingerprint'
      || url.pathname === '/getfingerprint'
      || url.pathname === '/api/fingerprint'
    ) {
      res.setHeader('content-type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      const fp = typeof store.consensusFingerprint === 'function'
        ? store.consensusFingerprint()
        : consensusFingerprint();
      res.end(JSON.stringify({
        ok: true,
        fingerprint: fp,
        admit: 'ADMITv2',
        hashTxLive: Number(store.hashTxLive ?? HASH_TX_LIVE),
        magic: MAGIC_TESTNET,
      }));
      return;
    }
    if (/^\/miner\/(she1|shear1)/i.test(url.pathname) || /^\/api\/miners\/(she1|shear1)/i.test(url.pathname)) {
      res.statusCode = 404;
      res.end('missing');
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
      res.setHeader('Cache-Control', 'no-store');
      const tipH = Number(store.tip?.()?.height || 0);
      const need = (typeof store.getpolicy === 'function' ? (store.getpolicy().operational?.pool_merchant || 30) : 30);
      const pull = pullBook.view(tag, { tipHeight: tipH, need });
      const held = typeof pullBook.ledger === 'function' ? pullBook.ledger(tag) : [];
      const known = typeof pullBook.hasTag === 'function' ? pullBook.hasTag(tag) : false;
      if (!rows.length && !(pull.pendingNanos > 0) && !pull.lastPullMs && !held.length && !known) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, reason: 'unknown_miner', tag }));
        return;
      }
      if (parts[1] === 'withdraw' && req.method === 'POST') {
        res.statusCode = 410;
        res.end(JSON.stringify({
          ok: false,
          reason: 'auto_payout',
          deprecated: true,
          autoPayoutMinNanos: AUTO_PAYOUT_MIN_NANOS,
          dest: 'ssa1',
        }));
        return;
      }
      res.end(JSON.stringify(minerPublicJson(tag)));
      return;
    }
    if (url.pathname === '/api/mempool' || url.pathname === '/api/mempoolPressure' || url.pathname === '/api/mempoolpressure' || url.pathname.startsWith('/api/wallet/') || url.pathname.startsWith('/api/explorer/') || url.pathname.startsWith('/api/vortex/') || url.pathname.startsWith('/api/pool/') || url.pathname.startsWith('/api/vault/') || url.pathname.startsWith('/api/join/')) {
      let body = {};
      if (req.method === 'POST') {
        const raw = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
          req.on('error', reject);
        });
        try {
          body = JSON.parse(raw);
        } catch (err) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, reason: 'bad_json', error: String(err && err.message || err) }));
          return;
        }
        if (url.pathname === '/api/wallet/send') {
          console.error(JSON.stringify({ walletSend: true, bytes: raw.length, hasAdmit: !!body.admit_proof, vin: Array.isArray(body.vin) && body.vin.length }));
        }
      }
      const headerOpen = req.headers && req.headers['x-shear-open'];
      if (headerOpen && !url.searchParams.get('open') && !url.searchParams.get('destOpen')) {
        url.searchParams.set('open', String(headerOpen));
      }
      const { handleWalletApi } = await import('./wallet_api.js');
      let out;
      try {
        out = handleWalletApi(url, req.method, body, {
          store,
          miners,
          lastJob,
          nodesOnline: nodesOnline(),
          networkPending: networkView ? networkView.txs : [],
          networkRounds: networkView ? networkView.rounds : [],
          poolDest: miner,
          pullBook,
          queueSend,
          pendingPulls,
          completeMinerPull: (login, dest, nanos) => {
            const t = publicMinerTag(login);
            const tipH = Number(store.tip?.()?.height || 0);
            const confNeed = (typeof store.getpolicy === 'function' ? (store.getpolicy().operational?.pool_merchant || 30) : 30);
            const view = pullBook.view(t, { tipHeight: tipH, need: confNeed });
            if (!(view.confirmedNanos > 0)) return { ok: false, reason: 'none_confirmed' };
            if (Number(nanos) !== view.confirmedNanos) return { ok: false, reason: 'nanos' };
            const taken = pullBook.takeConfirmed(t, { tipHeight: tipH, need: confNeed });
            pendingPulls.delete(String(login || '').split('.')[0].toLowerCase());
            return taken;
          },
        });
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, reason: 'send_error', error: String(err && err.message || err) }));
        return;
      }
      if (out) {
        res.statusCode = out.status;
        res.setHeader('content-type', 'application/json');
        try {
          res.end(JSON.stringify(out.json));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, reason: 'send_error', error: String(err && err.message || err) }));
        }
        return;
      }
    }
    const file = publicHtmlFile(host, url.pathname);
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
      res.setHeader('Cache-Control', 'no-store');
      if (file === '/miner.html') {
        const minerTag = decodeURIComponent(url.pathname.split('/')[2] || '');
        const boot = minerPublicJson(minerTag);
        const html = data.toString('utf8').replace('/*MINER_BOOT*/null', JSON.stringify(boot));
        res.end(html);
        return;
      }
      res.end(data);
    });
  });
  httpServer.timeout = 0;
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.keepAliveTimeout = 5000;
  httpServer.on('listening', () => {
    setImmediate(() => {
      if (stopped) return;
      paintStatsSnap();
      if (!statsTimer) statsTimer = setInterval(paintStatsSnap, STATS_REFRESH_MS);
      if (!payoutTimer) {
        payoutTimer = setInterval(runAutoPayoutSweep, PAYOUT_SWEEP_MS);
        payoutTimer.unref?.();
      }
    });
  });

  function listen() {
    const ident = configuredFeeIdentity();
    if (!ident.ok) {
      return Promise.reject(Object.assign(new Error(ident.reason), { code: ident.reason }));
    }
    let tlsOpts = null;
    if (tlsCert && tlsKey) {
      try {
        tlsOpts = { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) };
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const plan = stratumListenPlan({
      bind: stratumBind,
      hasTls: !!tlsOpts,
      requireTls,
      labCleartext,
    });
    if (!plan.ok) {
      return Promise.reject(Object.assign(new Error(plan.reason), { code: plan.reason }));
    }
    return new Promise((resolve, reject) => {
      const serveHttp = () => {
        httpServer.listen(httpPort, '127.0.0.1', () => {
          if (!restampTimer) restampTimer = setInterval(maybeRestampJob, JOB_RESTAMP_MS);
          console.error(JSON.stringify({
            event: 'pool_fee_dest',
            advisory: 'Fee publish and admin spend share one pin.',
            feeDestTail: String(ident.feeDest || '').slice(-4),
          }));
          const httpBound = httpServer.address();
          const stratumBound = plan.cleartext && stratum.address && stratum.address();
          const tlsBound = stratumTls && stratumTls.address && stratumTls.address();
          resolve({
            stratumPort: stratumBound && typeof stratumBound === 'object' ? stratumBound.port : (plan.cleartext ? stratumPort : 0),
            tlsPort: tlsBound && typeof tlsBound === 'object' ? tlsBound.port : (plan.tls ? tlsPort : 0),
            httpPort: httpBound && typeof httpBound === 'object' ? httpBound.port : httpPort,
          });
          setImmediate(() => {
            if (stopped) return;
            paintStatsSnap();
            if (!statsTimer) statsTimer = setInterval(paintStatsSnap, STATS_REFRESH_MS);
            if (!payoutTimer) {
              payoutTimer = setInterval(runAutoPayoutSweep, PAYOUT_SWEEP_MS);
              payoutTimer.unref?.();
            }
          });
        });
      };
      const serveTls = () => {
        if (!plan.tls) {
          serveHttp();
          return;
        }
        stratumTls = tls.createServer(tlsOpts, onStratum);
        stratumTls.on('error', reject);
        stratumTls.listen(tlsPort, stratumBindHost(stratumBind), serveHttp);
      };
      if (plan.cleartext) {
        stratum.on('error', reject);
        stratum.listen(stratumPort, stratumBindHost(stratumBind), serveTls);
      } else {
        serveTls();
      }
    });
  }

  function close() {
    stopped = true;
    if (restampTimer) {
      clearInterval(restampTimer);
      restampTimer = null;
    }
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    if (payoutTimer) {
      clearInterval(payoutTimer);
      payoutTimer = null;
    }
    if (dropTimer) {
      clearInterval(dropTimer);
      dropTimer = null;
    }
    for (const [, p] of hashWait) {
      if (p.settled) continue;
      p.settled = true;
      clearTimeout(p.timer);
      try { p.reject(new Error('closed')); } catch { /* ignore */ }
    }
    hashWait.clear();
    releaseHashWorker();
    for (const s of sockets) try { s.destroy(); } catch { /* ignore */ }
    sockets.clear();
    try { stratum.close(); } catch { /* ignore */ }
    try { stratumTls?.close(); } catch { /* ignore */ }
    try { httpServer.closeAllConnections?.(); } catch { /* ignore */ }
    try { httpServer.close(); } catch { /* ignore */ }
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
    paintStatsSnap,
    runAutoPayoutSweep,
    sweepAutoPayouts,
    setP2p,
    setNetworkView,
    noteSidecarTip,
    jobHoldReason,
    restampJob: restampLiveHeader,
    restampTick: maybeRestampJob,
    watchTipStall,
    sweepIdle: sweepIdleMiners,
    get pendingPayout() { return pendingPayout; },
    get prevJob() { return prevJob; },
    get paused() { return paused; },
    admin,
    adminOps,
    pullBook,
  };
}

export { CLIENT, ALGO };
