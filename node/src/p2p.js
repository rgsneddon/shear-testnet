import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { MAGIC_TESTNET, PRODUCT_VERSION } from '../../crypto/asert.js';
import { freshMinerRounds, safeMinerRounds } from './network_report.js';
import { packShareBatchBytes, unpackShareBatchBytes } from '../../crypto/pack.js';
import { packHashCreditBytes, unpackHashCreditBytes } from '../../crypto/hash_owed.js';
import { admitWireTx, compactTx, shouldPruneSamples } from '../../crypto/chronoflux.js';
import { reviveTx, reviveBytes } from '../../crypto/note.js';
import { isInitialBlockDownload } from './status.js';

function reviveDeep(v) {
  if (v == null) return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  const one = reviveBytes('', v);
  if (one !== v) return one;
  if (Array.isArray(v)) return v.map(reviveDeep);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = reviveDeep(val);
    return out;
  }
  return v;
}

export const P2P_PORT = 30303;
/**
 * Default 16 MiB. A full 65536-share packed body is about 7 MiB of hex on the
 * JSON line. The old 2 MiB default rejected that block. Override with
 * SHEAR_P2P_MAX_FRAME. Cheap reject before Admit/BP+/RX.
 */
export const P2P_MAX_FRAME_DEFAULT = 16 * 1024 * 1024;
export const P2P_MAX_FRAME = Math.max(
  1024 * 1024,
  Number(process.env.SHEAR_P2P_MAX_FRAME || P2P_MAX_FRAME_DEFAULT) || P2P_MAX_FRAME_DEFAULT,
);
export const P2P_FAIL_DISCONNECT = 8;
export const P2P_INBOUND_PER24 = 8;
export const P2P_BAN_MS = 15 * 60 * 1000;
/** Default max live peers (inbound + outbound). Override with SHEAR_MAX_PEERS. */
export function p2pMaxPeers() {
  return Math.max(1, Number(process.env.SHEAR_MAX_PEERS || 32) || 32);
}
export const P2P_MAX_PEERS = p2pMaxPeers();

export function ipv4Subnet24(addr) {
  const a = String(addr || '');
  const m = a.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  return m ? `${m[1]}.0` : a;
}

export function noteExpensiveFail(rec) {
  if (!rec || typeof rec !== 'object') return false;
  rec.expensiveFails = (Number(rec.expensiveFails) || 0) + 1;
  rec.lastFailAt = Date.now();
  return rec.expensiveFails >= P2P_FAIL_DISCONNECT;
}

export function inboundCountForSubnet(peers, subnet) {
  let n = 0;
  for (const rec of (peers?.values?.() || [])) {
    if (rec?.inbound && ipv4Subnet24(rec.remote) === subnet) n += 1;
  }
  return n;
}
/** Headers served after a locator. A window, not the end of IBD. */
export const HEADERS_PAGE = 2000;
/** Documented default in-flight getblock window. Tests may set SHEAR_GETBLOCK_BATCH. */
export const GETBLOCK_BATCH = 16;
export function getblockBatch() {
  return Math.max(1, Math.min(64, Number(process.env.SHEAR_GETBLOCK_BATCH || GETBLOCK_BATCH) || GETBLOCK_BATCH));
}
/**
 * Global cap on overlapping P2P block verifies and on off-loop ShearHash.
 * Keep equal to crypto/hash_offloop.js P2P_VERIFY_CAP.
 */
export const P2P_VERIFY_CAP = 2;
/** Full block encodes served per event-loop turn while caught up. The rest wait and still send. */
export const GETBLOCK_SERVE_PER_TURN = 1;
/** Serves per turn during IBD or a mid-chain catch-up. Stays inside 8–32. */
export const GETBLOCK_SERVE_IBD = 16;
/** Body misses before a peer is dropped from catch-up. */
export const GETBLOCK_MISS_LIMIT = 3;
/** How long a demoted peer stays out of best-ahead selection. */
export const GETBLOCK_DEMOTE_MS = 30_000;

export function getblockServeCap({ ibd = false, midChain = false, behind = false } = {}) {
  if (ibd || midChain || behind) return GETBLOCK_SERVE_IBD;
  return GETBLOCK_SERVE_PER_TURN;
}

/** Ignore a repeat getblock that is already queued or was just encoded for this socket. */
export const GETBLOCK_SERVE_DEDUPE_MS = 3_000;
export function shouldEnqueueGetblock({
  queued = false,
  servedAt = 0,
  now = 0,
  ttl = GETBLOCK_SERVE_DEDUPE_MS,
} = {}) {
  if (queued) return false;
  const at = Number(servedAt) || 0;
  if (at > 0 && Number(now) - at < ttl) return false;
  return true;
}

/**
 * A one-block tip retries quickly. An IBD body is a fat encode, so the same
 * 250ms poll re-asks the tip node until its serve loop floods.
 */
export const GETBLOCK_WAIT_IBD_MS = 4_000;
export function getblockWaitMs({ localHeight = 0, peerHeight = 0 } = {}) {
  const gap = Number(peerHeight) - Number(localHeight);
  if (Number.isFinite(gap) && gap > 1) return GETBLOCK_WAIT_IBD_MS;
  return GETBLOCK_WAIT_MS;
}

export function tipIsRelay(msg) {
  return !!(msg && (msg.relay === true || msg.relayed === true));
}

/**
 * Record a tip advertisement.
 * Relay/gossip updates peer-max fields only.
 * A direct tip may record an at-or-behind book position and a probe
 * advertisement, including an empty hash for an empty book. That hash is
 * how census counts a peer at the same tip. It does not raise the height
 * or work catch-up uses, and it does not set syncEligible.
 */
export function applyTipAdvertisement(rec, msg, { localHeight = 0, localHash = '' } = {}) {
  const next = rec && typeof rec === 'object' ? rec : {};
  const h = Number(msg?.height);
  const hash = msg?.hash != null ? String(msg.hash).replace(/^0x/i, '').toLowerCase() : '';
  const work = msg?.work != null && String(msg.work) !== '' ? String(msg.work) : '';
  if (Number.isFinite(h)) next.gossipHeight = h;
  if (hash) next.gossipHash = hash;
  if (work) next.gossipWork = work;
  const localH = Number(localHeight) || 0;
  const local = String(localHash || '').replace(/^0x/i, '').toLowerCase();
  const sameTip = !!(hash && local && hash === local);
  if (tipIsRelay(msg)) {
    next.sawRelay = true;
    if (sameTip) {
      next.hash = hash;
      if (Number.isFinite(h)) next.height = h;
    }
    return next;
  }
  if (Number.isFinite(h)) next.adHeight = h;
  if (hash) next.adHash = hash;
  if (work) next.adWork = work;
  const heightAhead = Number.isFinite(h) && h > localH;
  if (!heightAhead) {
    next.hash = hash;
    if (Number.isFinite(h)) next.height = h;
    if (work) next.work = work;
  }
  return next;
}

/** A served body, or headers-plus-getblock that applied, makes this peer catch-up eligible. */
export function markSyncEligible(rec, { height, hash, work, reason = 'body' } = {}) {
  if (!rec || typeof rec !== 'object') return rec;
  if (Number.isFinite(Number(height))) rec.height = Number(height);
  if (hash) rec.hash = String(hash).replace(/^0x/i, '').toLowerCase();
  if (work != null && String(work) !== '') rec.work = String(work);
  rec.syncEligible = true;
  rec.eligibleReason = reason;
  if (reason === 'body') rec.bodiesServed = (Number(rec.bodiesServed) || 0) + 1;
  rec.getblockMiss = 0;
  rec.demoteUntil = 0;
  return rec;
}

export function peerDemoted(rec, now = Date.now()) {
  return !!(rec && Number(rec.demoteUntil) > Number(now));
}

/**
 * Height and work a catch-up view may use.
 * Only a sync-eligible peer (served body, or headers plus a body that applied)
 * has these. A tip advertisement stays on adHeight / gossipHeight.
 */
export function catchupFields(rec, now = Date.now()) {
  if (!rec || peerDemoted(rec, now) || rec.syncEligible !== true) {
    return { height: null, work: null, hash: '' };
  }
  return {
    height: Number.isFinite(Number(rec.height)) ? Number(rec.height) : null,
    work: rec.work ?? null,
    hash: String(rec.hash || ''),
  };
}

export function noteGetblockMiss(rec, now = Date.now()) {
  if (!rec || typeof rec !== 'object') return { demoted: false, misses: 0, demoteUntil: 0 };
  rec.getblockMiss = (Number(rec.getblockMiss) || 0) + 1;
  let demoted = false;
  if (rec.getblockMiss >= GETBLOCK_MISS_LIMIT) {
    demoted = true;
    rec.demoteUntil = Number(now) + GETBLOCK_DEMOTE_MS;
    rec.syncEligible = false;
    rec.height = 0;
    rec.work = null;
    rec.hash = null;
  }
  return { demoted, misses: rec.getblockMiss, demoteUntil: Number(rec.demoteUntil) || 0 };
}

/**
 * next:0 from a shorter or non-eligible peer must not drop a local+1 want
 * another peer already holds.
 */
export function shouldClearWantOnNextZero({
  fromEligible = false,
  fromShorter = true,
  otherWantsLocalPlusOne = false,
} = {}) {
  if (otherWantsLocalPlusOne && (!fromEligible || fromShorter)) return false;
  return true;
}

export function syncSnapshot(peers, now = Date.now()) {
  let peerMaxHeight = null;
  let peerHash = '';
  let syncPeerHeight = null;
  let eligible = 0;
  const list = peers && typeof peers.values === 'function' ? peers.values() : [];
  for (const rec of list) {
    const g = Number(rec?.gossipHeight);
    const h = Number.isFinite(g) ? g : Number(rec?.height);
    const hash = String(rec?.gossipHash || rec?.hash || '').replace(/^0x/i, '').toLowerCase();
    if (Number.isFinite(h) && (peerMaxHeight == null || h > peerMaxHeight || (h === peerMaxHeight && hash && (!peerHash || hash < peerHash)))) {
      peerMaxHeight = h;
      peerHash = hash;
    }
    if (rec?.syncEligible === true && !peerDemoted(rec, now)) {
      eligible += 1;
      const sh = Number(rec.height);
      if (Number.isFinite(sh) && (syncPeerHeight == null || sh > syncPeerHeight)) syncPeerHeight = sh;
    }
  }
  return {
    peerMaxHeight,
    peerHash,
    syncPeerHeight,
    syncEligiblePeers: eligible,
  };
}

let verifyActive = 0;
let verifyMaxActive = 0;
let verifyQueued = 0;
let verifyMaxQueued = 0;
let verifyStarted = 0;
let verifyCompleted = 0;
const verifyWaiters = [];

export function p2pVerifyCap() {
  return P2P_VERIFY_CAP;
}

export function p2pVerifyStats() {
  return {
    cap: P2P_VERIFY_CAP,
    active: verifyActive,
    maxActive: verifyMaxActive,
    queued: verifyQueued,
    maxQueued: verifyMaxQueued,
    started: verifyStarted,
    completed: verifyCompleted,
  };
}

export function resetP2pVerifyStats() {
  verifyMaxActive = verifyActive;
  verifyMaxQueued = verifyQueued;
  verifyStarted = 0;
  verifyCompleted = 0;
}

function scheduleP2pVerify(fn) {
  return new Promise((resolve, reject) => {
    const launch = () => {
      verifyActive += 1;
      verifyStarted += 1;
      if (verifyActive > verifyMaxActive) verifyMaxActive = verifyActive;
      let runChain;
      runChain = verifyOrder.then(() => new Promise((r) => setImmediate(r)).then(fn));
      verifyOrder = runChain.then(() => {}, () => {});
      runChain.then(resolve, reject).finally(() => {
        verifyActive -= 1;
        verifyCompleted += 1;
        const next = verifyWaiters.shift();
        if (!next) return;
        verifyQueued -= 1;
        next();
      });
    };
    if (verifyActive < P2P_VERIFY_CAP) {
      launch();
      return;
    }
    verifyQueued += 1;
    if (verifyQueued > verifyMaxQueued) verifyMaxQueued = verifyQueued;
    verifyWaiters.push(launch);
  });
}

let verifyOrder = Promise.resolve();

export function parseChainWork(v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  try {
    if (s.startsWith('0x')) return BigInt(s);
    if (/^[0-9]+$/.test(s)) return BigInt(s);
    if (/^[0-9a-f]+$/.test(s)) return BigInt(`0x${s}`);
  } catch { /* not work */ }
  return null;
}

/**
 * Ahead when the peer is taller, has more work, or has the same work and a
 * lower tip hash. A different hash with no work figure is not ahead: that
 * tip may be the lighter one. The pool is not consulted.
 */
export function peerTipAheadOf({
  localHeight = 0,
  localWork = null,
  localHash = '',
  peerHeight = null,
  peerWork = null,
  peerHash = '',
} = {}) {
  const peerH = Number(peerHeight);
  const localH = Number(localHeight) || 0;
  if (Number.isFinite(peerH) && peerH > localH) return true;
  const pw = parseChainWork(peerWork);
  const lw = parseChainWork(localWork);
  if (pw != null && lw != null && pw > lw) return true;
  if (pw != null && lw != null && pw === lw) {
    const ph = String(peerHash || '').toLowerCase();
    const lh = String(localHash || '').toLowerCase();
    if (ph && lh && ph !== lh && ph < lh) return true;
  }
  return false;
}

/** Best catch-up peer: more work, else taller, else the lower tip hash at equal work. */
export function catchupPeerBetter(a, b) {
  const aw = parseChainWork(a?.work);
  const bw = parseChainWork(b?.work);
  if (aw != null && bw != null && aw !== bw) return aw > bw;
  const aH = Number.isFinite(Number(a?.height)) ? Number(a.height) : -1;
  const bH = Number.isFinite(Number(b?.height)) ? Number(b.height) : -1;
  if (aH !== bH) return aH > bH;
  if (aw != null && bw == null) return true;
  const ah = String(a?.hash || '').toLowerCase();
  const bh = String(b?.hash || '').toLowerCase();
  if (aw != null && bw != null && aw === bw && ah && bh && ah !== bh) return ah < bh;
  return false;
}
/** Seed redial so a dropped peer cannot leave a node stuck forever. */
export const SEED_RETRY_MS = 3_000;
/** Retry a hung getblock. A missed one-block tip must not wait on a multi-second poll. */
export const GETBLOCK_WAIT_MS = 250;
/** How often the hung-getblock watch runs. */
export const PENDING_WATCH_MS = 50;
/** Re-push our tip and re-pull a peer that is still ahead. */
export const TIP_NUDGE_MS = 100;

function hexHash(h) {
  if (Buffer.isBuffer(h) || h instanceof Uint8Array) return Buffer.from(h).toString('hex').toLowerCase();
  return String(h || '').replace(/^0x/i, '').toLowerCase();
}

function hexHeader(h) {
  if (Buffer.isBuffer(h)) return h.toString('hex');
  return String(h || '');
}

/** Wire hash as lowercase hex. Accepts hex, Buffer, `$hex`, or Node Buffer JSON. */
export function wireHash(h) {
  if (h == null || h === '') return '';
  if (Buffer.isBuffer(h) || h instanceof Uint8Array) return Buffer.from(h).toString('hex');
  if (typeof h === 'string') {
    const s = h.trim();
    if (!s || s === '[object Object]') return '';
    return s.toLowerCase();
  }
  if (typeof h === 'object') {
    if (typeof h.$hex === 'string') return h.$hex.toLowerCase();
    if (h.type === 'Buffer' && Array.isArray(h.data)) return Buffer.from(h.data).toString('hex');
  }
  return '';
}

function wireBytes(v) {
  if (v == null || v === '') return undefined;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'hex');
  if (typeof v === 'object') {
    if (typeof v.$hex === 'string') return Buffer.from(v.$hex, 'hex');
    if (v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  }
  return undefined;
}

export function headerIndexByHash(blocks, hash) {
  const want = wireHash(hash);
  if (!want) return -1;
  const list = Array.isArray(blocks) ? blocks : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (hexHash(list[i].hash) === want) return i;
  }
  return -1;
}

/** Exponential locators from tip, then genesis-ward. Empty chain → []. */
export function locatorHashes(blocks, { max = 32 } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const out = [];
  let step = 1;
  let i = list.length - 1;
  let seen = 0;
  while (i >= 0 && out.length < max) {
    out.push(hexHash(list[i].hash));
    i -= step;
    seen += 1;
    if (seen >= 10) step *= 2;
  }
  return out;
}

/**
 * Headers after the requester's locator. `locator: []` starts at genesis.
 * Legacy getheaders (no locator field) treats stopHash as the have-hash.
 * When locator is present, stopHash is the target to include, then stop.
 */
export function selectHeadersAfterLocator(blocks, {
  locator,
  stopHash = '',
  limit = HEADERS_PAGE,
} = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const hasLocatorField = Array.isArray(locator);
  const locators = hasLocatorField
    ? locator.map((x) => wireHash(x)).filter(Boolean)
    : [];
  const stop = wireHash(stopHash);
  if (!hasLocatorField && stop) locators.push(stop);

  let start = 0;
  for (const h of locators) {
    const idx = headerIndexByHash(list, h);
    if (idx >= 0) {
      start = idx + 1;
      break;
    }
  }

  const cap = Math.max(1, Math.min(Math.floor(Number(limit) || HEADERS_PAGE), HEADERS_PAGE));
  const target = hasLocatorField ? stop : '';
  const out = [];
  for (let i = start; i < list.length && out.length < cap; i += 1) {
    const b = list[i];
    const hash = hexHash(b.hash);
    out.push({
      header: hexHeader(b.header),
      hash,
      height: b.height,
    });
    if (target && hash === target) break;
  }
  return out;
}

const PRIV_NET = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^0\./,
  /^255\./,
];

export function isRoutablePeerAddr(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return false;
  if (h === '169.254.169.254' || h.endsWith('.metadata.google.internal')) return false;
  if (PRIV_NET.some((re) => re.test(h))) return false;
  if (h.includes(':') && (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd'))) return false;
  return true;
}
export const P2P_UA = `shear-node/${PRODUCT_VERSION}`;
/** Originator stem: one random peer, then fluff after hops or 1–3 s. */
export const STEM_MAX_HOPS = 3;
export const FLUFF_MIN_MS = 1000;
export const FLUFF_MAX_MS = 3000;

export function encodeWireBlock(b) {
  return {
    header: Buffer.from(b.header).toString('hex'),
    hash: Buffer.from(b.hash).toString('hex'),
    height: b.height,
    txs: (b.txs || []).map(compactTx),
    samples: b.samples,
    miner: b.miner,
    sharePacked: packShareBatchBytes(b.shareBatch || []).toString('hex'),
    hashCreditPacked: Array.isArray(b.hashCredits) ? packHashCreditBytes(b.hashCredits).toString('hex') : '',
    aLeaves: b.aLeaves,
    bLeaves: b.bLeaves,
    rootA: b.rootA,
    rootB: b.rootB,
    samplesPruned: !!b.samplesPruned,
    bLeavesPruned: !!b.bLeavesPruned,
  };
}

export function decodeWireBlock(w) {
  return {
    header: wireBytes(w.header),
    hash: w.hash != null ? wireBytes(w.hash) : undefined,
    height: w.height,
    txs: (w.txs || []).map((tx) => reviveTx(reviveDeep(tx))),
    samples: reviveDeep(w.samples),
    miner: w.miner,
    shareBatch: w.sharePacked
      ? unpackShareBatchBytes(Buffer.from(String(w.sharePacked), 'hex'))
      : (Array.isArray(w.shareBatch) ? w.shareBatch : []),
    hashCredits: w.hashCreditPacked
      ? unpackHashCreditBytes(Buffer.from(String(w.hashCreditPacked), 'hex'))
      : (Array.isArray(w.hashCredits) ? w.hashCredits : undefined),
    aLeaves: reviveDeep(w.aLeaves),
    bLeaves: reviveDeep(w.bLeaves),
    rootA: reviveDeep(w.rootA),
    rootB: reviveDeep(w.rootB),
    samplesPruned: !!w.samplesPruned,
    bLeavesPruned: !!w.bLeavesPruned,
  };
}

/**
 * IBD requests the next height after the local tip, never a later child.
 * Headers may include a long run; only height local+1 whose prev matches is wanted.
 */
export function nextSequentialHeader({
  headers = [],
  localHeight = 0,
  localHash = '',
  have,
  failed,
  pending,
} = {}) {
  const wantH = Math.max(0, Number(localHeight) || 0) + 1;
  const prev = String(localHash || '').toLowerCase();
  const haveSet = have instanceof Set ? have : new Set(have || []);
  const failSet = failed instanceof Set ? failed : new Set(failed || []);
  const pendSet = pending instanceof Set ? pending : new Set(pending || []);
  for (const h of headers || []) {
    if (Number(h?.height) !== wantH) continue;
    const hash = wireHash(h.hash);
    if (!hash) continue;
    if (haveSet.has(hash) || failSet.has(hash) || pendSet.has(hash)) continue;
    if (prev) {
      const p = headerPrevHash(h.header);
      if (p && p !== prev) continue;
    }
    return { hash, height: wantH };
  }
  return null;
}

/** Peer-advertised book height, used so pruned IBD is not verified as a live tip. */
export function advertisedPeerTip(rec, fallback = 0) {
  const g = Number(rec?.gossipHeight);
  if (Number.isFinite(g) && g > 0) return g;
  const n = Number(rec?.height);
  if (Number.isFinite(n) && n > 0) return n;
  return Math.max(0, Number(fallback) || 0);
}

function hexify(v) {
  if (v == null) return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return { $hex: Buffer.from(v).toString('hex') };
  }
  if (Array.isArray(v)) return v.map(hexify);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = hexify(val);
    return o;
  }
  return v;
}

export function jsonWire(obj) {
  return JSON.stringify(hexify(obj));
}

function line(obj) {
  return `${jsonWire(obj)}\n`;
}

/** Unique remote of a live socket. IPv4-mapped IPv6 collapses to IPv4. */
export function peerRemoteKey(sock) {
  let a = String(sock?.remoteAddress || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a;
}

/**
 * Currently-online fully-synced nodes the network can see: this process
 * (includeSelf), every unique live remote at the local tip, and every
 * synced node a live peer has gossiped from its own sockets. The gossip
 * set is replaced by the next census and dropped with that peer, so a
 * disconnected node does not stay in the count. The pool is one peer.
 * A node that dials any other synced peer is still counted.
 */
export const CENSUS_MAX = 64;
export const CENSUS_HOP_MAX = 1;

/** Stable gossip identity. A numeric socket id is local and is not a key. */
export function censusKey(rec) {
  const nodeId = String(rec?.nodeId || '').trim().toLowerCase();
  if (nodeId) return `id:${nodeId}`;
  const host = String(rec?.remote || rec?.host || '').trim();
  if (!host || host === '0.0.0.0') return '';
  return `ip:${host}`;
}
/** One random live socket, never the inbound peer. */
export function pickStemSocket(sockets, except, rng = Math.random) {
  const list = [];
  for (const s of sockets || []) {
    if (s && s !== except) list.push(s);
  }
  if (!list.length) return null;
  const n = Number(rng());
  const i = Math.min(list.length - 1, Math.max(0, Math.floor((Number.isFinite(n) ? n : 0) * list.length)));
  return list[i];
}

export function fluffDelayMs(rng = Math.random) {
  const span = FLUFF_MAX_MS - FLUFF_MIN_MS;
  const n = Number(rng());
  const u = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  return FLUFF_MIN_MS + Math.floor(u * (span + 1));
}

/** Logs must never put remoteAddress next to dest, she1, or txid. */
export function peerEventFields({ event, remote } = {}) {
  return {
    event: String(event || ''),
    remote: remote ? 'peer' : undefined,
  };
}

export function lineHasIpBesideIdentity(line) {
  const s = String(line || '');
  const ip = /remoteAddress|peerIp|"ip"\s*:|\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(s);
  const id = /she1|shear1|txid|ssa1/i.test(s);
  return ip && id;
}

/**
 * `evm`, `unsigned`, and `admit_membership` can pass after a pin bump or a native rebuild.
 * They are not permanent. merkle / pow / bits stay final.
 * The soft-fail map is process memory, so a boot clears it.
 */
export const SOFT_FAIL_TTL_MS = 60_000;

export function isUpgradeableIngestFail(reason) {
  const r = String(reason || '');
  return r === 'evm' || r === 'unsigned' || r === 'admit_membership';
}

/** `prev` is a batch-order miss; retry on the next header page. Merkle/pow/bits stay final.
 * A missing local hasher is not a bad block — do not poison genesis.
 * `side_hold` is a competing branch that has not won fork-choice yet.
 * `not_heavier` must not poison that branch: a later child can still carry more work.
 * Upgradeable reasons (`evm`, `unsigned`, `admit_membership`) use a TTL, not `failed` forever. */
export function isFinalIngestFail(reason) {
  const r = String(reason || '');
  if (r === 'prev' || r === 'hash_bonus' || r === 'side_hold' || r === 'not_heavier') return false;
  if (isUpgradeableIngestFail(r)) return false;
  if (/native[_ ]addon[_ ]missing|native_missing/i.test(r)) return false;
  return true;
}

export function noteSoftFail(rec, hash, reason, now = Date.now(), pin = PRODUCT_VERSION) {
  const h = String(hash || '').toLowerCase();
  if (!rec || !h) return rec;
  if (!(rec.softFailed instanceof Map)) rec.softFailed = new Map();
  rec.softFailed.set(h, { at: now, reason: String(reason || ''), pin: String(pin || '') });
  return rec;
}

/** Permanent fails plus upgradeable fails still inside their TTL and pin. */
export function failActive(rec, hash, now = Date.now(), pin = PRODUCT_VERSION) {
  const h = String(hash || '').toLowerCase();
  if (!h || !rec) return false;
  if (rec.failed instanceof Set && rec.failed.has(h)) return true;
  if (Array.isArray(rec.failed) && rec.failed.includes(h)) return true;
  const row = rec.softFailed instanceof Map ? rec.softFailed.get(h) : null;
  if (!row) return false;
  const expired = (now - Number(row.at || 0)) >= SOFT_FAIL_TTL_MS;
  const pinMoved = row.pin && String(pin || '') && row.pin !== String(pin);
  if (expired || pinMoved) {
    rec.softFailed.delete(h);
    return false;
  }
  return true;
}

export function activeFailSet(rec, now = Date.now(), pin = PRODUCT_VERSION) {
  const out = new Set();
  const add = (h) => {
    const s = String(h || '').toLowerCase();
    if (s) out.add(s);
  };
  if (rec?.failed instanceof Set) {
    for (const h of rec.failed) add(h);
  } else if (Array.isArray(rec?.failed)) {
    for (const h of rec.failed) add(h);
  }
  if (rec?.softFailed instanceof Map) {
    for (const h of [...rec.softFailed.keys()]) {
      if (failActive(rec, h, now, pin)) add(h);
    }
  }
  return out;
}

/** Next-height header held only by an upgradeable fail. Permanent fails are not a hold. */
export function upgradeableHold(rec, headers, localHeight, now = Date.now(), pin = PRODUCT_VERSION) {
  const wantH = Math.max(0, Number(localHeight) || 0) + 1;
  for (const h of headers || []) {
    if (Number(h?.height) !== wantH) continue;
    const hash = wireHash(h.hash);
    if (!hash) continue;
    const permanent = rec?.failed instanceof Set
      ? rec.failed.has(hash)
      : Array.isArray(rec?.failed) && rec.failed.includes(hash);
    if (permanent) continue;
    if (failActive(rec, hash, now, pin)) return hash;
  }
  return '';
}

/** Ban only on final fails. `prev` / native-missing must not increment expensiveFails. */
export function recordIngestFail(rec, reason) {
  if (!rec) return false;
  if (!isFinalIngestFail(reason)) return false;
  return noteExpensiveFail(rec);
}

/** Out-of-order getblock: do not drop the child. Retry after in-flight parents land. */
export function requeuePrevHash(rec, hash) {
  const h = String(hash || '');
  if (!rec || !h) return rec;
  rec.retryPrev = Array.isArray(rec.retryPrev) ? rec.retryPrev : [];
  rec.want = Array.isArray(rec.want) ? rec.want : [];
  rec.pending = rec.pending instanceof Set ? rec.pending : new Set();
  if (rec.retryPrev.includes(h) || rec.want.includes(h) || rec.pending.has(h)) return rec;
  rec.retryPrev.push(h);
  return rec;
}

export function headerPrevHash(header) {
  let buf = null;
  if (Buffer.isBuffer(header)) buf = header;
  else if (typeof header === 'string' && /^[0-9a-f]+$/i.test(header) && header.length >= 72) {
    buf = Buffer.from(header, 'hex');
  }
  if (!buf || buf.length < 36) return '';
  const hex = Buffer.from(buf).subarray(4, 36).toString('hex');
  if (!hex || /^0+$/.test(hex)) return '';
  return hex;
}

function headerSkipped(hash, have, failed, pending) {
  const h = String(hash || '').toLowerCase();
  if (!h) return true;
  const has = (set) => (set instanceof Set ? set.has(h) : Array.isArray(set) && set.includes(h));
  return has(have) || has(failed) || has(pending);
}

/** Next header on a staged competing branch. Its parent is the side tip, not ours. */
export function sideFollowHeader({
  headers = [],
  sideTip = '',
  have,
  failed,
  pending,
} = {}) {
  const prevWant = String(sideTip || '').toLowerCase();
  if (!prevWant) return null;
  for (const h of headers || []) {
    const hash = wireHash(h.hash);
    if (!hash || headerSkipped(hash, have, failed, pending)) continue;
    const prev = headerPrevHash(h.header);
    if (prev && prev === prevWant) return { hash, height: Number(h.height) || 0 };
  }
  return null;
}

/**
 * Header whose parent is already in our chain, and is not our tip.
 * Sequential IBD skips this. It is how a split tip rejoins a heavier chain.
 */
export function competingHeader({
  headers = [],
  blocks = [],
  localHash = '',
  have,
  failed,
  pending,
} = {}) {
  const tip = String(localHash || '').toLowerCase();
  for (const h of headers || []) {
    const hash = wireHash(h.hash);
    if (!hash || headerSkipped(hash, have, failed, pending)) continue;
    const prev = headerPrevHash(h.header);
    if (!prev || (tip && prev === tip)) continue;
    if (headerIndexByHash(blocks, prev) < 0) continue;
    return { hash, height: Number(h.height) || 0 };
  }
  return null;
}

/**
 * First header we do not already have. Used when a heavier peer's chain
 * does not connect to ours, including a second genesis. Sequential IBD
 * never asks for it. Without this, two infancy tips never meet.
 */
export function unconnectedHeader({
  headers = [],
  have,
  failed,
  pending,
} = {}) {
  for (const h of headers || []) {
    const hash = wireHash(h.hash);
    if (!hash || headerSkipped(hash, have, failed, pending)) continue;
    return { hash, height: Number(h.height) || 0 };
  }
  return null;
}

/** On a prev miss, fetch the parent before the child is retried. */
export function queueMissingParent(rec, childHash, parentHash) {
  requeuePrevHash(rec, childHash);
  const parent = String(parentHash || '').toLowerCase();
  if (!rec || !parent || /^0+$/.test(parent)) return rec;
  rec.want = Array.isArray(rec.want) ? rec.want : [];
  rec.pending = rec.pending instanceof Set ? rec.pending : new Set();
  if (rec.pending.has(parent) || rec.want.includes(parent)) return rec;
  rec.want.unshift(parent);
  return rec;
}

export function drainRetryPrev(rec) {
  if (!rec) return rec;
  rec.retryPrev = Array.isArray(rec.retryPrev) ? rec.retryPrev : [];
  rec.want = Array.isArray(rec.want) ? rec.want : [];
  rec.pending = rec.pending instanceof Set ? rec.pending : new Set();
  if (rec.pending.size || !rec.retryPrev.length) return rec;
  for (const h of rec.retryPrev) {
    if (h && !rec.want.includes(h) && !rec.pending.has(h)) rec.want.unshift(h);
  }
  rec.retryPrev = [];
  return rec;
}

export function countSyncedOnline({
  localHash = '',
  peers = [],
  heard = [],
  includeSelf = true,
} = {}) {
  const want = String(localHash || '').toLowerCase();
  const seen = new Set();
  const take = (rec) => {
    if (rec == null || rec.hash == null) return;
    if (String(rec.hash).toLowerCase() !== want) return;
    const key = censusKey(rec) || (rec.remote ? '' : `sock:${rec.id || 0}`);
    if (!key) return;
    seen.add(key);
  };
  for (const rec of peers) take(rec);
  for (const rec of heard) take(rec);
  return (includeSelf ? 1 : 0) + seen.size;
}

/** Live TCP remotes, including peers still catching the block we just sealed. */
export function countLiveOnline({ peers = [], includeSelf = true } = {}) {
  const seen = new Set();
  for (const rec of peers) {
    if (rec == null) continue;
    seen.add(String(rec.remote || '') || `id:${rec.id || 0}`);
  }
  return (includeSelf ? 1 : 0) + seen.size;
}

export function createP2p({
  store,
  port = P2P_PORT,
  host = '0.0.0.0',
  magic = MAGIC_TESTNET,
  fluffDelayMs: fluffMs = null,
  stemRng = Math.random,
  maxPeers = p2pMaxPeers(),
} = {}) {
  const sockets = new Set();
  const peers = new Map();
  const linking = new Set();
  const seenTx = new Set();
  const peerBans = new Map();
  const originInvSize = new Map();
  const fluffTimers = new Map();
  const inflightBlocks = new Set();
  const getblockServeQ = [];
  const recentGetblockServe = new Map();
  const blockWaiters = new Map();
  const getblockMissLog = new Set();
  const gossipedTips = new Set();
  const gossipedTipOrder = [];
  let getblockServeTimer = null;
  let getblockServeSent = 0;
  let getblockServeMaxBacklog = 0;
  let pendingWatch = null;
  let tipNudgeTimer = null;
  let nudgedHash = '';
  let server = null;
  let peerSeq = 0;
  const selfId = randomBytes(8).toString('hex');
  const announced = new Map();
  let censusTimer = null;
  let lastCensus = 0;

  function listenPortOf() {
    return server?.address()?.port ?? port;
  }

  function advertisedPeers(exceptSock) {
    const local = localTipHash();
    const out = [];
    const seen = new Set();
    for (const [s, rec] of peers) {
      if (s === exceptSock) continue;
      const host = rec.remote;
      const p = Number(rec.listenPort) || 0;
      if (!host || !p) continue;
      if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') continue;
      if (!local || String(rec.hash || '') !== local) continue;
      const key = `${host}:${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ host, port: p });
    }
    return out;
  }

  function ibdBusy() {
    return isInitialBlockDownload({
      height: store.tip()?.height || 0,
      peers,
    });
  }

  function localWorkHex() {
    try {
      if (typeof store.chainWorkHex === 'function') return store.chainWorkHex();
    } catch { /* ignore */ }
    return '';
  }

  function peerTipAhead(rec) {
    if (!rec || peerDemoted(rec)) return false;
    return peerTipAheadOf({
      localHeight: Number(store.tip()?.height || 0),
      localWork: localWorkHex(),
      localHash: localTipHash(),
      peerHeight: rec.height,
      peerWork: rec.work,
      peerHash: rec.hash,
    });
  }

  function peerProbeAhead(rec) {
    if (!rec || peerDemoted(rec)) return false;
    if (rec.adHeight == null && (rec.adWork == null || rec.adWork === '') && !rec.adHash) return false;
    return peerTipAheadOf({
      localHeight: Number(store.tip()?.height || 0),
      localWork: localWorkHex(),
      localHash: localTipHash(),
      peerHeight: rec.adHeight,
      peerWork: rec.adWork,
      peerHash: rec.adHash || '',
    });
  }

  function bestOf(pred, view) {
    let bestSock = null;
    let bestRec = null;
    for (const [sock, rec] of peers) {
      if (!pred(rec)) continue;
      const row = view(rec);
      if (!bestRec || catchupPeerBetter(row, view(bestRec))
        || (!catchupPeerBetter(view(bestRec), row)
          && (Number(rec.bodiesServed) || 0) > (Number(bestRec.bodiesServed) || 0))) {
        bestSock = sock;
        bestRec = rec;
      }
    }
    return bestSock;
  }

  function bestAheadSock() {
    return bestOf(peerTipAhead, (rec) => rec);
  }

  function bestProbeSock() {
    if (bestAheadSock()) return null;
    return bestOf(peerProbeAhead, (rec) => ({
      height: rec.adHeight,
      work: rec.adWork,
      hash: rec.adHash,
    }));
  }

  function bestCatchupSock() {
    return bestAheadSock() || bestProbeSock();
  }

  function alreadyLinked(host, p) {
    if (p === listenPortOf() && (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0')) return true;
    for (const rec of peers.values()) {
      if (rec.remote === host && Number(rec.listenPort) === p) return true;
      if (rec.dialHost && rec.dialHost === host) return true;
    }
    return false;
  }

  function localTipHash() {
    const t = store.tip();
    return t ? Buffer.from(t.hash).toString('hex') : '';
  }

  function seenHashes() {
    const have = new Set((store.blocks || []).map((b) => hexHash(b.hash).toLowerCase()));
    if (typeof store.sideHashes === 'function') {
      for (const h of store.sideHashes()) {
        const hex = hexHash(h);
        if (hex) have.add(hex);
      }
    }
    return have;
  }

  function tipMsg() {
    const t = store.tip();
    const work = localWorkHex();
    return {
      type: 'tip',
      magic,
      height: t?.height || 0,
      hash: t ? Buffer.from(t.hash).toString('hex') : '',
      work: work || '0x0',
    };
  }

  function notePeerTip(sock, msg) {
    const rec = peers.get(sock) || { id: ++peerSeq, remote: peerRemoteKey(sock), hash: null, height: 0 };
    rec.remote = peerRemoteKey(sock) || rec.remote;
    applyTipAdvertisement(rec, msg, {
      localHeight: Number(store.tip()?.height || 0),
      localHash: localTipHash(),
    });
    peers.set(sock, rec);
  }

  function send(sock, msg) {
    try { sock.write(line(msg)); } catch { /* ignore */ }
  }

  function broadcast(msg, except) {
    for (const s of sockets) {
      if (s !== except) send(s, msg);
    }
  }

  const seenTxOrder = [];
  function rememberTxId(id) {
    if (!id) return false;
    if (seenTx.has(id)) return false;
    seenTx.add(id);
    seenTxOrder.push(id);
    while (seenTx.size > 8000) {
      const old = seenTxOrder.shift();
      if (old) seenTx.delete(old);
    }
    return true;
  }

  function delayFluff() {
    if (fluffMs != null) return Math.max(0, Number(fluffMs) || 0);
    return fluffDelayMs(stemRng);
  }

  function wireTx(tx) {
    return admitWireTx(tx);
  }

  function scheduleFluff(id, tx, except) {
    const key = String(id || '');
    if (!key || fluffTimers.has(key)) return;
    const t = setTimeout(() => {
      fluffTimers.delete(key);
      broadcast({ type: 'tx', magic, tx: wireTx(tx), stem: false }, except);
    }, delayFluff());
    fluffTimers.set(key, t);
  }

  function stemRelay(tx, fromSock, hops) {
    const nextHop = (Number(hops) || 0) + 1;
    const next = pickStemSocket(sockets, fromSock, stemRng);
    if (next) send(next, { type: 'tx', magic, tx: wireTx(tx), stem: true, hops: nextHop });
    return next ? 1 : 0;
  }

  function ingestRemoteTx(tx, fromSock, { stem = false, hops = 0 } = {}) {
    const id = String(tx?.id || '');
    if (!id || !rememberTxId(id)) return;
    if (typeof store.queueTx !== 'function') return;
    const got = store.queueTx(tx);
    if (!got?.ok) {
      seenTx.delete(id);
      return;
    }
    const payload = wireTx(got.tx || tx);
    if (stem && hops < STEM_MAX_HOPS) {
      stemRelay(payload, fromSock, hops);
      scheduleFluff(id, payload, fromSock);
      return;
    }
    broadcast({ type: 'tx', magic, tx: payload, stem: false }, fromSock);
  }

  if (store && typeof store.on === 'function') {
    store.on('tx', (tx) => {
      const id = String(tx?.id || '');
      if (!id) return;
      if (!rememberTxId(id)) return;
      const sealed = wireTx(tx);
      const n = stemRelay(sealed, null, 0);
      originInvSize.set(id, n);
      scheduleFluff(id, sealed, null);
    });
  }

  function publishWork(rows = []) {
    const list = safeMinerRounds(rows);
    if (typeof store.noteOpenRound === 'function') store.noteOpenRound(list, { source: 'local' });
    if (list.length) broadcast({ type: 'work', magic, rows: list });
  }

  function locators() {
    const base = locatorHashes(store.blocks || []);
    const side = typeof store.sideTipHash === 'function' ? store.sideTipHash() : '';
    if (!side) return base;
    return [side, ...base.filter((h) => h !== side)];
  }

  function beginHeaders(sock) {
    const rec = peers.get(sock);
    if (!rec || rec.syncing) return;
    if (rec.softHoldUntil && Date.now() < rec.softHoldUntil) return;
    if (peerDemoted(rec)) return;
    const eligible = peerTipAhead(rec);
    const probe = !eligible && peerProbeAhead(rec);
    if (!eligible && !probe) return;
    if (eligible) {
      if (bestAheadSock() !== sock) return;
    } else if (bestCatchupSock() !== sock) return;
    rec.syncing = true;
    send(sock, {
      type: 'getheaders',
      magic,
      locator: locators(),
      stopHash: String(rec.adHash || rec.hash || ''),
    });
  }

  let catchupScheduled = false;
  function scheduleCatchup() {
    if (catchupScheduled) return;
    catchupScheduled = true;
    setImmediate(() => {
      catchupScheduled = false;
      const best = bestCatchupSock();
      if (best && bestAheadSock()) handoffWants(bestAheadSock());
      for (const [sock, rec] of peers) {
        if (sock === best) continue;
        if (rec?.syncing && !(rec.pending && rec.pending.size)) rec.syncing = false;
      }
      if (best) beginHeaders(best);
    });
  }

  function requestHeaders(sock) {
    const rec = peers.get(sock);
    if (!rec || rec.syncing) return;
    if (rec.softHoldUntil && Date.now() < rec.softHoldUntil) return;
    if (peerDemoted(rec)) return;
    if (!peerTipAhead(rec) && !peerProbeAhead(rec)) return;
    scheduleCatchup();
  }

  function softWaitMs(rec) {
    const now = Date.now();
    let wait = SOFT_FAIL_TTL_MS;
    if (rec?.softFailed instanceof Map) {
      for (const row of rec.softFailed.values()) {
        const left = SOFT_FAIL_TTL_MS - (now - Number(row?.at || 0));
        if (left > 0 && left < wait) wait = left;
      }
    }
    return Math.max(50, wait);
  }

  function armSoftRetry(sock, rec) {
    if (!rec) return;
    const wait = softWaitMs(rec);
    rec.softHoldUntil = Date.now() + wait;
    if (rec.softTimer) return;
    rec.softTimer = setTimeout(() => {
      rec.softTimer = null;
      const live = peers.get(sock);
      if (!live) return;
      live.softHoldUntil = 0;
      live.syncing = false;
      requestHeaders(sock);
    }, wait);
    if (typeof rec.softTimer.unref === 'function') rec.softTimer.unref();
  }

  function rememberGossip(hash) {
    if (!hash || gossipedTips.has(hash)) return false;
    gossipedTips.add(hash);
    gossipedTipOrder.push(hash);
    while (gossipedTipOrder.length > 256) {
      const old = gossipedTipOrder.shift();
      if (old) gossipedTips.delete(old);
    }
    return true;
  }

  /** Forward a strictly taller tip before this node has the block. Same-height and shorter hashes stay put. */
  function gossipTip(msg, except) {
    const hash = wireHash(msg?.hash);
    const h = Number(msg?.height);
    const localH = Number(store.tip()?.height || 0);
    if (!hash || !Number.isFinite(h) || h <= localH) return;
    if (!rememberGossip(hash)) return;
    broadcast({
      type: 'tip',
      magic,
      relay: true,
      height: h,
      hash,
      work: msg?.work != null && String(msg.work) !== '' ? String(msg.work) : '0x0',
    }, except);
  }

  function takeWants(rec) {
    const out = [];
    if (Array.isArray(rec?.want)) out.push(...rec.want);
    if (Array.isArray(rec?.retryPrev)) out.push(...rec.retryPrev);
    if (rec?.pending instanceof Set) out.push(...rec.pending);
    return out.filter(Boolean);
  }

  /** Outstanding getblocks follow the tallest ahead peer, not the lagging mesh. */
  function handoffWants(best) {
    const bestRec = peers.get(best);
    if (!bestRec) return;
    if (!Array.isArray(bestRec.want)) bestRec.want = [];
    if (!bestRec.pending) bestRec.pending = new Set();
    for (const [sock, rec] of peers) {
      if (sock === best || !rec) continue;
      for (const h of takeWants(rec)) {
        inflightBlocks.delete(String(h).toLowerCase());
        if (!bestRec.want.includes(h) && !bestRec.pending.has(h)) bestRec.want.push(h);
      }
      rec.want = [];
      rec.retryPrev = [];
      if (rec.pending) rec.pending = new Set();
      rec.pendingAt = 0;
      if (!(rec.verifying && rec.verifying.size)) rec.syncing = false;
    }
  }

  /**
   * A one-block gap pulls that hash from the tallest ahead peer.
   * A lagging mesh peer at local+1 does not win while someone taller is connected.
   * Already pending, in flight, or verifying does not send a second ask.
   */
  function pullOneBlock(sock, msg) {
    const rec = peers.get(sock);
    if (!rec) return false;
    const best = bestCatchupSock();
    if (best && best !== sock) return false;
    if (tipIsRelay(msg) && !peerTipAhead(rec)) return false;
    const hash = wireHash(msg?.hash);
    const peerH = Number(msg?.height);
    const localH = Number(store.tip()?.height || 0);
    if (!hash || !Number.isFinite(peerH) || peerH !== localH + 1) return false;
    const have = new Set((store.blocks || []).map((b) => hexHash(b.hash).toLowerCase()));
    if (have.has(hash)) return false;
    if (!rec.pending) rec.pending = new Set();
    if (!rec.failed) rec.failed = new Set();
    if (failActive(rec, hash)) {
      if (upgradeableHold(rec, [{ hash, height: peerH }], localH)) armSoftRetry(sock, rec);
      return false;
    }
    if (rec.pending.has(hash) || rec.verifying?.has(hash) || inflightBlocks.has(hash)) return true;
    rec.pending.add(hash);
    inflightBlocks.add(hash);
    rec.pendingAt = Date.now();
    rec.syncing = true;
    send(sock, { type: 'getblock', magic, hash });
    return true;
  }

  function noteBlockWaiter(hash, sock) {
    const h = String(hash || '').toLowerCase();
    if (!h || !sock) return;
    let set = blockWaiters.get(h);
    if (!set) {
      set = new Set();
      blockWaiters.set(h, set);
    }
    if (set.size >= 32 && !set.has(sock)) return;
    set.add(sock);
  }

  function serveWaiters(hash) {
    const h = String(hash || '').toLowerCase();
    const set = blockWaiters.get(h);
    if (!set || !set.size) return;
    blockWaiters.delete(h);
    const idx = headerIndexByHash(store.blocks, h);
    const block = idx >= 0 ? store.blocks[idx] : null;
    if (!block) return;
    for (const waiter of set) {
      if (!waiter || waiter.destroyed || !peers.has(waiter)) continue;
      enqueueGetblockServe(waiter, block);
    }
  }

  function armTipNudge() {
    if (tipNudgeTimer) return;
    tipNudgeTimer = setTimeout(() => {
      tipNudgeTimer = null;
      const nowHash = localTipHash();
      if (nowHash && nowHash !== nudgedHash) {
        nudgedHash = nowHash;
        announce();
      }
      let stillAhead = false;
      for (const [sock, rec] of peers) {
        if (!peerTipAhead(rec)) continue;
        stillAhead = true;
        const localH = Number(store.tip()?.height || 0);
        const peerH = Number(rec.height);
        const oneStep = wireHash(rec.hash) && peerH === localH + 1;
        const pulled = oneStep && pullOneBlock(sock, rec);
        if (!pulled && (!rec.syncing || !(rec.pending && rec.pending.size))) requestHeaders(sock);
      }
      if (stillAhead) armTipNudge();
    }, TIP_NUDGE_MS);
    if (typeof tipNudgeTimer.unref === 'function') tipNudgeTimer.unref();
  }

  /**
   * A want left over after this node has caught every catch-up peer keeps
   * IBD true. Nobody ahead means that hash will not be fetched. Drop it.
   * A peer that is still ahead keeps its queue; this does not run then.
   */
  function releaseIdleCatchup() {
    if (bestCatchupSock()) return;
    for (const rec of peers.values()) {
      if (rec?.verifying && rec.verifying.size) continue;
      const want = Array.isArray(rec?.want) ? rec.want : [];
      const pending = rec?.pending instanceof Set ? [...rec.pending] : [];
      const retry = Array.isArray(rec?.retryPrev) ? rec.retryPrev : [];
      const leftover = [...want, ...pending, ...retry].filter(Boolean);
      if (!leftover.length && !rec?.syncing) continue;
      for (const h of leftover) inflightBlocks.delete(String(h).toLowerCase());
      rec.want = [];
      rec.wantHeight = 0;
      rec.retryPrev = [];
      rec.pending = new Set();
      rec.pendingAt = 0;
      rec.syncing = false;
    }
  }

  function pumpGetblocks(sock) {
    const rec = peers.get(sock);
    if (!rec) return;
    if (peerDemoted(rec)) {
      // A tip advertisement is not a block inventory. getblock follows a
      // body-proven peer only; a probe is asked for headers.
      const next = bestAheadSock();
      if (next && next !== sock) {
        handoffWants(next);
        pumpGetblocks(next);
      } else {
        const probe = bestProbeSock();
        if (probe && probe !== sock) beginHeaders(probe);
      }
      return;
    }
    const eligible = bestAheadSock();
    const best = eligible || bestProbeSock();
    if (best && best !== sock) {
      // Missed-hash handoff is body-proven only. A taller tip ad keeps its
      // own header ask; it does not inherit this sock's getblock queue.
      if (eligible) handoffWants(eligible);
      pumpGetblocks(best);
      return;
    }
    if (!best) {
      releaseIdleCatchup();
      return;
    }
    if (!Array.isArray(rec.want)) rec.want = [];
    if (!rec.pending) rec.pending = new Set();
    if (!rec.failed) rec.failed = new Set();
    drainRetryPrev(rec);
    const have = new Set((store.blocks || []).map((b) => hexHash(b.hash).toLowerCase()));
    while (rec.pending.size < getblockBatch() && rec.want.length) {
      const hash = rec.want[0];
      if (!hash || have.has(hash) || failActive(rec, hash) || rec.pending.has(hash)) {
        rec.want.shift();
        continue;
      }
      if (rec.verifying?.has(hash) || inflightBlocks.has(hash)) break;
      rec.want.shift();
      rec.pending.add(hash);
      inflightBlocks.add(hash);
      rec.pendingAt = Date.now();
      rec.syncing = true;
      send(sock, { type: 'getblock', magic, hash });
    }
    if (rec.pending.size) return;
    if (rec.verifying && rec.verifying.size) return;
    if (rec.want.length && inflightBlocks.has(String(rec.want[0]).toLowerCase())) return;
    rec.syncing = false;
    rec.pending = null;
    requestHeaders(sock);
  }

  function flushGetblockServe() {
    getblockServeTimer = null;
    let n = 0;
    const localH = Number(store.tip()?.height || 0);
    let midChain = false;
    if (localH > 0) {
      for (const rec of peers.values()) {
        if (peerTipAhead(rec) || peerProbeAhead(rec)) { midChain = true; break; }
      }
    }
    let behind = false;
    for (const rec of peers.values()) {
      const ownH = Number(rec?.height);
      if (Number.isFinite(ownH) && ownH > 0 && ownH < localH) { behind = true; break; }
    }
    const cap = getblockServeCap({ ibd: ibdBusy(), midChain, behind });
    while (n < cap && getblockServeQ.length) {
      const job = getblockServeQ.shift();
      n += 1;
      if (!job?.sock || job.sock.destroyed) continue;
      send(job.sock, { type: 'block', magic, block: encodeWireBlock(job.block) });
      if (job.key) recentGetblockServe.set(job.key, Date.now());
      getblockServeSent += 1;
    }
    if (n > 0) {
      try {
        console.error(JSON.stringify({
          event: 'p2p_getblock_serve',
          n,
          left: getblockServeQ.length,
          cap,
        }));
      } catch { /* ignore */ }
    }
    if (getblockServeQ.length) scheduleGetblockServe();
  }

  function scheduleGetblockServe() {
    if (getblockServeTimer) return;
    getblockServeTimer = setTimeout(flushGetblockServe, 0);
    if (typeof getblockServeTimer.unref === 'function') getblockServeTimer.unref();
  }

  function enqueueGetblockServe(sock, block) {
    const hash = hexHash(block?.hash);
    const key = `${peers.get(sock)?.id || 0}:${hash}`;
    const now = Date.now();
    const queued = getblockServeQ.some((job) => job.key === key);
    if (!shouldEnqueueGetblock({ queued, servedAt: recentGetblockServe.get(key) || 0, now })) return false;
    getblockServeQ.push({ sock, block, key });
    if (getblockServeQ.length > getblockServeMaxBacklog) {
      getblockServeMaxBacklog = getblockServeQ.length;
    }
    if (recentGetblockServe.size > 4096) {
      for (const [k, at] of recentGetblockServe) {
        if (now - at >= GETBLOCK_SERVE_DEDUPE_MS) recentGetblockServe.delete(k);
      }
    }
    scheduleGetblockServe();
    return true;
  }

  function directCensus() {
    const local = localTipHash().toLowerCase();
    const nodes = [];
    const seen = new Set();
    for (const rec of peers.values()) {
      if (rec.hash == null) continue;
      if (String(rec.hash).toLowerCase() !== local) continue;
      const nodeId = String(rec.nodeId || '').trim().toLowerCase();
      const host = String(rec.remote || '').trim();
      const row = { nodeId, host, remote: host, hash: String(rec.hash).toLowerCase() };
      const key = censusKey(row);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      nodes.push({ id: nodeId, host, hash: row.hash });
      if (nodes.length >= CENSUS_MAX) break;
    }
    return nodes;
  }

  function heardNow() {
    const out = [];
    for (const slot of announced.values()) {
      for (const row of [...(slot.hop0 || []), ...(slot.hop1 || [])]) out.push(row);
    }
    return out;
  }

  function censusFromWire(list) {
    const nodes = [];
    const seen = new Set();
    for (const n of (Array.isArray(list) ? list : []).slice(0, CENSUS_MAX)) {
      if (n?.hash == null) continue;
      const nodeId = String(n.id || n.nodeId || '').trim().toLowerCase();
      const host = String(n.host || '').trim();
      if (nodeId && nodeId === selfId) continue;
      const hash = (wireHash(n.hash) || String(n.hash)).toLowerCase();
      const row = { nodeId, host, remote: host, hash };
      const key = censusKey(row);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      nodes.push(row);
    }
    return nodes;
  }

  function broadcastCensus(force = false) {
    const now = Date.now();
    if (!force && now - lastCensus < 500) return;
    lastCensus = now;
    broadcast({ type: 'census', magic, hop: 0, nodes: directCensus() });
  }

  function handle(sock, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.magic && msg.magic !== magic) {
      sock.destroy();
      return;
    }
    if (msg.type === 'hello') {
      const rec = peers.get(sock) || { id: ++peerSeq, remote: peerRemoteKey(sock), hash: null, height: 0 };
      rec.remote = peerRemoteKey(sock) || rec.remote;
      const advertised = Number(msg.port);
      if (Number.isFinite(advertised) && advertised > 0) rec.listenPort = advertised;
      rec.ua = String(msg.ua || rec.ua || '');
      const nid = String(msg.nodeId || '').trim().toLowerCase();
      if (/^[0-9a-f]{8,32}$/.test(nid)) rec.nodeId = nid;
      peers.set(sock, rec);
      send(sock, tipMsg());
      send(sock, { type: 'addr', magic, peers: advertisedPeers(sock) });
      send(sock, { type: 'getmempool', magic });
      return;
    }
    if (msg.type === 'getmempool') {
      send(sock, {
        type: 'mempool',
        magic,
        txs: Array.isArray(store.mempool) ? store.mempool.slice(0, 4096).map(compactTx) : [],
        work: typeof store.openRoundRows === 'function' ? store.openRoundRows() : [],
      });
      return;
    }
    if (msg.type === 'mempool') {
      for (const tx of msg.txs || []) ingestRemoteTx(tx, sock);
      if (typeof store.noteOpenRound === 'function' && Array.isArray(msg.work)) {
        store.noteOpenRound(msg.work, { source: 'peer' });
      }
      return;
    }
    if (msg.type === 'tx') {
      ingestRemoteTx(msg.tx, sock, { stem: !!msg.stem, hops: Number(msg.hops) || 0 });
      return;
    }
    if (msg.type === 'work') {
      const before = typeof store.openRoundRows === 'function' ? store.openRoundRows() : [];
      if (typeof store.noteOpenRound === 'function') {
        store.noteOpenRound(msg.rows || [], { source: 'peer' });
      }
      const after = typeof store.openRoundRows === 'function' ? store.openRoundRows() : [];
      const fresh = freshMinerRounds(before, after);
      if (fresh.length) broadcast({ type: 'work', magic, rows: fresh }, sock);
      return;
    }
    if (msg.type === 'addr') {
      if (ibdBusy()) return;
      for (const p of msg.peers || []) {
        const host = String(p.host || '').trim();
        const portN = Number(p.port);
        if (!host || !Number.isFinite(portN) || portN <= 0) continue;
        if (!isRoutablePeerAddr(host)) continue;
        const key = `${host}:${portN}`;
        if (linking.has(key) || alreadyLinked(host, portN)) continue;
        linking.add(key);
        connect(host, portN).catch(() => {}).finally(() => linking.delete(key));
      }
      return;
    }
    if (msg.type === 'census') {
      const hop = Number(msg.hop) || 0;
      const nodes = censusFromWire(msg.nodes);
      const slot = announced.get(sock) || { hop0: [], hop1: [] };
      if (hop >= CENSUS_HOP_MAX) slot.hop1 = nodes;
      else slot.hop0 = nodes;
      announced.set(sock, slot);
      if (hop < CENSUS_HOP_MAX) {
        broadcast({
          type: 'census',
          magic,
          hop: hop + 1,
          nodes: nodes.map((n) => ({ id: n.nodeId, host: n.host, hash: n.hash })),
        }, sock);
      }
      return;
    }
    if (msg.type === 'tip' || msg.type === 'inv') {
      notePeerTip(sock, msg);
      const rec = peers.get(sock);
      if (rec && String(rec.hash || '').toLowerCase() === localTipHash().toLowerCase()) {
        broadcastCensus();
      }
      const localH = Number(store.tip()?.height || 0);
      const peerH = Number(msg.height);
      const ahead = Number.isFinite(peerH) && peerH > localH;
      if (ahead) gossipTip(msg, sock);
      const oneStep = Number.isFinite(peerH) && peerH === localH + 1;
      if (!(oneStep && pullOneBlock(sock, msg))) requestHeaders(sock);
      if (ahead || peerTipAhead(peers.get(sock))) armTipNudge();
      return;
    }
    if (msg.type === 'getblocks') {
      return;
    }
    if (msg.type === 'getheaders') {
      const hdrs = selectHeadersAfterLocator(store.blocks || [], {
        locator: msg.locator,
        stopHash: msg.stopHash || msg.hashStop || '',
        limit: HEADERS_PAGE,
      });
      send(sock, { type: 'headers', magic, headers: hdrs });
      return;
    }
    if (msg.type === 'headers') {
      const rec = peers.get(sock) || { id: ++peerSeq, remote: peerRemoteKey(sock), hash: null, height: 0 };
      rec.remote = peerRemoteKey(sock) || rec.remote;
      if (!rec.failed) rec.failed = new Set();
      if (!rec.pending) rec.pending = new Set();
      peers.set(sock, rec);
      const tip = store.tip();
      const localH = Number(tip?.height || 0);
      const localHash = tip?.hash ? hexHash(tip.hash) : '';
      const have = seenHashes();
      const page = msg.headers || [];
      rec.page = page;
      const sideTip = typeof store.sideTipHash === 'function' ? store.sideTipHash() : '';
      const blocked = activeFailSet(rec);
      // A probe-ahead tip has not served a body, so its winning block is not
      // local+1 on our fork. Sequential misses it. Fetch that header anyway.
      const next = nextSequentialHeader({
        headers: page,
        localHeight: localH,
        localHash,
        have,
        failed: blocked,
        pending: rec.pending,
      }) || sideFollowHeader({
        headers: page,
        sideTip,
        have,
        failed: blocked,
        pending: rec.pending,
      }) || competingHeader({
        headers: page,
        blocks: store.blocks || [],
        localHash,
        have,
        failed: blocked,
        pending: rec.pending,
      }) || ((peerTipAhead(rec) || peerProbeAhead(rec)) ? unconnectedHeader({
        headers: page,
        have,
        failed: blocked,
        pending: rec.pending,
      }) : null);
      const localPlus = localH + 1;
      let otherWants = false;
      for (const [otherSock, other] of peers) {
        if (otherSock === sock) continue;
        const queued = (Array.isArray(other.want) && other.want.length)
          || (other.pending instanceof Set && other.pending.size);
        if (Number(other?.wantHeight) === localPlus && queued) otherWants = true;
      }
      const fromShorter = Number(rec.adHeight ?? rec.height ?? 0) < localPlus;
      const clearWant = !next && Number(msg.next) === 0
        ? shouldClearWantOnNextZero({
          fromEligible: rec.syncEligible === true && !peerDemoted(rec),
          fromShorter,
          otherWantsLocalPlusOne: otherWants,
        })
        : true;
      if (next) {
        rec.want = [next.hash];
        rec.wantHeight = next.height;
      } else if (clearWant) {
        rec.want = [];
        rec.wantHeight = 0;
      }
      if (!(rec.want || []).length && !(rec.pending && rec.pending.size)) {
        if (rec.verifying && rec.verifying.size) return;
        rec.syncing = false;
        rec.pending = null;
        if (upgradeableHold(rec, page, localH)) {
          armSoftRetry(sock, rec);
          return;
        }
        requestHeaders(sock);
        return;
      }
      try {
        console.error(JSON.stringify({
          event: 'p2p_headers',
          n: (msg.headers || []).length,
          missing: rec.want.length + (rec.pending ? rec.pending.size : 0),
          local: localH,
          next: next?.height || 0,
        }));
      } catch { /* ignore */ }
      if (rec.verifying && rec.verifying.size) return;
      pumpGetblocks(sock);
      return;
    }
    if (msg.type === 'getblock') {
      const want = wireHash(msg.hash);
      const idx = want ? headerIndexByHash(store.blocks, want) : -1;
      const b = idx >= 0 ? store.blocks[idx] : null;
      if (b) {
        try {
          console.error(JSON.stringify({
            event: 'p2p_getblock',
            found: true,
            height: b.height || 0,
          }));
        } catch { /* ignore */ }
        enqueueGetblockServe(sock, b);
      } else if (want) {
        send(sock, { type: 'getblock_nak', magic, hash: want });
        noteBlockWaiter(want, sock);
      }
      return;
    }
    if (msg.type === 'getblock_nak' || msg.type === 'block_not_found') {
      const missHash = wireHash(msg.hash);
      const recMiss = peers.get(sock);
      if (missHash) inflightBlocks.delete(missHash);
      if (recMiss) {
        recMiss.pending?.delete(missHash);
        if (!recMiss.pending || recMiss.pending.size === 0) recMiss.pendingAt = 0;
        const logKey = `${recMiss.id || recMiss.remote || ''}:${missHash}`;
        if (!getblockMissLog.has(logKey)) {
          getblockMissLog.add(logKey);
          try {
            console.error(JSON.stringify({
              event: 'p2p_getblock_miss',
              hash: missHash,
              peer: recMiss.remote || '',
            }));
          } catch { /* ignore */ }
        }
        if (!Array.isArray(recMiss.want)) recMiss.want = [];
        if (missHash && !recMiss.want.includes(missHash)) recMiss.want.unshift(missHash);
        const missed = noteGetblockMiss(recMiss, Date.now());
        recMiss.syncing = false;
        if (missed.demoted) {
          const nextSock = bestAheadSock();
          if (nextSock && nextSock !== sock) {
            const dest = peers.get(nextSock);
            if (dest) {
              if (!Array.isArray(dest.want)) dest.want = [];
              if (!dest.pending) dest.pending = new Set();
              for (const h of [...(recMiss.want || [])]) {
                inflightBlocks.delete(String(h).toLowerCase());
                if (!dest.want.includes(h) && !dest.pending.has(h)) dest.want.push(h);
              }
              recMiss.want = [];
            }
            handoffWants(nextSock);
            pumpGetblocks(nextSock);
            return;
          }
          // The next taller tip ad may be asked for headers. It has not
          // served a body, so the missed hash is not a getblock to that sock.
          const probe = bestProbeSock();
          if (probe && probe !== sock) beginHeaders(probe);
          return;
        }
        const ahead = bestAheadSock();
        if (ahead && ahead !== sock) pumpGetblocks(ahead);
        else pumpGetblocks(sock);
      }
      return;
    }
    if (msg.type === 'block' || msg.type === 'blocks') {
      const list = msg.block ? [msg.block] : (msg.blocks || []);
      if (list.length > 1 && msg.type === 'blocks') return;
      const last = list[list.length - 1];
      let fork;
      try {
        fork = list.map(decodeWireBlock);
      } catch (err) {
        try {
          console.error(JSON.stringify({
            event: 'p2p_ingest',
            ok: false,
            reason: 'decode',
            height: last?.height,
          }));
        } catch { /* ignore */ }
        return;
      }
      const recNow = peers.get(sock);
      const lastHash = last ? wireHash(last.hash) : '';
      if (process.env.SHEAR_P2P_FOLLOW_IPC === '1') {
        const tip = store.tip();
        const tipHash = tip?.hash ? Buffer.from(tip.hash).toString('hex') : '';
        const prev = headerPrevHash(last?.header);
        if (!tipHash || prev !== tipHash) {
          try {
            console.error(JSON.stringify({
              event: 'p2p_ingest',
              ok: false,
              reason: 'follow_ipc',
              height: last?.height,
            }));
          } catch { /* ignore */ }
          return;
        }
      }
      if (lastHash) inflightBlocks.delete(lastHash);
      const haveNow = new Set((store.blocks || []).map((b) => hexHash(b.hash).toLowerCase()));
      if (lastHash && haveNow.has(lastHash)) {
        if (recNow) {
          recNow.pending?.delete(lastHash);
          recNow.verifying?.delete(lastHash);
          pumpGetblocks(sock);
        }
        return;
      }
      const verifyKey = fork?.[0]?.header ? Buffer.from(fork[0].header).toString('hex') : lastHash;
      if (verifyKey && recNow?.verifying?.has(verifyKey)) return;
      if (recNow) {
        if (!recNow.pending) recNow.pending = new Set();
        if (!recNow.failed) recNow.failed = new Set();
        if (!recNow.verifying) recNow.verifying = new Set();
        if (lastHash) recNow.pending.delete(lastHash);
        if (verifyKey) {
          recNow.verifying.add(verifyKey);
          recNow.syncing = true;
        }
      }
      const job = scheduleP2pVerify(() => {
        const before = store.tip();
        // IBD validates every block. A peer-advertised height is not a skip.
        return Promise.resolve(store.ingest(fork, {
          offLoopPow: true,
        })).then((got) => ({ got, before }));
      });
      job.then(({ got, before }) => {
        const rec = peers.get(sock);
        if (!got?.ok) {
          try {
            console.error(JSON.stringify({
              event: 'p2p_ingest',
              ok: false,
              reason: got?.reason || 'fail',
              height: last?.height,
            }));
          } catch { /* ignore */ }
        }
        if (rec) {
          rec.verifying?.delete(verifyKey);
          if (!rec.failed) rec.failed = new Set();
          if (!got?.ok && lastHash) {
            const have = new Set((store.blocks || []).map((b) => hexHash(b.hash)));
            if (got?.reason === 'prev' && !have.has(lastHash)) {
              queueMissingParent(rec, lastHash, headerPrevHash(last?.header));
            } else if (got?.reason === 'hash_bonus' && !have.has(lastHash)) {
              requeuePrevHash(rec, lastHash);
            } else if (got?.reason === 'side_hold') {
              const follow = sideFollowHeader({
                headers: rec.page || [],
                sideTip: typeof store.sideTipHash === 'function' ? store.sideTipHash() : '',
                have,
                failed: activeFailSet(rec),
                pending: rec.pending,
              });
              if (follow) rec.want = [follow.hash, ...(rec.want || [])];
            } else if (isUpgradeableIngestFail(got?.reason) && !have.has(lastHash)) {
              noteSoftFail(rec, lastHash, got.reason);
            } else if (isFinalIngestFail(got?.reason)) rec.failed.add(lastHash);
          }
          if (!got?.ok && recordIngestFail(rec, got?.reason)) {
            const until = Date.now() + P2P_BAN_MS;
            if (rec.remote) peerBans.set(rec.remote, until);
            try { sock.destroy(); } catch { /* ignore */ }
          } else if (got?.ok) {
            const tipNow = store.tip();
            const tipH = Number(tipNow?.height || last?.height || 0);
            const servedHash = last?.hash ? hexHash(last.hash) : '';
            // Catch-up height is the applied tip or the served body. The tip
            // advertisement stays on adHeight / gossipHeight for peerMax.
            markSyncEligible(rec, {
              height: tipH,
              hash: localTipHash() || servedHash,
              work: localWorkHex(),
              reason: 'body',
            });
            try {
              console.error(JSON.stringify({
                event: 'p2p_ingest',
                ok: true,
                height: store.tip()?.height || last?.height,
              }));
            } catch { /* ignore */ }
          }
        }
        const after = store.tip();
        const changed = (before && after)
          ? !Buffer.from(before.hash).equals(Buffer.from(after.hash))
          : Boolean(after && !before);
        if (got?.ok) {
          if (lastHash) serveWaiters(lastHash);
          if (changed) {
            broadcast(tipMsg(), sock);
            const tipHash = localTipHash();
            if (tipHash && tipHash !== lastHash) serveWaiters(tipHash);
          }
        }
        if (rec) pumpGetblocks(sock);
        // A discarded solo tip must not leave header sync idle while a peer
        // is already taller. pumpGetblocks no-ops when this sock is not the
        // best one, or when syncing was left set across the reorg.
        if (got?.reorg) {
          for (const recPeer of peers.values()) {
            if (!recPeer) continue;
            if (recPeer.verifying && recPeer.verifying.size) continue;
            if (recPeer.pending && recPeer.pending.size) continue;
            recPeer.syncing = false;
          }
          scheduleCatchup();
        }
      }).catch((err) => {
        const rec = peers.get(sock);
        if (rec) {
          rec.verifying?.delete(verifyKey);
          rec.syncing = false;
          rec.pending = null;
          pumpGetblocks(sock);
        }
        try {
          console.error(JSON.stringify({
            event: 'p2p_ingest',
            ok: false,
            reason: String(err?.message || err || 'throw').slice(0, 80),
            height: last?.height,
          }));
        } catch { /* ignore */ }
      });
    }
  }

  function drop(sock) {
    const rec = peers.get(sock);
    if (rec?.softTimer) {
      clearTimeout(rec.softTimer);
      rec.softTimer = null;
    }
    sockets.delete(sock);
    peers.delete(sock);
    announced.delete(sock);
    broadcastCensus(true);
    for (const [hash, set] of blockWaiters) {
      set.delete(sock);
      if (!set.size) blockWaiters.delete(hash);
    }
  }

  function attach(sock, extra = {}) {
    const remote = peerRemoteKey(sock);
    const until = peerBans.get(remote) || 0;
    if (until > Date.now()) {
      try { sock.destroy(); } catch { /* ignore */ }
      return;
    }
    const inbound = !extra.dialHost;
    if (peers.size >= maxPeers) {
      try { sock.destroy(); } catch { /* ignore */ }
      return;
    }
    if (inbound) {
      const subnet = ipv4Subnet24(remote);
      if (inboundCountForSubnet(peers, subnet) >= P2P_INBOUND_PER24) {
        try { sock.destroy(); } catch { /* ignore */ }
        return;
      }
    }
    sockets.add(sock);
    peers.set(sock, {
      id: ++peerSeq,
      remote,
      hash: null,
      height: 0,
      dialHost: extra.dialHost || '',
      inbound,
      expensiveFails: 0,
    });
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > P2P_MAX_FRAME) {
        sock.destroy();
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        handle(sock, msg);
      }
    });
    sock.on('close', () => drop(sock));
    sock.on('error', () => drop(sock));
    send(sock, { type: 'hello', magic, ua: P2P_UA, port: listenPortOf(), nodeId: selfId });
    send(sock, tipMsg());
  }

  function listen() {
    server = net.createServer(attach);
    if (pendingWatch) clearInterval(pendingWatch);
    if (censusTimer) clearInterval(censusTimer);
    censusTimer = setInterval(() => broadcastCensus(), 2000);
    if (typeof censusTimer.unref === 'function') censusTimer.unref();
    pendingWatch = setInterval(() => {
      const now = Date.now();
      for (const [sock, rec] of peers) {
        if (!rec?.syncing || !rec.pending || !rec.pending.size || !rec.pendingAt) continue;
        const peerH = Number(rec.adHeight ?? rec.height ?? rec.gossipHeight ?? 0);
        const waitMs = getblockWaitMs({
          localHeight: Number(store.tip()?.height || 0),
          peerHeight: peerH,
        });
        if (now - rec.pendingAt < waitMs) continue;
        const stuck = [...rec.pending];
        for (const h of stuck) inflightBlocks.delete(h);
        rec.pending = new Set();
        rec.pendingAt = 0;
        rec.want = [...stuck, ...(rec.want || [])];
        rec.syncing = false;
        const nextSock = bestAheadSock();
        if (nextSock && nextSock !== sock) {
          handoffWants(nextSock);
          pumpGetblocks(nextSock);
        } else if (!peerDemoted(rec)) {
          pumpGetblocks(sock);
        } else {
          const probe = bestProbeSock();
          if (probe && probe !== sock) beginHeaders(probe);
        }
      }
      const ahead = bestAheadSock();
      if (ahead) {
        const live = peers.get(ahead);
        const pendingN = live?.pending instanceof Set ? live.pending.size : 0;
        const wantN = Array.isArray(live?.want) ? live.want.length : 0;
        if (pendingN + wantN === 0) beginHeaders(ahead);
      }
      releaseIdleCatchup();
    }, PENDING_WATCH_MS);
    if (typeof pendingWatch.unref === 'function') pendingWatch.unref();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        resolve({ host, port: server.address().port });
      });
    });
  }

  function connect(peerHost, peerPort) {
    if (!isRoutablePeerAddr(peerHost) && peerHost !== '127.0.0.1' && peerHost !== '::1') {
      return Promise.reject(new Error('bad_addr'));
    }
    return new Promise((resolve, reject) => {
      const sock = net.connect(peerPort, peerHost, () => {
        const remote = peerRemoteKey(sock);
        let local = String(sock.localAddress || '');
        if (local.startsWith('::ffff:')) local = local.slice(7);
        if (remote && remote === local && Number(sock.remotePort) === listenPortOf()) {
          try { sock.destroy(); } catch { /* ignore */ }
          resolve(null);
          return;
        }
        attach(sock, { dialHost: peerHost });
        resolve(sock);
      });
      sock.once('error', reject);
    });
  }

  function linkedTo(host, p) {
    const want = String(host || '');
    if (!want) return true;
    if (alreadyLinked(want, p)) return true;
    for (const rec of peers.values()) {
      if (rec.remote === want) return true;
      if (rec.dialHost && rec.dialHost === want) return true;
    }
    return false;
  }

  function ensurePeer(peerHost, peerPort) {
    const p = Number(peerPort) || P2P_PORT;
    if (linkedTo(peerHost, p)) return Promise.resolve(null);
    return connect(peerHost, p);
  }

  function dialSeeds(list) {
    const jobs = [];
    for (const seed of list || []) {
      let host = '';
      let port = P2P_PORT;
      if (typeof seed === 'string') {
        const s = seed.trim();
        if (!s) continue;
        const cut = s.lastIndexOf(':');
        host = cut > 0 ? s.slice(0, cut) : s;
        port = cut > 0 ? Number(s.slice(cut + 1)) : P2P_PORT;
      } else if (seed && seed.host) {
        host = String(seed.host);
        port = Number(seed.port) || P2P_PORT;
      } else continue;
      jobs.push(ensurePeer(host, port).catch(() => null));
    }
    return Promise.all(jobs);
  }

  function announce() {
    broadcast(tipMsg());
  }

  function close() {
    if (pendingWatch) {
      clearInterval(pendingWatch);
      pendingWatch = null;
    }
    if (censusTimer) {
      clearInterval(censusTimer);
      censusTimer = null;
    }
    announced.clear();
    if (tipNudgeTimer) {
      clearTimeout(tipNudgeTimer);
      tipNudgeTimer = null;
    }
    blockWaiters.clear();
    if (getblockServeTimer) {
      clearTimeout(getblockServeTimer);
      getblockServeTimer = null;
    }
    getblockServeQ.length = 0;
    for (const t of fluffTimers.values()) clearTimeout(t);
    fluffTimers.clear();
    for (const s of sockets) {
      try { s.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
    peers.clear();
    if (server) {
      server.close();
      server = null;
    }
  }

  function syncedOnline() {
    return countSyncedOnline({
      localHash: localTipHash(),
      peers: [...peers.values()],
      heard: heardNow(),
      includeSelf: true,
    });
  }

  function liveOnline() {
    return countLiveOnline({
      peers: [...peers.values()],
      includeSelf: true,
    });
  }

  function wrap(name) {
    if (typeof store[name] !== 'function') return;
    const orig = store[name].bind(store);
    store[name] = (...args) => {
      const got = orig(...args);
      if (got && typeof got.then === 'function') {
        return got.then((g) => {
          if (g?.ok) announce();
          return g;
        });
      }
      if (got?.ok) announce();
      return got;
    };
  }
  wrap('append');
  wrap('adopt');
  wrap('ingest');
  wrap('submitHeader');

  return {
    listen,
    connect,
    ensurePeer,
    dialSeeds,
    close,
    isRoutablePeerAddr,
    announce,
    publishWork,
    sockets,
    peers,
    syncedOnline,
    liveOnline,
    getblockServeBacklog: () => getblockServeQ.length,
    getblockServeSent: () => getblockServeSent,
    getblockServeMaxBacklog: () => getblockServeMaxBacklog,
    syncSnapshot: () => syncSnapshot(peers),
    originInvSetSize: (id) => Number(originInvSize.get(String(id || '')) || 0),
    get port() { return server?.address()?.port ?? port; },
    get listening() { return Boolean(server?.listening); },
  };
}
