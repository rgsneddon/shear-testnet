/**
 * Localhost TCP between the pool process and the P2P sidecar.
 * Newline-delimited JSON on 127.0.0.1 only. Peer sockets stay on :30303.
 * `powHash` is the header digest the other process already verified.
 * This encoding has no `trustedPowHash` field.
 */
import net from 'node:net';
import {
  BITS_FP_SCALE,
  LIVE_MIN_BITS,
  MAGIC_TESTNET,
  MAX_BITS,
  SAMPLE_PRUNE_CONFIRMATIONS,
  isPackedBits,
} from '../../crypto/asert.js';
import { admitWireTx } from '../../crypto/chronoflux.js';
import { decodeHeader } from '../../crypto/header.js';
import { txWeight } from '../../crypto/levy.js';
import { heldBodyKey } from '../../crypto/mempool.js';
import { reviveBytes } from '../../crypto/note.js';
import { meetsTarget, shearHash, isZeroDigest } from '../../crypto/shear_hash.js';
import { decodeWireBlock, encodeWireBlock, headerPrevHash } from './p2p.js';
import { parseBoundedJson } from '../../crypto/json_bounds.js';
import { classifyByPhase, deliverProcessFault, staysUpOnFault } from './process_guard.js';

export const P2P_IPC_HOST = '127.0.0.1';
export const P2P_IPC_PORT = 30313;
export const IPC_MAX_FRAME = 8 * 1024 * 1024;
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
      // The body key (a hash of the public body): the pool matches rows by it,
      // not by the id a sender picks.
      key: heldBodyKey(m),
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

/**
 * `samples_pruned` on IPC apply: ask for the header run, then retry the body.
 * A peer height is not part of this ask. Other reasons do not fetch headers.
 */
export function ipcBurialRepair(block, reason) {
  if (String(reason || '') !== 'samples_pruned') return null;
  const child = powHexOf(block);
  const height = Math.floor(Number(block?.height) || 0);
  const from = height > 0 ? height : 1;
  const to = from + SAMPLE_PRUNE_CONFIRMATIONS;
  return { reason: 'samples_pruned', child, from, to, ask: !!child };
}

function hex32(value) {
  try {
    const buf = Buffer.from(value);
    if (buf.length === 32) return buf.toString('hex').toLowerCase();
  } catch { /* not a hash */ }
  return '';
}

function prevHexOfHeader(header) {
  try {
    return hex32(decodeHeader(Buffer.from(header)).prevBlockHash);
  } catch {
    return '';
  }
}

function genesisParent(prevHex) {
  return !prevHex || /^0+$/.test(prevHex);
}

/** Main chain, the staged side chain, or the genesis anchor. */
function parentKnown(store, prevHex) {
  if (genesisParent(prevHex)) return true;
  const want = String(prevHex || '').toLowerCase();
  const blocks = store?.blocks || [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (hex32(blocks[i]?.hash) === want) return true;
  }
  try {
    if (typeof store?.sideTipHash === 'function' && String(store.sideTipHash() || '').toLowerCase() === want) {
      return true;
    }
  } catch { /* no side tip */ }
  try {
    const side = typeof store?.sideHashes === 'function' ? store.sideHashes() : [];
    if ((side || []).some((h) => String(h || '').toLowerCase() === want)) return true;
  } catch { /* no side chain */ }
  return false;
}

/**
 * Packed Q16.16 only, and the raw quotient must sit in [LIVE_MIN_BITS, MAX_BITS].
 * unpackBits clamps, so it cannot be this floor. Integer bits and bits 0
 * meet a digest without being live work, and must not open a parent repair.
 */
function declaredBitsAdmit(bits) {
  const n = Number(bits);
  if (!isPackedBits(n)) return false;
  const fp = n / BITS_FP_SCALE;
  return fp >= LIVE_MIN_BITS && fp <= MAX_BITS;
}

/** Header work against the bits the child declares. Not the ASERT check. */
function childMeetsTarget(block) {
  try {
    const header = Buffer.from(block.header);
    const decoded = decodeHeader(header);
    if (!declaredBitsAdmit(decoded.bits)) return false;
    const hash = shearHash(header);
    if (hash.length !== 32 || isZeroDigest(hash)) return false;
    return meetsTarget(hash, decoded.bits);
  } catch {
    return false;
  }
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

/**
 * Apply one IPC block by hashing the header in append.
 * powHash is a 32-byte field check only. It is not ShearHash(header).
 */
export function applyVerifiedIpcBlock(store, msg) {
  stripTrustField(msg);
  if (!msg || msg.type !== 'ipc_block' || !msg.block || typeof msg.block !== 'object') {
    return { ok: false, reason: 'ipc_block' };
  }
  if (msg.magic !== MAGIC_TESTNET) return { ok: false, reason: 'magic' };
  const powHex = String(msg.powHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(powHex)) return { ok: false, reason: 'pow' };
  void powHex;
  let block;
  try {
    block = decodeWireBlock(msg.block);
  } catch {
    return { ok: false, reason: 'decode' };
  }
  if (block && Object.prototype.hasOwnProperty.call(block, 'trustedPowHash')) delete block.trustedPowHash;
  let tipH = 0;
  let tipHash = '';
  try {
    const t = store.tip();
    tipH = Number(t?.height || 0);
    if (t?.hash) tipHash = hex32(t.hash);
  } catch { tipH = 0; }
  const prevHex = prevHexOfHeader(block.header);
  // A genesis child links only an empty book. Any other child links the tip.
  const links = genesisParent(prevHex) ? tipHash === '' : prevHex === tipHash;
  // The next block is this tip plus one. A peer height field is not burial.
  // A fork block is judged against its own parent inside append, not against
  // this tip, so a lied height is refused here only when the block links.
  if (links) {
    const structuralH = tipH + 1;
    if (block.height != null && block.height !== '' && Number(block.height) !== structuralH) {
      return { ok: false, reason: 'height' };
    }
  }
  // Repair walks ancestors only when the parent is not in this store.
  // A child that misses its own target gets no repair. append verifies
  // against the tip only, so a known parent that does not link is ingested
  // and stageOrAdopt keeps or adopts the fork.
  if (!links && !parentKnown(store, prevHex)) {
    if (!childMeetsTarget(block)) return { ok: false, reason: 'pow' };
    return { ok: false, reason: 'prev' };
  }
  const verifyOpts = block.samplesPruned === true ? { offLoopPow: true } : {};
  if (!links && typeof store.ingest === 'function') {
    return store.ingest([block], verifyOpts);
  }
  // A pruned block is buried only by the proven header run the store holds
  // from ipc_headers. The store hashes those headers off the loop. No run,
  // or a short one, is samples_pruned there.
  return store.append(block, verifyOpts);
}

function blockFrame(block) {
  const powHash = powHexOf(block);
  if (!/^[0-9a-f]{64}$/.test(powHash)) return null;
  let wire;
  try {
    wire = encodeWireBlock(block);
  } catch {
    return null;
  }
  return { type: 'ipc_block', magic: MAGIC_TESTNET, block: wire, powHash };
}

/**
 * IPC frames for these rows, oldest first. A held body goes out whole. A
 * pruned row is preceded by the headers above it, up to its burial depth,
 * so the receiver proves that burial instead of reading a flag. A pruned
 * row this store neither buries nor holds is not sent.
 */
export function ipcBlockFrames(store, rows) {
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  const frames = [];
  let headersTo = 0;
  for (const raw of Array.isArray(rows) ? rows : []) {
    const block = typeof store?.servableBlock === 'function' ? store.servableBlock(raw) : raw;
    if (!block) continue;
    const h = Number(block.height) || 0;
    if (block.samplesPruned === true && h + SAMPLE_PRUNE_CONFIRMATIONS > headersTo) {
      // The run starts at the pruned block's own header, so every header
      // in it links to one the receiver already has.
      const from = h > headersTo ? h - 1 : headersTo;
      const to = h + SAMPLE_PRUNE_CONFIRMATIONS;
      const headers = list.slice(from, to).map((b) => ({
        header: Buffer.from(b.header).toString('hex'),
        hash: powHexOf(b),
        height: b.height,
      }));
      if (headers.length) frames.push({ type: 'ipc_headers', magic: MAGIC_TESTNET, headers });
      headersTo = to;
    }
    const frame = blockFrame(block);
    if (frame) frames.push(frame);
  }
  return frames;
}

function forwardBlock(send, block) {
  const frame = blockFrame(block);
  return frame ? send(frame) : false;
}

function forwardRows(store, send, rows) {
  for (const frame of ipcBlockFrames(store, rows)) send(frame);
}

function acceptIpcHeaders(store, msg) {
  if (msg.magic !== MAGIC_TESTNET) return { accepted: 0, dropped: false };
  if (typeof store?.offerHeaders !== 'function') return { accepted: 0, dropped: false };
  return store.offerHeaders(msg.headers || [], { peer: 'ipc' }) || { accepted: 0, dropped: false };
}

/** Headers from `from` through `to`, capped at one burial run. No tip height is consulted. */
function serveIpcHeaders(store, send, msg) {
  if (msg?.magic !== MAGIC_TESTNET) return;
  const from = Math.max(1, Math.floor(Number(msg?.from) || 1));
  const askedTo = Math.floor(Number(msg?.to) || (from + SAMPLE_PRUNE_CONFIRMATIONS));
  const to = Math.min(Math.max(from, askedTo), from + SAMPLE_PRUNE_CONFIRMATIONS);
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  const headers = [];
  for (const b of list) {
    const h = Number(b?.height) || 0;
    if (h < from || h > to || !b?.header) continue;
    headers.push({
      header: Buffer.from(b.header).toString('hex'),
      hash: powHexOf(b),
      height: h,
    });
    if (headers.length > SAMPLE_PRUNE_CONFIRMATIONS) break;
  }
  if (!headers.length) return;
  send({ type: 'ipc_headers', magic: MAGIC_TESTNET, headers });
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
    forwardRows(store, send, chunk);
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
  forwardRows(store, send, rows);
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
  const parked = new Map();
  const limited = (key) => {
    const now = Date.now();
    const prevAt = asked.get(key) || 0;
    if (now - prevAt < IPC_REPAIR_RETRY_MS) return false;
    asked.set(key, now);
    if (asked.size > 64) asked.delete(asked.keys().next().value);
    return true;
  };
  const repair = (msg, got) => {
    const reason = String(got?.reason || 'fail');
    const parentFix = ipcParentRepair(msg?.block, reason);
    const burial = ipcBurialRepair(msg?.block, reason);
    const height = Number(store.tip()?.height || 0);
    try {
      console.error(JSON.stringify({
        event: 'ipc_apply',
        ok: false,
        reason,
        height,
        blockHeight: Number(msg?.block?.height || 0),
        parent: parentFix?.parent || '',
      }));
    } catch { /* ignore */ }
    // A parent this store already has is not a gap. Asking again every 2s
    // wedges a losing fork whose header does not extend the tip.
    if (parentFix?.ask && !parentKnown(store, parentFix.parent) && limited(`p:${parentFix.parent}`)) {
      send({
        type: 'ipc_getblock',
        magic: MAGIC_TESTNET,
        hash: parentFix.parent,
        child: parentFix.child,
        height,
      });
    }
    if (burial?.ask) {
      // Park even when the ask is rate-limited. A later full run must still
      // retry this body. The ask itself stays on the 2s clock so a short
      // page cannot tight-loop.
      parked.set(burial.child, msg);
      if (limited(`h:${burial.child}`)) {
        send({
          type: 'ipc_getheaders',
          magic: MAGIC_TESTNET,
          from: burial.from,
          to: burial.to,
          child: burial.child,
          height,
        });
      }
    }
  };
  repair.afterHeaders = (offered) => {
    if (!(offered?.accepted > 0) || parked.size === 0) return;
    const batch = [...parked.values()];
    parked.clear();
    if (typeof repair.enqueue !== 'function') return;
    for (const msg of batch) repair.enqueue(msg);
  };
  return repair;
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
  if (msg.magic !== MAGIC_TESTNET) return;
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
      try { msg = parseBoundedJson(raw); } catch { continue; }
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
        const fault = classifyByPhase(err, 'verify');
        deliverProcessFault('ipc', fault);
        if (!staysUpOnFault(fault)) return;
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
  repair.enqueue = enqueue;
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
      if (msg.magic !== MAGIC_TESTNET) return;
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
      if (msg.type === 'ipc_getheaders') {
        serveIpcHeaders(store, send, msg);
        return;
      }
      if (msg.type === 'ipc_tx') {
        acceptIpcTx(store, msg);
        return;
      }
      if (msg.type === 'ipc_headers') {
        const offered = acceptIpcHeaders(store, msg);
        repair.afterHeaders(offered);
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
  repair.enqueue = enqueue;

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
      if (msg.magic !== MAGIC_TESTNET) return;
      if (msg.type === 'ipc_hello') {
        paceBackfill(store, send, msg.height);
        sendMempool(store, send);
        return;
      }
      if (msg.type === 'ipc_getblock') {
        serveIpcGetblock(store, send, msg);
        return;
      }
      if (msg.type === 'ipc_getheaders') {
        serveIpcHeaders(store, send, msg);
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
      if (msg.type === 'ipc_headers') {
        const offered = acceptIpcHeaders(store, msg);
        repair.afterHeaders(offered);
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
