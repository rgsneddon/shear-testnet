/**
 * Localhost TCP between the pool process and the P2P sidecar.
 * Newline-delimited JSON on 127.0.0.1 only. Peer sockets stay on :30303.
 * `powHash` is the header digest the other process already verified.
 * This encoding has no `trustedPowHash` field.
 */
import net from 'node:net';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { decodeWireBlock, encodeWireBlock } from './p2p.js';

export const P2P_IPC_HOST = '127.0.0.1';
export const P2P_IPC_PORT = 30313;
const IPC_MAX_FRAME = 8 * 1024 * 1024;
const IPC_BACKFILL_MAX = 8;

export function parseIpcAddr(raw, fallbackPort = P2P_IPC_PORT) {
  const s = String(raw || '').trim();
  if (!s) return { host: P2P_IPC_HOST, port: fallbackPort };
  const cut = s.lastIndexOf(':');
  if (cut < 0) return { host: P2P_IPC_HOST, port: Number(s) || fallbackPort };
  const host = s.slice(0, cut) || P2P_IPC_HOST;
  const port = Number(s.slice(cut + 1));
  return { host, port: Number.isFinite(port) ? port : fallbackPort };
}

function loopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function loopbackSock(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function powHexOf(block) {
  const h = block?.hash;
  if (h == null) return '';
  if (Buffer.isBuffer(h) || h instanceof Uint8Array) return Buffer.from(h).toString('hex');
  return String(h).replace(/^0x/i, '').toLowerCase();
}

function tipView(store) {
  const t = typeof store?.tip === 'function' ? store.tip() : null;
  let work = '0x0';
  try {
    if (typeof store?.chainWorkHex === 'function') work = store.chainWorkHex() || '0x0';
  } catch { /* keep 0 */ }
  return {
    height: Number(t?.height || 0),
    hash: powHexOf(t),
    work: work || '0x0',
  };
}

function helloMsg(role, store) {
  const tip = tipView(store);
  return { type: 'ipc_hello', role, magic: MAGIC_TESTNET, ...tip };
}

function writeJson(sock, obj) {
  if (!sock || sock.destroyed || sock.writable === false) return false;
  try {
    sock.write(`${JSON.stringify(obj)}\n`);
    return true;
  } catch {
    return false;
  }
}

function stripTrustField(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  if (Object.prototype.hasOwnProperty.call(msg, 'trustedPowHash')) delete msg.trustedPowHash;
  if (msg.block && typeof msg.block === 'object' && Object.prototype.hasOwnProperty.call(msg.block, 'trustedPowHash')) {
    delete msg.block.trustedPowHash;
  }
  return msg;
}

/** Apply one sidecar-verified block. Does not call ShearHash. */
export function applyVerifiedIpcBlock(store, msg) {
  stripTrustField(msg);
  if (!msg || msg.type !== 'ipc_block' || !msg.block || typeof msg.block !== 'object') {
    return { ok: false, reason: 'ipc_block' };
  }
  if (msg.magic && msg.magic !== MAGIC_TESTNET) return { ok: false, reason: 'magic' };
  const powHex = String(msg.powHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(powHex)) return { ok: false, reason: 'pow' };
  let block;
  try {
    block = decodeWireBlock(msg.block);
  } catch {
    return { ok: false, reason: 'decode' };
  }
  if (block && Object.prototype.hasOwnProperty.call(block, 'trustedPowHash')) delete block.trustedPowHash;
  return store.append(block, {
    trustedPowHash: Buffer.from(powHex, 'hex'),
    skipSharePow: true,
  });
}

function forwardBlock(send, block) {
  const powHash = powHexOf(block);
  if (!/^[0-9a-f]{64}$/.test(powHash)) return false;
  let wire;
  try {
    wire = encodeWireBlock(block);
  } catch {
    return false;
  }
  return send({ type: 'ipc_block', magic: MAGIC_TESTNET, block: wire, powHash });
}

function paceBackfill(store, send, afterHeight) {
  const local = tipView(store).height;
  const from = Number(afterHeight) || 0;
  if (local <= from || local - from > IPC_BACKFILL_MAX) return;
  const blocks = (store.blocks || []).filter((b) => Number(b?.height || 0) > from);
  let i = 0;
  const step = () => {
    if (i >= blocks.length) return;
    forwardBlock(send, blocks[i]);
    i += 1;
    setImmediate(step);
  };
  setImmediate(step);
}

function bindTipForward(store, send, skip) {
  if (typeof store?.on !== 'function') return () => {};
  return store.on('tip', (info) => {
    const hash = String(info?.hash || '').toLowerCase();
    if (hash && skip.has(hash)) {
      skip.delete(hash);
      return;
    }
    const blocks = store.blocks || [];
    const tip = blocks[blocks.length - 1];
    if (tip) forwardBlock(send, tip);
  });
}

function attachLines(sock, onMsg) {
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (buf.length > IPC_MAX_FRAME) {
      try { sock.destroy(); } catch { /* ignore */ }
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      onMsg(stripTrustField(msg));
    }
  });
}

function enqueueApply(store, skip, onApplied) {
  let tail = Promise.resolve();
  return (msg) => {
    const job = tail.then(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const powHex = String(msg?.powHash || '').trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(powHex)) skip.add(powHex);
      let got;
      try {
        got = await Promise.resolve(applyVerifiedIpcBlock(store, msg));
      } catch (err) {
        got = { ok: false, reason: String(err?.message || err).slice(0, 80) };
      }
      if (!got?.ok && powHex) skip.delete(powHex);
      try {
        console.error(JSON.stringify({
          event: 'ipc_apply',
          ok: !!got?.ok,
          reason: got?.ok ? undefined : (got?.reason || 'fail'),
          height: Number(store.tip()?.height || 0),
        }));
      } catch { /* ignore */ }
      if (typeof onApplied === 'function') {
        try { onApplied(got); } catch { /* ignore */ }
      }
      return got;
    });
    tail = job.then(() => {}, () => {});
    return job;
  };
}

/**
 * Pool side. Listens on loopback and applies blocks the sidecar already verified.
 * Never opens :30303.
 */
export function attachPoolIpc({
  store,
  port = P2P_IPC_PORT,
  onPeers = null,
  onApplied = null,
} = {}) {
  if (!loopbackHost(P2P_IPC_HOST)) throw new Error('ipc_bind');
  const skip = new Set();
  let client = null;
  const send = (obj) => writeJson(client, obj);
  bindTipForward(store, send, skip);
  const enqueue = enqueueApply(store, skip, onApplied);
  const server = net.createServer((sock) => {
    if (!loopbackSock(sock.remoteAddress)) {
      try { sock.destroy(); } catch { /* ignore */ }
      return;
    }
    try { sock.setNoDelay(true); } catch { /* ignore */ }
    if (client && client !== sock) {
      try { client.destroy(); } catch { /* ignore */ }
    }
    client = sock;
    try {
      console.error(JSON.stringify({ event: 'ipc_up', role: 'pool' }));
    } catch { /* ignore */ }
    writeJson(sock, helloMsg('pool', store));
    attachLines(sock, (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ipc_hello') {
        paceBackfill(store, send, msg.height);
        return;
      }
      if (msg.type === 'ipc_peers') {
        if (typeof onPeers === 'function') onPeers(Number(msg.peers) || 0);
        return;
      }
      if (msg.type === 'ipc_block') enqueue(msg);
    });
    sock.on('close', () => {
      if (client === sock) client = null;
    });
    sock.on('error', () => {
      if (client === sock) client = null;
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, P2P_IPC_HOST, () => {
      const bound = server.address();
      resolve({
        host: P2P_IPC_HOST,
        port: bound && typeof bound === 'object' ? bound.port : port,
        send,
        close() {
          try { client?.destroy(); } catch { /* ignore */ }
          try { server.close(); } catch { /* ignore */ }
          client = null;
        },
      });
    });
  });
}

/** Sidecar side. Dials the pool and pushes blocks this process has fully verified. */
export function attachSidecarIpc({ store, p2p, addr } = {}) {
  const parsed = parseIpcAddr(addr);
  if (!loopbackHost(parsed.host)) {
    throw new Error('ipc_not_loopback');
  }
  const skip = new Set();
  let sock = null;
  let closed = false;
  let retry = null;
  let peerTimer = null;
  const send = (obj) => writeJson(sock, obj);
  bindTipForward(store, send, skip);
  const enqueue = enqueueApply(store, skip, null);

  function sendPeers() {
    const n = typeof p2p?.liveOnline === 'function' ? Number(p2p.liveOnline()) || 0 : 0;
    send({ type: 'ipc_peers', magic: MAGIC_TESTNET, peers: n });
  }

  const dropped = new Set();

  function bind(next) {
    if (sock && sock !== next) {
      dropped.add(sock);
      try { sock.destroy(); } catch { /* ignore */ }
    }
    sock = next;
    try { sock.setNoDelay(true); } catch { /* ignore */ }
    try {
      console.error(JSON.stringify({ event: 'ipc_up', role: 'sidecar', port: parsed.port }));
    } catch { /* ignore */ }
    writeJson(sock, helloMsg('sidecar', store));
    sendPeers();
    if (peerTimer) clearInterval(peerTimer);
    peerTimer = setInterval(sendPeers, 2000);
    if (typeof peerTimer.unref === 'function') peerTimer.unref();
    attachLines(sock, (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ipc_hello') {
        paceBackfill(store, send, msg.height);
        return;
      }
      if (msg.type === 'ipc_work') {
        if (typeof p2p?.publishWork === 'function') p2p.publishWork(msg.rows || []);
        return;
      }
      if (msg.type === 'ipc_block') enqueue(msg);
    });
  }

  function scheduleDial() {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = null;
      dial();
    }, 500);
    if (typeof retry.unref === 'function') retry.unref();
  }

  function dial() {
    if (closed) return;
    const next = net.connect(parsed.port, parsed.host);
    next.once('connect', () => {
      if (closed) {
        try { next.destroy(); } catch { /* ignore */ }
        return;
      }
      bind(next);
    });
    next.on('error', () => {});
    next.on('close', () => {
      if (dropped.has(next)) {
        dropped.delete(next);
        return;
      }
      if (sock === next) sock = null;
      if (peerTimer) {
        clearInterval(peerTimer);
        peerTimer = null;
      }
      scheduleDial();
    });
  }

  dial();
  return {
    send,
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      if (peerTimer) clearInterval(peerTimer);
      try { sock?.destroy(); } catch { /* ignore */ }
      sock = null;
    },
  };
}
