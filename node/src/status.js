import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { hashBackendKind } from '../../crypto/shear_hash.js';

function hex32(h) {
  if (!h) return '';
  try {
    return Buffer.from(h).toString('hex');
  } catch {
    return String(h);
  }
}

function peerWant(p2p) {
  let want = 0;
  const peers = p2p?.peers;
  if (!peers || typeof peers.values !== 'function') return 0;
  for (const rec of peers.values()) {
    want += Array.isArray(rec?.want) ? rec.want.length : 0;
    want += rec?.pending instanceof Set ? rec.pending.size : 0;
    want += Array.isArray(rec?.retryPrev) ? rec.retryPrev.length : 0;
  }
  return want;
}

function recBusy(rec) {
  if (rec?.syncing) return true;
  if (Array.isArray(rec?.want) && rec.want.length) return true;
  if (rec?.pending instanceof Set && rec.pending.size) return true;
  if (Array.isArray(rec?.retryPrev) && rec.retryPrev.length) return true;
  return false;
}

/**
 * Tallest advertised peer tip. Null height means no peer has said.
 * A mesh that is all behind this node reports that height — it does not look caught-up to a hidden tip.
 */
function advertisedHeight(rec) {
  const g = Number(rec?.gossipHeight);
  if (Number.isFinite(g)) return g;
  const h = Number(rec?.height);
  return Number.isFinite(h) ? h : NaN;
}

export function bestPeerTip(peers) {
  let bestH = null;
  let bestHash = '';
  let syncH = null;
  let eligible = 0;
  if (!peers || typeof peers.values !== 'function') {
    return { peerMaxHeight: null, peerHash: '', syncPeerHeight: null, syncEligiblePeers: 0 };
  }
  for (const rec of peers.values()) {
    const h = advertisedHeight(rec);
    const hash = String(rec?.gossipHash || rec?.hash || '').replace(/^0x/i, '').toLowerCase();
    if (Number.isFinite(h) && (bestH == null || h > bestH || (h === bestH && hash && (!bestHash || hash < bestHash)))) {
      bestH = h;
      bestHash = hash;
    }
    const demoted = Number(rec?.demoteUntil) > Date.now();
    if (rec?.syncEligible === true && !demoted) {
      eligible += 1;
      const sh = Number(rec?.height);
      if (Number.isFinite(sh) && (syncH == null || sh > syncH)) syncH = sh;
    }
  }
  return {
    peerMaxHeight: bestH,
    peerHash: bestHash,
    syncPeerHeight: syncH,
    syncEligiblePeers: eligible,
  };
}

/**
 * IBD stays true until this tip has caught every live peer and queues are idle.
 * Empty-tip height=0 with no advertised peer ahead remains false.
 */
export function isInitialBlockDownload({ height = 0, peers } = {}) {
  const local = Number(height) || 0;
  if (!peers || typeof peers.values !== 'function') return false;
  for (const rec of peers.values()) {
    if (recBusy(rec)) return true;
    const peerH = Number(rec?.gossipHeight);
    const provenH = Number(rec?.height);
    const advertised = Number.isFinite(peerH) ? peerH : provenH;
    if (Number.isFinite(advertised) && advertised > local) return true;
  }
  return false;
}

/** Truthful one-shot view of a running or on-disk node. */
export function nodeStatus({ store, p2p, extra = {} } = {}) {
  const tip = typeof store?.tip === 'function' ? store.tip() : store?.tip || null;
  const live = typeof store?.fluxset === 'function' ? store.fluxset() : null;
  const height = Number(tip?.height || 0);
  const want = peerWant(p2p);
  const peers = typeof p2p?.liveOnline === 'function' ? Number(p2p.liveOnline()) || 0 : 0;
  const backend = hashBackendKind() || 'missing';
  const best = bestPeerTip(p2p?.peers);
  return {
    event: 'status',
    height,
    hash: hex32(tip?.hash),
    jroot: live?.jroot ? hex32(live.jroot) : '',
    magic: MAGIC_TESTNET,
    peers,
    want,
    ibd: isInitialBlockDownload({ height, peers: p2p?.peers }),
    peerMaxHeight: best.peerMaxHeight,
    peerHash: best.peerHash,
    syncPeerHeight: best.syncPeerHeight,
    syncEligiblePeers: best.syncEligiblePeers,
    hashBackend: backend,
    ...extra,
  };
}

export function printNodeStatus(args) {
  const row = nodeStatus(args);
  console.log(JSON.stringify(row));
  const hash = row.hash ? row.hash.slice(0, 16) : '-';
  const line = [
    `height=${row.height}`,
    `hash=${hash}`,
    `peers=${row.peers}`,
    `want=${row.want}`,
    `ibd=${row.ibd}`,
    `peerMaxHeight=${row.peerMaxHeight == null ? '-' : row.peerMaxHeight}`,
    `syncPeerHeight=${row.syncPeerHeight == null ? '-' : row.syncPeerHeight}`,
    `peerHash=${row.peerHash ? String(row.peerHash).slice(0, 16) : '-'}`,
    `hashBackend=${row.hashBackend}`,
  ];
  if (row.stratum != null) line.push(`stratum=${row.stratum}`);
  if (row.miners != null) line.push(`miners=${row.miners}`);
  console.error(`status ${line.join(' ')}`);
  return row;
}

export function watchNodeStatus({ store, p2p, extra, everyMs = 15_000 } = {}) {
  const tick = () => printNodeStatus({ store, p2p, extra: typeof extra === 'function' ? extra() : extra });
  tick();
  if (store && typeof store.on === 'function') {
    store.on('tip', () => tick());
  }
  const t = setInterval(tick, everyMs);
  if (typeof t.unref === 'function') t.unref();
  return () => clearInterval(t);
}
