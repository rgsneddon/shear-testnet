import net from 'node:net';
import { MAGIC_TESTNET, PRODUCT_VERSION } from '../../crypto/asert.js';

export const P2P_PORT = 30303;
export const P2P_UA = `shear-node/${PRODUCT_VERSION}`;

export function encodeWireBlock(b) {
  return {
    header: Buffer.from(b.header).toString('hex'),
    hash: Buffer.from(b.hash).toString('hex'),
    height: b.height,
    txs: b.txs,
    samples: b.samples,
    miner: b.miner,
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
} = {}) {
  const sockets = new Set();
  const peers = new Map();
  const linking = new Set();
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
      return;
    }
    if (msg.type === 'addr') {
      for (const p of msg.peers || []) {
        const host = String(p.host || '').trim();
        const portN = Number(p.port);
        if (!host || !Number.isFinite(portN) || portN <= 0) continue;
        if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') continue;
        const key = `${host}:${portN}`;
        if (linking.has(key) || alreadyLinked(host, portN)) continue;
        linking.add(key);
        connect(host, portN).catch(() => {}).finally(() => linking.delete(key));
      }
      return;
    }
    if (msg.type === 'tip' || msg.type === 'inv') {
      notePeerTip(sock, msg);
      const localHash = localTipHash();
      if (msg.hash && msg.hash !== localHash) {
        send(sock, { type: 'getblocks', magic });
      }
      return;
    }
    if (msg.type === 'getblocks') {
      send(sock, {
        type: 'blocks',
        magic,
        blocks: store.blocks.map(encodeWireBlock),
      });
      return;
    }
    if (msg.type === 'blocks') {
      const list = msg.blocks || [];
      const last = list[list.length - 1];
      if (last) notePeerTip(sock, { hash: last.hash, height: last.height });
      const fork = list.map(decodeWireBlock);
      const before = store.tip();
      Promise.resolve(store.ingest(fork)).then((got) => {
        const after = store.tip();
        const changed = (before && after)
          ? !Buffer.from(before.hash).equals(Buffer.from(after.hash))
          : Boolean(after && !before);
        if (got?.ok && changed) broadcast(tipMsg(), sock);
      }).catch(() => {});
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
    return new Promise((resolve, reject) => {
      const sock = net.connect(peerPort, peerHost, () => {
        attach(sock);
        resolve(sock);
      });
      sock.once('error', reject);
    });
  }

  function announce() {
    broadcast(tipMsg());
  }

  function close() {
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
    close,
    announce,
    sockets,
    peers,
    syncedOnline,
    get port() { return server?.address()?.port ?? port; },
    get listening() { return Boolean(server?.listening); },
  };
}
