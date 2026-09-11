import net from 'node:net';
import { MAGIC_TESTNET, PRODUCT_VERSION } from '../../crypto/asert.js';
import { shareRowJson } from '../../crypto/pack.js';
import { compactTx } from '../../crypto/chronoflux.js';

export const P2P_PORT = 30303;
export const P2P_MAX_FRAME = 1024 * 1024;
/** Headers served after a locator. A window, not the end of IBD. */
export const HEADERS_PAGE = 2000;
/** In-flight getblock window. Sync must continue after this many. */
export const GETBLOCK_BATCH = 16;
/** Seed redial so a dropped peer cannot leave a node stuck forever. */
export const SEED_RETRY_MS = 15_000;

function hexHash(h) {
  if (Buffer.isBuffer(h)) return h.toString('hex');
  return String(h || '');
}

function hexHeader(h) {
  if (Buffer.isBuffer(h)) return h.toString('hex');
  return String(h || '');
}

export function headerIndexByHash(blocks, hash) {
  const want = String(hash || '');
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
    ? locator.map((x) => String(x || '')).filter(Boolean)
    : [];
  const stop = String(stopHash || '');
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
    shareBatch: Array.isArray(b.shareBatch) ? b.shareBatch.map(shareRowJson) : [],
    aLeaves: b.aLeaves,
    bLeaves: b.bLeaves,
    rootA: b.rootA,
    rootB: b.rootB,
  };
}

export function decodeWireBlock(w) {
  return {
    header: Buffer.from(w.header, 'hex'),
    hash: w.hash ? Buffer.from(w.hash, 'hex') : undefined,
    height: w.height,
    txs: w.txs,
    samples: w.samples,
    miner: w.miner,
    shareBatch: Array.isArray(w.shareBatch) ? w.shareBatch : [],
    aLeaves: w.aLeaves,
    bLeaves: w.bLeaves,
    rootA: w.rootA,
    rootB: w.rootB,
  };
}

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/** Unique remote of a live socket. IPv4-mapped IPv6 collapses to IPv4. */
export function peerRemoteKey(sock) {
  let a = String(sock?.remoteAddress || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a;
}

/**
 * Currently-online fully-synced nodes the network can see: this process
 * (includeSelf) plus every unique live remote that has announced the local
 * tip hash. Disconnected peers are not in `peers`, so historical uniques
 * do not accumulate.
 */
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

export function countSyncedOnline({ localHash = '', peers = [], includeSelf = true } = {}) {
  const want = String(localHash || '');
  const seen = new Set();
  for (const rec of peers) {
    if (rec == null || rec.hash == null) continue;
    if (String(rec.hash) !== want) continue;
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
} = {}) {
  const sockets = new Set();
  const peers = new Map();
  const linking = new Set();
  const seenTx = new Set();
  const originInvSize = new Map();
  const fluffTimers = new Map();
  let server = null;
  let peerSeq = 0;

  function listenPortOf() {
    return server?.address()?.port ?? port;
  }

  function advertisedPeers(exceptSock) {
    const out = [];
    const seen = new Set();
    for (const [s, rec] of peers) {
      if (s === exceptSock) continue;
      const host = rec.remote;
      const p = Number(rec.listenPort) || 0;
      if (!host || !p) continue;
      if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') continue;
      const key = `${host}:${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ host, port: p });
    }
    return out;
  }

  function alreadyLinked(host, p) {
    if (p === listenPortOf() && (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0')) return true;
    for (const rec of peers.values()) {
      if (rec.remote === host && Number(rec.listenPort) === p) return true;
    }
    return false;
  }

  function localTipHash() {
    const t = store.tip();
    return t ? Buffer.from(t.hash).toString('hex') : '';
  }

  function tipMsg() {
    const t = store.tip();
    return {
      type: 'tip',
      magic,
      height: t?.height || 0,
      hash: t ? Buffer.from(t.hash).toString('hex') : '',
    };
  }

  function notePeerTip(sock, msg) {
    const rec = peers.get(sock) || { id: ++peerSeq, remote: peerRemoteKey(sock), hash: null, height: 0 };
    rec.remote = peerRemoteKey(sock) || rec.remote;
    if (msg && msg.hash != null) rec.hash = String(msg.hash);
    if (msg && Number.isFinite(Number(msg.height))) rec.height = Number(msg.height);
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

  function scheduleFluff(id, tx, except) {
    const key = String(id || '');
    if (!key || fluffTimers.has(key)) return;
    const t = setTimeout(() => {
      fluffTimers.delete(key);
      broadcast({ type: 'tx', magic, tx, stem: false }, except);
    }, delayFluff());
    fluffTimers.set(key, t);
  }

  function stemRelay(tx, fromSock, hops) {
    const nextHop = (Number(hops) || 0) + 1;
    const next = pickStemSocket(sockets, fromSock, stemRng);
    if (next) send(next, { type: 'tx', magic, tx, stem: true, hops: nextHop });
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
    const payload = got.tx || tx;
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
      const n = stemRelay(tx, null, 0);
      originInvSize.set(id, n);
      scheduleFluff(id, tx, null);
    });
  }

  function publishWork(rows = []) {
    const list = Array.isArray(rows) ? rows.filter((r) => r && r.tag && Number(r.count) > 0) : [];
    if (typeof store.noteOpenRound === 'function') store.noteOpenRound(list, { source: 'local' });
    if (list.length) broadcast({ type: 'work', magic, rows: list });
  }

  function locators() {
    return locatorHashes(store.blocks || []);
  }

  function requestHeaders(sock) {
    const rec = peers.get(sock);
    if (!rec) return;
    if (rec.syncing) return;
    const local = localTipHash();
    const peerHash = String(rec.hash || '');
    if (!peerHash || peerHash === local) return;
    rec.syncing = true;
    send(sock, {
      type: 'getheaders',
      magic,
      locator: locators(),
      stopHash: peerHash,
    });
  }

  function finishBatch(sock) {
    const rec = peers.get(sock);
    if (!rec) return;
    rec.syncing = false;
    rec.pending = null;
    requestHeaders(sock);
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
        txs: Array.isArray(store.mempool) ? store.mempool.slice(0, 4096) : [],
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
      if (typeof store.noteOpenRound === 'function') {
        store.noteOpenRound(msg.rows || [], { source: 'peer' });
      }
      return;
    }
    if (msg.type === 'addr') {
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
    if (msg.type === 'tip' || msg.type === 'inv') {
      notePeerTip(sock, msg);
      requestHeaders(sock);
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
      peers.set(sock, rec);
      const have = new Set((store.blocks || []).map((b) => hexHash(b.hash)));
      const missing = [];
      for (const h of msg.headers || []) {
        const hash = String(h.hash || '');
        if (!hash || have.has(hash) || rec.failed.has(hash)) continue;
        missing.push(hash);
        if (missing.length >= GETBLOCK_BATCH) break;
      }
      if (!missing.length) {
        rec.syncing = false;
        rec.pending = null;
        const lastHdr = (msg.headers || [])[(msg.headers || []).length - 1];
        const lastHash = lastHdr ? String(lastHdr.hash || '') : '';
        if ((msg.headers || []).length >= HEADERS_PAGE && lastHash && have.has(lastHash)) {
          requestHeaders(sock);
        }
        return;
      }
      rec.pending = new Set(missing);
      rec.syncing = true;
      try {
        console.error(JSON.stringify({
          event: 'p2p_headers',
          n: (msg.headers || []).length,
          missing: missing.length,
          local: store.tip()?.height || 0,
        }));
      } catch { /* ignore */ }
      for (const hash of missing) send(sock, { type: 'getblock', magic, hash });
      return;
    }
    if (msg.type === 'getblock') {
      const want = String(msg.hash || '');
      const b = (store.blocks || []).find((x) => hexHash(x.hash) === want);
      if (b) send(sock, { type: 'block', magic, block: encodeWireBlock(b) });
      return;
    }
    if (msg.type === 'block' || msg.type === 'blocks') {
      const list = msg.block ? [msg.block] : (msg.blocks || []);
      if (list.length > 1 && msg.type === 'blocks') return;
      const last = list[list.length - 1];
      const fork = list.map(decodeWireBlock);
      const before = store.tip();
      Promise.resolve(store.ingest(fork)).then((got) => {
        const rec = peers.get(sock);
        const lastHash = last ? String(last.hash || '') : '';
        if (rec) {
          if (!rec.failed) rec.failed = new Set();
          if (rec.pending && lastHash) rec.pending.delete(lastHash);
          if (!got?.ok && lastHash) {
            rec.failed.add(lastHash);
            try {
              console.error(JSON.stringify({
                event: 'p2p_ingest',
                ok: false,
                reason: got?.reason || 'fail',
                height: last?.height,
              }));
            } catch { /* ignore */ }
          }
        }
        const after = store.tip();
        const changed = (before && after)
          ? !Buffer.from(before.hash).equals(Buffer.from(after.hash))
          : Boolean(after && !before);
        if (got?.ok && changed) broadcast(tipMsg(), sock);
        if (rec?.pending && rec.pending.size === 0) {
          finishBatch(sock);
        } else if (!rec?.pending) {
          if (rec) rec.syncing = false;
          requestHeaders(sock);
        }
      }).catch(() => {
        const rec = peers.get(sock);
        if (rec) {
          rec.syncing = false;
          rec.pending = null;
        }
      });
    }
  }

  function drop(sock) {
    sockets.delete(sock);
    peers.delete(sock);
  }

  function attach(sock) {
    sockets.add(sock);
    peers.set(sock, { id: ++peerSeq, remote: peerRemoteKey(sock), hash: null, height: 0 });
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
    send(sock, { type: 'hello', magic, ua: P2P_UA, port: listenPortOf() });
    send(sock, tipMsg());
  }

  function listen() {
    server = net.createServer(attach);
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
        attach(sock);
        resolve(sock);
      });
      sock.once('error', reject);
    });
  }

  function linkedTo(host, p) {
    if (alreadyLinked(host, p)) return true;
    for (const rec of peers.values()) {
      if (rec.remote === host) return true;
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
    originInvSetSize: (id) => Number(originInvSize.get(String(id || '')) || 0),
    get port() { return server?.address()?.port ?? port; },
    get listening() { return Boolean(server?.listening); },
  };
}
