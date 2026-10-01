/**
 * Localhost TCP between the pool process and the P2P sidecar.
 * Newline-delimited JSON on 127.0.0.1 only. Peer sockets stay on :30303.
 * `powHash` is the header digest the other process already verified.
 * This encoding has no `trustedPowHash` field.
 */
import net from 'node:net';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { admitWireTx } from '../../crypto/chronoflux.js';
import { txWeight } from '../../crypto/levy.js';
import { reviveBytes } from '../../crypto/note.js';
import { decodeWireBlock, encodeWireBlock, headerPrevHash } from './p2p.js';

export const P2P_IPC_HOST = '127.0.0.1';
export const P2P_IPC_PORT = 30313;
const IPC_MAX_FRAME = 8 * 1024 * 1024;
/**
 * Blocks forwarded per turn on hello / parent repair.
 * A wider gap is chunked. It is not a reason to send nothing.
 */
export const IPC_BACKFILL_MAX = 8;
const IPC_REPAIR_RETRY_MS = 2_000;

/** Public lattice fields only. Addresses, seeds, and proofs stay off this wire. */
export function networkMempoolWire(store, p2p) {
  const txs = [];
  for (const m of store?.mempool || []) {
    const id = String(m?.id || '');
    if (!id) continue;
    const vouts = Math.max(1, (m?.vout || []).length || (m?.to ? 1 : 0));
    const memo = m?.memoCt || m?.memoH ? 1 : 0;
    const bFlag = m?.kind === 'b-spend' || m?.bFlag ? 1 : 0;
    txs.push({
      id,
      kind: String(m.kind || 'send'),
      fee: Number(m.fee) || 0,
      weight: txWeight({ vouts, memoChunks: memo, bFlag }),
    });
    if (txs.length >= 4096) break;
  }
  const rounds = [];
  const work = typeof store?.openRoundRows === 'function' ? store.openRoundRows() : [];
  for (const r of work) {
    const tag = String(r?.tag || '').toLowerCase();
    if (!/^m[0-9a-f]{8}$/.test(tag)) continue;
    const count = Math.floor(Number(r.count) || 0);
    if (count < 1) continue;
    rounds.push({ tag, count, source: r.source === 'local' ? 'local' : 'peer' });
  }
  const synced = typeof p2p?.syncedOnline === 'function' ? Number(p2p.syncedOnline()) || 0 : 0;
  const peers = typeof p2p?.liveOnline === 'function' ? Number(p2p.liveOnline()) || 0 : 0;
  return { txs, rounds, synced, peers };
}

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

/**
 * Every block above `fromHeight`, oldest first.
 * `refused` is only when this store claims a taller tip and has no bodies to send.
 */
export function selectIpcBackfill(blocks, fromHeight, { localHeight, window = IPC_BACKFILL_MAX } = {}) {
  const from = Number(fromHeight) || 0;
  const list = (Array.isArray(blocks) ? blocks : [])
    .filter((b) => Number(b?.height || 0) > from)
    .sort((a, b) => Number(a.height) - Number(b.height));
  const tipFromBlocks = list.length ? Number(list[list.length - 1].height) : from;
  const local = Number.isFinite(Number(localHeight)) ? Number(localHeight) : tipFromBlocks;
  const gap = local > from ? local - from : 0;
  const cap = Math.max(1, Math.floor(Number(window) || IPC_BACKFILL_MAX));
  if (!(local > from)) {
    return { blocks: [], gap: 0, from, local, window: cap, refused: false, reason: '' };
  }
  if (!list.length) {
    return { blocks: [], gap, from, local, window: cap, refused: true, reason: 'missing_blocks' };
  }
  return { blocks: list, gap, from, local, window: cap, refused: false, reason: '' };
}

export function chunkIpcBlocks(blocks, window = IPC_BACKFILL_MAX) {
  const n = Math.max(1, Math.floor(Number(window) || IPC_BACKFILL_MAX));
  const chunks = [];
  const list = Array.isArray(blocks) ? blocks : [];
  for (let i = 0; i < list.length; i += n) chunks.push(list.slice(i, i + n));
  return chunks;
}

/** Ancestors ending at `hash`, at most `window` blocks, oldest first. */
export function ancestorWindow(blocks, hash, window = IPC_BACKFILL_MAX) {
  const want = String(hash || '').replace(/^0x/i, '').toLowerCase();
  if (!want) return [];
  const list = Array.isArray(blocks) ? blocks : [];
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (powHexOf(list[i]) === want) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return [];
  const n = Math.max(1, Math.floor(Number(window) || IPC_BACKFILL_MAX));
  const start = Math.max(0, idx - n + 1);
  return list.slice(start, idx + 1);
}

/**
 * `prev` / `unsigned` on IPC apply: ask for the parent before the child is retried.
 * Other reasons do not walk ancestors.
 */
export function ipcParentRepair(block, reason) {
  const r = String(reason || '');
  if (r !== 'prev' && r !== 'unsigned') return null;
  const parent = headerPrevHash(block?.header);
  const child = powHexOf(block);
  const ask = !!(parent && !/^0+$/.test(parent));
  return { reason: r, parent: parent || '', child, ask };
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
  const plan = selectIpcBackfill(store.blocks || [], afterHeight, {
    localHeight: local,
    window: IPC_BACKFILL_MAX,
  });
  if (plan.refused) {
    try {
      console.error(JSON.stringify({
        event: 'ipc_backfill_refuse',
        reason: plan.reason,
        from: plan.from,
        height: plan.local,
        gap: plan.gap,
      }));
    } catch { /* ignore */ }
    return;
  }
  if (!plan.blocks.length) return;
  const chunks = chunkIpcBlocks(plan.blocks, IPC_BACKFILL_MAX);
  if (plan.gap > IPC_BACKFILL_MAX) {
    try {
      console.error(JSON.stringify({
        event: 'ipc_backfill',
        from: plan.from,
        height: plan.local,
        gap: plan.gap,
        window: IPC_BACKFILL_MAX,
        chunks: chunks.length,
        refused: false,
      }));
    } catch { /* ignore */ }
  }
  let i = 0;
  const step = () => {
    const chunk = chunks[i];
    i += 1;
    if (!chunk) return;
    for (const block of chunk) forwardBlock(send, block);
    if (i < chunks.length) setImmediate(step);
  };
  setImmediate(step);
}

function serveIpcGetblock(store, send, msg) {
  const want = String(msg?.hash || '').replace(/^0x/i, '').toLowerCase();
  const window = ancestorWindow(store?.blocks || [], want, IPC_BACKFILL_MAX);
  const from = Number(msg?.height) || 0;
  let rows = window.filter((b) => Number(b?.height || 0) > from);
  if (!rows.length && window.length) rows = window.slice(-1);
  const child = String(msg?.child || '').replace(/^0x/i, '').toLowerCase();
  if (child && child !== want) {
    const extra = ancestorWindow(store?.blocks || [], child, 1);
    if (extra.length && !rows.some((b) => powHexOf(b) === child)) rows = rows.concat(extra);
  }
  if (!rows.length) {
    try {
      console.error(JSON.stringify({
        event: 'ipc_getblock',
        found: false,
        height: tipView(store).height,
        reason: 'missing',
      }));
    } catch { /* ignore */ }
    return;
  }
  for (const block of rows) forwardBlock(send, block);
  try {
    console.error(JSON.stringify({
      event: 'ipc_getblock',
      found: true,
      n: rows.length,
      height: tipView(store).height,
    }));
  } catch { /* ignore */ }
}

function makeParentRepair(store, send) {
  const asked = new Map();
  return (msg, got) => {
    const reason = String(got?.reason || 'fail');
    const repair = ipcParentRepair(msg?.block, reason);
    const height = Number(store.tip()?.height || 0);
    try {
      console.error(JSON.stringify({
        event: 'ipc_apply',
        ok: false,
        reason,
        height,
        blockHeight: Number(msg?.block?.height || 0),
        parent: repair?.parent || '',
      }));
    } catch { /* ignore */ }
    if (!repair?.ask) return;
    const now = Date.now();
    const prevAt = asked.get(repair.parent) || 0;
    if (now - prevAt < IPC_REPAIR_RETRY_MS) return;
    asked.set(repair.parent, now);
    if (asked.size > 64) {
      const oldest = asked.keys().next().value;
      asked.delete(oldest);
    }
    send({
      type: 'ipc_getblock',
      magic: MAGIC_TESTNET,
      hash: repair.parent,
      child: repair.child,
      height,
    });
  };
}

function reviveIpcTx(tx) {
  try {
    return JSON.parse(JSON.stringify(tx), reviveBytes);
  } catch {
    return tx;
  }
}

function sendMempool(store, send) {
  for (const m of store?.mempool || []) {
    const id = String(m?.id || '');
    if (!id) continue;
    let wire;
    try { wire = admitWireTx(m); } catch { continue; }
    send({ type: 'ipc_tx', magic: MAGIC_TESTNET, tx: wire });
  }
}

/** Admitted txs cross the pool/sidecar cut. Duplicate queueTx does not re-emit. */
function bindTxForward(store, send) {
  if (typeof store?.on !== 'function') return;
  store.on('tx', (tx) => {
    const id = String(tx?.id || '');
    if (!id) return;
    let wire;
    try { wire = admitWireTx(tx); } catch { return; }
    send({ type: 'ipc_tx', magic: MAGIC_TESTNET, tx: wire });
  });
}

function acceptIpcTx(store, msg) {
  if (!msg || msg.type !== 'ipc_tx' || !msg.tx || typeof msg.tx !== 'object') return;
  if (msg.magic && msg.magic !== MAGIC_TESTNET) return;
  if (typeof store?.queueTx !== 'function') return;
  try { store.queueTx(reviveIpcTx(msg.tx)); } catch { /* admit_fail stays on the store */ }
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

function enqueueApply(store, skip, onApplied, onFail) {
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
      if (!got?.ok) {
        if (typeof onFail === 'function') onFail(msg, got);
        else {
          try {
            console.error(JSON.stringify({
              event: 'ipc_apply',
              ok: false,
              reason: got?.reason || 'fail',
              height: Number(store.tip()?.height || 0),
              blockHeight: Number(msg?.block?.height || 0),
            }));
          } catch { /* ignore */ }
        }
      } else {
        try {
          console.error(JSON.stringify({
            event: 'ipc_apply',
            ok: true,
            height: Number(store.tip()?.height || 0),
          }));
        } catch { /* ignore */ }
      }
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
  onSidecarTip = null,
} = {}) {
  if (!loopbackHost(P2P_IPC_HOST)) throw new Error('ipc_bind');
  const skip = new Set();
  let client = null;
  const send = (obj) => writeJson(client, obj);
  bindTipForward(store, send, skip);
  bindTxForward(store, send);
  const repair = makeParentRepair(store, send);
  const enqueue = enqueueApply(store, skip, onApplied, repair);
  function noteRemoteTip(msg) {
    if (typeof onSidecarTip !== 'function') return;
    const height = Number(msg?.height);
    if (!Number.isFinite(height)) return;
    onSidecarTip({
      height,
      hash: msg?.hash,
      work: msg?.work,
      role: msg?.role || '',
    });
  }
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
        noteRemoteTip(msg);
        paceBackfill(store, send, msg.height);
        sendMempool(store, send);
        return;
      }
      if (msg.type === 'ipc_peers') {
        noteRemoteTip(msg);
        if (typeof onPeers === 'function') onPeers(Number(msg.peers) || 0, msg);
        return;
      }
      if (msg.type === 'ipc_getblock') {
        serveIpcGetblock(store, send, msg);
        return;
      }
      if (msg.type === 'ipc_tx') {
        acceptIpcTx(store, msg);
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
  bindTxForward(store, send);
  const repair = makeParentRepair(store, send);
  const enqueue = enqueueApply(store, skip, null, repair);

  function sendPeers() {
    const view = networkMempoolWire(store, p2p);
    const tip = tipView(store);
    send({
      type: 'ipc_peers',
      magic: MAGIC_TESTNET,
      peers: view.peers,
      synced: view.synced,
      txs: view.txs,
      rounds: view.rounds,
      height: tip.height,
      hash: tip.hash,
      work: tip.work,
    });
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
        sendMempool(store, send);
        return;
      }
      if (msg.type === 'ipc_getblock') {
        serveIpcGetblock(store, send, msg);
        return;
      }
      if (msg.type === 'ipc_work') {
        if (typeof p2p?.publishWork === 'function') p2p.publishWork(msg.rows || []);
        return;
      }
      if (msg.type === 'ipc_tx') {
        acceptIpcTx(store, msg);
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
