import crypto from 'node:crypto';
import http from 'node:http';
import { mempoolPressure } from '../../crypto/levy.js';
import { compactChainBlock } from '../../crypto/chronoflux.js';
import { MAGIC_TESTNET, HASH_TX_LIVE, consensusFingerprint } from '../../crypto/asert.js';
import { fs1AnchorRows } from '../../crypto/admit_v3.js';
import { isDestAddress, encodeDest } from '../../crypto/address.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';
import { networkReport } from './network_report.js';
import { oracleView } from './oracle_feed.js';
import { cloneVault, portalRewards, publicVaultView } from '../../crypto/reserve_vault.js';
import { reservePinOk } from '../../crypto/reserve_evm.js';
import { HTTP_BODY_MAX, HTTP_TX_BODY_MAX, parseBoundedJson } from '../../crypto/json_bounds.js';
import { keyedFetchRejected, syncVerdict, witnessRouteBanned } from './fs1_sync.js';

export const RPC_PORT = 18332;
export const RPC_HOST = '127.0.0.1';

function toHex(v) {
  if (v == null) return v;
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v)) return v.map(toHex);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = toHex(val);
    return out;
  }
  return v;
}

function minePinOk(store) {
  if (store && typeof store.reservePinOk === 'function') return store.reservePinOk() === true;
  return reservePinOk();
}

function blockAtHeight(store, height) {
  const h = Math.floor(Number(height) || 0);
  if (h < 1) return null;
  return (store.blocks || []).find((b) => Number(b.height) === h) || null;
}

function headerJson(b, height) {
  const raw = Buffer.isBuffer(b.header) ? b.header : Buffer.from(b.header || []);
  return {
    ok: true,
    height: Number(b.height || height || 0),
    header: raw.toString('hex'),
    hash: b.hash ? Buffer.from(b.hash).toString('hex') : '',
    continuity: raw.length >= 100 ? raw.subarray(68, 100).toString('hex') : '',
  };
}

function compactBlockJson(b) {
  return toHex({
    ...compactChainBlock(b),
    header: Buffer.from(b.header).toString('hex'),
    hash: Buffer.from(b.hash).toString('hex'),
    height: b.height,
  });
}

function statusFor(out) {
  if (out && out.reason === 'dest_hold') return 401;
  if (out && out.ok === false) return 400;
  return 200;
}

function paramsFrom(url, req) {
  const params = Object.fromEntries(url.searchParams);
  const header = req && req.headers ? req.headers['x-shear-open'] : '';
  if (header && !params.open && !params.destOpen) params.open = String(header);
  return params;
}

/** No RPC returns a per-output amount: notes, balance and history are owner-side (amtCt). */
export const AMOUNT_METHODS = new Set(['getnotes', 'notes', 'getbalance', 'balance', 'gethistory', 'history']);
export const AMOUNT_PATHS = new Set([
  '/notes', '/getnotes', '/api/wallet/notes',
  '/balance', '/getbalance', '/api/wallet/balance',
  '/history', '/gethistory', '/api/wallet/history',
]);

function networkReportJson(store, p2p) {
  const t = store?.tip ? store.tip() : null;
  const hash = t?.hash ? Buffer.from(t.hash).toString('hex') : '';
  const nodes = p2p && typeof p2p.syncedOnline === 'function' ? p2p.syncedOnline() : 1;
  const peers = p2p && typeof p2p.liveOnline === 'function' ? p2p.liveOnline() : 0;
  return networkReport({
    height: t?.height || 0,
    hash,
    nodesOnline: nodes,
    peersLive: peers,
    rounds: typeof store?.openRoundRows === 'function' ? store.openRoundRows() : [],
    mempool: Array.isArray(store?.mempool) ? store.mempool : [],
  });
}

function statsJson(store) {
  const t = store.tip ? store.tip() : null;
  const raw = t?.header ? Buffer.from(t.header) : Buffer.alloc(0);
  const live = typeof store.fluxset === 'function'
    ? store.fluxset()
    : { jroot: null };
  return {
    ok: true,
    height: t?.height || 0,
    header: raw.toString('hex'),
    hash: t?.hash ? Buffer.from(t.hash).toString('hex') : '',
    magic: store.magic || MAGIC_TESTNET,
    admit: 'ADMITv3 (sends off)',
    hashTxLive: HASH_TX_LIVE,
    jroot: live.jroot ? Buffer.from(live.jroot).toString('hex') : '',
    bookLawFingerprint: consensusFingerprint(store.magic || MAGIC_TESTNET),
  };
}

function readBody(req, cap = HTTP_BODY_MAX) {
  const rawLen = req?.headers?.['content-length'];
  const lenText = Array.isArray(rawLen) ? rawLen[0] : rawLen;
  if (lenText != null && lenText !== '') {
    const declared = Number(lenText);
    if (!Number.isFinite(declared) || declared < 0 || declared > cap) {
      const err = new Error('body_cap');
      err.code = 'body_cap';
      return Promise.reject(err);
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      got += buf.length;
      if (got > cap) {
        const err = new Error('body_cap');
        err.code = 'body_cap';
        try { req.pause(); } catch { /* ignore */ }
        finish(reject, err);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8') || ''));
    req.on('error', (err) => finish(reject, err));
  });
}

function postedJson(text) {
  return parseBoundedJson(text || '{}');
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function headerOne(value) {
  if (Array.isArray(value)) return value.length ? value[0] : '';
  return value;
}

/** Loopback names only, with an optional numeric port. Anything else is a rebind. */
export function rpcHostAllowed(header) {
  const raw = String(headerOne(header) ?? '').trim().toLowerCase();
  if (!raw || /[\s@/\\]/.test(raw)) return false;
  let name = raw;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 2) return false;
    name = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return false;
      const tail = rest.slice(1);
      if (!/^\d+$/.test(tail)) return false;
      const port = Number(tail);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    }
    return name === '::1';
  }
  const colon = raw.lastIndexOf(':');
  if (colon > 0) {
    const tail = raw.slice(colon + 1);
    if (/^\d+$/.test(tail)) {
      const port = Number(tail);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
      name = raw.slice(0, colon);
    }
  }
  if (!name || name.includes(':')) return false;
  return name === '127.0.0.1' || name === 'localhost';
}

/** A present Origin is a browser. The sidecar does not serve one. */
export function rpcOriginAllowed(origin) {
  const raw = headerOne(origin);
  return raw == null || String(raw) === '';
}

/** Host, Origin, and the header token apply only to a loopback bind that has a token. */
export function rpcSidecarGate(bind, token) {
  const name = String(bind || '').trim().toLowerCase();
  const loopback = name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]';
  return loopback && String(token || '').trim() !== '';
}

function rpcTokenAllowed(req, token) {
  const want = String(token || '');
  if (!want.trim()) return true;
  const got = String(headerOne(req.headers['x-shear-rpc-token']) || '');
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function refuseRpc(req, res, reason) {
  try { req.resume(); } catch { /* ignore */ }
  json(res, 403, { ok: false, reason });
}

export function createRpc({
  store,
  p2p = null,
  pullBook = null,
  port = Number(process.env.SHEAR_RPC_PORT || RPC_PORT),
  host = process.env.SHEAR_RPC_BIND || RPC_HOST,
  token = process.env.SHEAR_RPC_TOKEN || '',
} = {}) {
  const bind = String(host || RPC_HOST);
  if ((bind === '0.0.0.0' || bind === '::' || bind === '*') && !String(token || '').trim()) {
    throw new Error('rpc_bind_public_needs_token');
  }
  const sse = new Set();

  // S-8: the prefix is the window and the header hash at its last height, then the window's headers.
  function syncWindow(searchParams) {
    const v = syncVerdict('/sync', searchParams);
    if (!v.ok) return v;
    const byHeight = new Map();
    for (const b of store.blocks || []) {
      const h = Number(b.height);
      if (h >= v.from && h < v.to) byHeight.set(h, b);
    }
    const last = byHeight.get(v.to - 1);
    if (!last) return { ok: false, reason: 'unknown' };
    const headers = [];
    for (let h = Math.max(1, v.from); h < v.to; h += 1) {
      const b = byHeight.get(h);
      if (!b) return { ok: false, reason: 'unknown' };
      headers.push(headerJson(b, h));
    }
    return { ok: true, from: v.from, to: v.to, headerRoot: Buffer.from(last.hash).toString('hex'), headers };
  }

  function pushEvent(ev, payload) {
    const line = `event: ${ev}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sse) {
      try { res.write(line); } catch { /* drop */ }
    }
  }

  if (store && typeof store.on === 'function') {
    store.on('reorg', (e) => pushEvent('reorg', e));
    store.on('credits_frozen', (e) => pushEvent('credits_frozen', e));
    store.on('tip', (e) => pushEvent('tip', {
      height: Number(e?.height || 0),
      hash: String(e?.hash || ''),
    }));
  }

  function dispatch(method, params = {}) {
    const m = String(method || '');
    const mutating = new Set(['addnode']);
    if (mutating.has(m) && String(token || '').trim()) {
      const tok = String(params.token || params.rpcToken || '');
      if (tok !== String(token)) return { ok: false, reason: 'rpc_token' };
    }
    if (m === 'getpolicy' || m === 'policy') {
      return { ok: true, ...(typeof store.getpolicy === 'function' ? store.getpolicy() : {}) };
    }
    if (m === 'getchaintips' || m === 'chaintips') {
      return { ok: true, tips: typeof store.getchaintips === 'function' ? store.getchaintips() : [] };
    }
    if (m === 'getreorgs' || m === 'reorgs') {
      return { ok: true, reorgs: typeof store.getreorgs === 'function' ? store.getreorgs() : [] };
    }
    if (m === 'addnode') {
      const tok = String(params.token || params.rpcToken || '');
      if (String(token || '').trim() && tok !== String(token)) {
        return { ok: false, reason: 'rpc_token' };
      }
      if ((bind === '0.0.0.0' || bind === '::') && tok !== String(token || '')) {
        return { ok: false, reason: 'rpc_token' };
      }
      const hostP = String(params.host || params[0] || '');
      const portP = Number(params.port || params[1] || 30303);
      if (!hostP || !p2p || typeof p2p.connect !== 'function') {
        return { ok: false, reason: 'no_p2p' };
      }
      if (typeof p2p.isRoutablePeerAddr === 'function' ? !p2p.isRoutablePeerAddr(hostP) : false) {
        return { ok: false, reason: 'bad_addr' };
      }
      return p2p.connect(hostP, portP, { pinned: true }).then(() => ({ ok: true, host: hostP, port: portP }))
        .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    }
    if (m === 'setTip' || m === 'settip') {
      return { ok: false, reason: 'setTip_forbidden' };
    }
    if (m === 'getfluxset' || m === 'fluxset') {
      if (keyedFetchRejected(params)) return { ok: false, reason: 'keyed_fetch' };
      const live = typeof store.fluxset === 'function' ? store.fluxset() : { pubs: [], spendTags: new Set(), jroot: null, commits: [] };
      const pubs = (live.pubs || []).map((p) => Buffer.from(typeof p.toBytes === 'function' ? p.toBytes() : p).toString('hex'));
      const commits = (live.commits || []).map((c) => Buffer.from(c).toString('hex'));
      const tipHeight = Number((typeof store.tip === 'function' ? store.tip()?.height : 0) || 0);
      const anchors = typeof store.anchorNote === 'function' ? fs1AnchorRows(tipHeight, store.anchorNote) : [];
      return {
        ok: true,
        jroot: live.jroot ? Buffer.from(live.jroot).toString('hex') : '',
        height: tipHeight,
        anchors,
        pubs,
        commits,
        fluxset: pubs,
        spendTags: [...(live.spendTags || [])],
        admit: 'ADMITv3',
        hashTxLive: store.hashTxLive,
      };
    }
    if (m === 'getjroot' || m === 'jroot') {
      const root = typeof store.jroot === 'function' ? store.jroot() : null;
      return { ok: true, jroot: root ? Buffer.from(root).toString('hex') : '', admit: 'ADMITv3' };
    }
    if (m === 'getfingerprint' || m === 'fingerprint') {
      const fp = typeof store.consensusFingerprint === 'function'
        ? store.consensusFingerprint()
        : '';
      return { ok: true, fingerprint: fp, admit: 'ADMITv3', hashTxLive: store.hashTxLive };
    }
    if (m === 'queuetx' || m === 'queueTx') {
      const wrapped = !!(params && params.tx && typeof params.tx === 'object');
      const tx = wrapped ? params.tx : params;
      if (typeof store.queueTx !== 'function') return { ok: false, reason: 'no_store' };
      // Painted owed is an option beside the tx. A body field is not spendable credit.
      let owed = 0;
      if (wrapped) {
        const n = Number(params.paintedOwedNanos);
        if (Number.isFinite(n) && n > 0) owed = Math.floor(n);
      }
      if (tx && typeof tx === 'object' && Object.prototype.hasOwnProperty.call(tx, 'paintedOwedNanos')) {
        delete tx.paintedOwedNanos;
      }
      return store.queueTx(tx, { paintedOwedNanos: owed });
    }
    if (m === 'gettemplate' || m === 'template') {
      if (!minePinOk(store)) return { ok: false, reason: 'reserve_deploy' };
      if (typeof store.template !== 'function') return { ok: false, reason: 'no_store' };
      const miner = String(params.miner || params[0] || encodeDest(Buffer.alloc(20, 9)));
      if (!isDestAddress(miner)) return { ok: false, reason: 'coinbase_needs_dest' };
      const { tpl, job } = store.template({ miner });
      return {
        ok: true,
        jobId: job.jobId,
        header: Buffer.from(tpl.header).toString('hex'),
        bits: tpl.bits,
        height: tpl.height,
        miner,
        admit: 'ADMITv3',
        magic: store.magic || MAGIC_TESTNET,
      };
    }
    if (m === 'submitblock' || m === 'submitHeader') {
      if (!minePinOk(store)) return { ok: false, reason: 'reserve_deploy' };
      if (typeof store.submitHeader !== 'function') return { ok: false, reason: 'no_store' };
      return store.submitHeader({
        jobId: params.jobId || params[0],
        nonce: params.nonce || params[1],
        miner: params.miner,
        powHash: params.powHash,
        skipSharePow: params.skipSharePow,
        trustedPowHash: params.trustedPowHash,
      });
    }
    if (m === 'mempoolPressure' || m === 'mempoolpressure') {
      return mempoolPressure(store?.mempool || []);
    }
    if (m === 'getstats' || m === 'stats') {
      return statsJson(store);
    }
    if (m === 'getnetwork' || m === 'network') {
      return networkReportJson(store, p2p);
    }
    if (m === 'getheader' || m === 'header') {
      const height = Math.floor(Number(params.height || params[0] || 0));
      const b = blockAtHeight(store, height);
      if (!b) return { ok: false, reason: 'unknown_height' };
      return headerJson(b, height);
    }
    if (m === 'getheaders' || m === 'headers') {
      const from = Math.max(1, Math.floor(Number(params.from || params[0] || 1)));
      const toRaw = Math.floor(Number(params.to || params[1] || from));
      const to = Math.min(Math.max(from, toRaw), from + 1999);
      const headers = [];
      for (let h = from; h <= to; h += 1) {
        const b = blockAtHeight(store, h);
        if (!b) continue;
        headers.push(headerJson(b, h));
      }
      return { ok: true, from, to, headers };
    }
    if (m === 'getblock' || m === 'block' || m === 'compactblock') {
      const height = Math.floor(Number(params.height || 0));
      const hash = String(params.hash || params[0] || '');
      let b = null;
      if (height >= 1) b = blockAtHeight(store, height);
      if (!b && hash) {
        b = (store.blocks || []).find((x) => {
          try { return Buffer.from(x.hash).toString('hex') === hash; } catch { return false; }
        }) || null;
      }
      if (!b) return { ok: false, reason: 'unknown_block' };
      return { ok: true, ...compactBlockJson(b) };
    }
    if (m === 'getblocks' || m === 'blocks' || m === 'compactblocks') {
      const from = Math.max(1, Math.floor(Number(params.from || 1)));
      const toRaw = Math.floor(Number(params.to || from));
      const to = Math.min(Math.max(from, toRaw), from + 63);
      const blocksOut = [];
      for (let h = from; h <= to; h += 1) {
        const b = blockAtHeight(store, h);
        if (b) blocksOut.push(compactBlockJson(b));
      }
      return { ok: true, from, to, blocks: blocksOut };
    }
    if (AMOUNT_METHODS.has(m)) return { ok: false, reason: 'route' };
    if (m === 'getoracle' || m === 'oracle') {
      const vault = store.reserveVault || null;
      return { ok: true, ...oracleView(vault, store.oracleSnapshot, Date.now()) };
    }
    if (m === 'getreserve' || m === 'reserve') {
      const vault = store.reserveVault;
      if (!vault) return { ok: false, reason: 'no_reserve' };
      const now = Date.now();
      const pub = publicVaultView(vault, now);
      const out = {
        ok: true,
        programId: pub.programId,
        epochBps: Math.floor(Number(vault.epochBps ?? pub.oracleBps ?? 0)),
        epochIndex: Math.floor(Number(vault.epochIndex || 0)),
        votes: pub.votes,
        totalStakedNanos: pub.totalStakedNanos,
        totalIdleNanos: pub.totalIdleNanos,
        liveHashBonusNanos: Number(vault.liveHashBonusNanos || 1),
      };
      const address = String(params.address || params[0] || '');
      if (!address) return out;
      if (!isDestAddress(address)) return { ok: false, reason: 'bad_address' };
      return { ...out, address, portal: portalRewards(cloneVault(vault), address, now) };
    }
    return { ok: false, reason: 'unknown_method', method: m };
  }

  const gate = rpcSidecarGate(bind, token);
  const server = http.createServer(async (req, res) => {
    if (gate) {
      if (!rpcHostAllowed(req.headers.host)) {
        refuseRpc(req, res, 'rpc_host');
        return;
      }
      if (!rpcOriginAllowed(req.headers.origin)) {
        refuseRpc(req, res, 'rpc_origin');
        return;
      }
      if (!rpcTokenAllowed(req, token)) {
        refuseRpc(req, res, 'rpc_token');
        return;
      }
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('\n');
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/policy' || url.pathname === '/getpolicy')) {
      json(res, 200, dispatch('getpolicy'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/chaintips' || url.pathname === '/getchaintips')) {
      json(res, 200, dispatch('getchaintips'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/reorgs' || url.pathname === '/getreorgs')) {
      json(res, 200, dispatch('getreorgs'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/mempoolPressure' || url.pathname === '/mempoolpressure')) {
      json(res, 200, dispatch('mempoolPressure'));
      return;
    }
    if (witnessRouteBanned(url.pathname)) {
      json(res, 404, { ok: false, reason: 'route' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sync') {
      const out = syncWindow(url.searchParams);
      json(res, out.ok ? 200 : (out.reason === 'unknown' ? 404 : 400), out);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/fluxset' || url.pathname === '/getfluxset')) {
      const out = dispatch('getfluxset', Object.fromEntries(url.searchParams));
      json(res, out?.ok === false ? 400 : 200, out);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/jroot' || url.pathname === '/getjroot')) {
      json(res, 200, dispatch('getjroot'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/fingerprint' || url.pathname === '/getfingerprint')) {
      json(res, 200, dispatch('getfingerprint'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/stats' || url.pathname === '/getstats' || url.pathname === '/api/stats')) {
      json(res, 200, dispatch('getstats'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/network' || url.pathname === '/getnetwork' || url.pathname === '/api/network')) {
      json(res, 200, dispatch('getnetwork'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/header' || url.pathname === '/getheader' || url.pathname === '/api/explorer/header')) {
      const out = dispatch('getheader', Object.fromEntries(url.searchParams));
      json(res, out?.ok === false ? 404 : 200, out);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/headers' || url.pathname === '/getheaders' || url.pathname === '/api/explorer/headers')) {
      json(res, 200, dispatch('getheaders', Object.fromEntries(url.searchParams)));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/block' || url.pathname === '/getblock' || url.pathname === '/compactblock')) {
      const out = dispatch('getblock', Object.fromEntries(url.searchParams));
      json(res, out?.ok === false ? 404 : 200, out);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/blocks' || url.pathname === '/getblocks' || url.pathname === '/compactblocks')) {
      json(res, 200, dispatch('getblocks', Object.fromEntries(url.searchParams)));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/api/wallet/fluxset' || url.pathname === '/api/wallet/jroot')) {
      const out = dispatch(url.pathname.endsWith('jroot') ? 'getjroot' : 'getfluxset', Object.fromEntries(url.searchParams));
      json(res, out?.ok === false ? 400 : 200, out);
      return;
    }
    if (AMOUNT_PATHS.has(url.pathname)) {
      json(res, 404, { ok: false, reason: 'route' });
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/api/policy' || url.pathname === '/policy')) {
      json(res, 200, dispatch('getpolicy'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/oracle' || url.pathname === '/getoracle' || url.pathname === '/api/oracle')) {
      json(res, 200, dispatch('getoracle'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/reserve' || url.pathname === '/getreserve' || url.pathname === '/api/reserve')) {
      json(res, 200, dispatch('getreserve', Object.fromEntries(url.searchParams)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/send') {
      let posted = {};
      try {
        posted = postedJson(await readBody(req, HTTP_TX_BODY_MAX));
      } catch (err) {
        const reason = err?.code === 'body_cap' ? 'body_cap' : (err?.code === 'json_cap' ? 'json_cap' : 'bad_json');
        json(res, reason === 'body_cap' ? 413 : 400, { ok: false, reason });
        return;
      }
      const clientRaw = Number(posted.paintedOwedNanos);
      const clientOwed = Number.isFinite(clientRaw) && clientRaw > 0 ? Math.floor(clientRaw) : 0;
      const clientFrom = String(posted.from || '').trim();
      if (String(posted.kind || 'send') !== 'send') delete posted.paintedOwedNanos;
      const book = pullBook || {
        viewByDest(address) {
          if (clientOwed > 0 && String(address) === clientFrom) return { pendingNanos: clientOwed };
          return { pendingNanos: 0 };
        },
      };
      const out = handleWalletApi(url, 'POST', posted, {
        store,
        miners: new Map(),
        pullBook: book,
        queueSend(draft, meta) {
          const owedRaw = Number(meta && meta.paintedOwedNanos);
          const paintedOwedNanos = Number.isFinite(owedRaw) && owedRaw > 0 ? Math.floor(owedRaw) : 0;
          const id = draft.id || (draft.kind === 'lock' ? `lock-${Date.now()}` : `tx-${Date.now()}`);
          const tx = { ...draft, id };
          const got = dispatch('queuetx', { tx, paintedOwedNanos });
          if (!got || got.ok === false) return got;
          return got.tx || tx;
        },
      });
      json(res, out?.status || 500, out?.json || { ok: false, reason: 'send' });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/queuetx' || url.pathname === '/queueTx')) {
      let posted = {};
      try {
        posted = postedJson(await readBody(req, HTTP_TX_BODY_MAX));
      } catch (err) {
        const reason = err?.code === 'body_cap' ? 'body_cap' : (err?.code === 'json_cap' ? 'json_cap' : 'bad_json');
        json(res, reason === 'body_cap' ? 413 : 400, { ok: false, reason });
        return;
      }
      const tx = posted.tx || posted.params?.tx || posted;
      const out = dispatch('queuetx', tx);
      const resolved = typeof out?.then === 'function' ? await out : out;
      json(res, resolved?.ok === false ? 400 : 200, resolved);
      return;
    }
    let body = {};
    if (req.method === 'POST') {
      try {
        body = postedJson(await readBody(req));
      } catch (err) {
        const reason = err?.code === 'body_cap' ? 'body_cap' : (err?.code === 'json_cap' ? 'json_cap' : 'bad_json');
        json(res, reason === 'body_cap' ? 413 : 400, { ok: false, reason });
        return;
      }
    }
    const method = body.method || url.pathname.replace(/^\//, '');
    const params = body.params || paramsFrom(url, req);
    if (!body.params && req.headers && req.headers['x-shear-open'] && !params.open && !params.destOpen) {
      params.open = String(req.headers['x-shear-open']);
    }
    const got = dispatch(method, params);
    const out = typeof got?.then === 'function' ? await got : got;
    if (body.id != null) {
      json(res, 200, { jsonrpc: '2.0', id: body.id, result: out });
      return;
    }
    json(res, statusFor(out), out);
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bind, () => {
        resolve({ host: bind, port: server.address().port });
      });
    });
  }

  function close() {
    for (const res of sse) {
      try { res.end(); } catch { /* */ }
    }
    sse.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { listen, close, dispatch, server, get port() { return server.address()?.port ?? port; } };
}
