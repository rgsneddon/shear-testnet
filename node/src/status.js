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

/** Truthful one-shot view of a running or on-disk node. */
export function nodeStatus({ store, p2p, extra = {} } = {}) {
  const tip = typeof store?.tip === 'function' ? store.tip() : store?.tip || null;
  const live = typeof store?.fluxset === 'function' ? store.fluxset() : null;
  const height = Number(tip?.height || 0);
  const want = peerWant(p2p);
  const peers = typeof p2p?.liveOnline === 'function' ? Number(p2p.liveOnline()) || 0 : 0;
  const backend = hashBackendKind() || 'missing';
  return {
    event: 'status',
    height,
    hash: hex32(tip?.hash),
    jroot: live?.jroot ? hex32(live.jroot) : '',
    magic: MAGIC_TESTNET,
    peers,
    want,
    ibd: want > 0,
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
