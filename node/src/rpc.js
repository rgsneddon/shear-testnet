import http from 'node:http';
import { mempoolPressure } from '../../crypto/levy.js';
import { compactChainBlock } from '../../crypto/chronoflux.js';
import { MAGIC_TESTNET, HASH_TX_LIVE, NANOS_PER_SHE, SPENDABLE_CONFIRMATIONS, consensusFingerprint } from '../../crypto/asert.js';
import { hash20FromAddress, isDestAddress, isPaymentCode, encodeDest } from '../../crypto/address.js';
import { verifyDestOpening } from '../../crypto/spend.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';
import { networkReport } from './network_report.js';
import { oracleView } from './oracle_feed.js';
import { cloneVault, portalRewards, publicVaultView } from '../../crypto/reserve_vault.js';

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

function requestOpen(params) {
  return String((params && (params.open || params.destOpen)) || '');
}

function destHeld(address, params) {
  if (!verifyDestOpening(String(address || ''), requestOpen(params))) {
    return { ok: false, reason: 'dest_hold' };
  }
  return null;
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

function notesForAddress(store, address) {
  const d20 = hash20FromAddress(address);
  if (!d20) return [];
  const want = noteCommitOfDest20(d20);
  const notes = [];
  for (const b of store.blocks || []) {
    const prev = b.hash ? Buffer.from(b.hash).toString('hex') : '';
    for (const tx of b.txs || []) {
      (tx.vout || []).forEach((o, index) => {
        if (!o?.commit || !o?.noteCommit || !want) return;
        try {
          if (!Buffer.from(o.noteCommit).equals(Buffer.from(want))) return;
        } catch {
          return;
        }
        notes.push(toHex({
          kind: o.kind || (tx.coinbase ? 'pot' : 'send'),
          noteCommit: o.noteCommit,
          commit: o.commit,
          valueProof: o.valueProof
            ? { R: o.valueProof.R, z: o.valueProof.z, v: o.valueProof.v }
            : undefined,
          rEph: o.rEph,
          rCt: o.rCt,
          admitPub: o.admitPub,
          viewTag: o.viewTag,
          prev,
          index,
          height: b.height,
          coinbase: !!tx.coinbase,
        }));
      });
    }
  }
  return notes;
}

function noteValueNanos(note) {
  const v = note?.valueProof && note.valueProof.v != null ? Number(note.valueProof.v) : 0;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function commitTag(commit) {
  const hex = Buffer.isBuffer(commit)
    ? commit.toString('hex')
    : (commit instanceof Uint8Array ? Buffer.from(commit).toString('hex') : '');
  if (!hex) return '0';
  return hex.length < 16 ? hex : hex.slice(0, 16);
}

/** Wallet history is every note sealed to this dest, once, plus explorer rows
 *  that are not the same height. Explorer ids (`hash-cb-n`) are not the
 *  wallet's `blockfound:height:dest` id. */
function walletHistoryFor(store, address) {
  const tipH = Number(store.tip?.()?.height || 0);
  const explorer = typeof store.historyFor === 'function' ? (store.historyFor(address) || []) : [];
  const ownedHeights = new Set();
  const fromNotes = [];
  const blocks = new Map();
  for (const n of notesForAddress(store, address)) {
    const height = Number(n.height) || 0;
    if (height < 1) continue;
    const kind = String(n.kind || (n.coinbase ? 'pot' : 'send'));
    if (kind === 'dummy') continue;
    const nanos = noteValueNanos(n);
    if (nanos <= 0) continue;
    const confs = tipH >= height ? (tipH - height + 1) : 0;
    const hash = kind === 'hash';
    const pot = !hash && (kind === 'pot' || kind === 'coinbase' || (n.coinbase === true && kind !== 'pool-fee'));
    if (hash || pot) {
      const row = blocks.get(height) || { pot: 0, hash: 0, confs };
      if (hash) row.hash += nanos;
      else row.pot += nanos;
      row.confs = confs;
      blocks.set(height, row);
      ownedHeights.add(height);
      continue;
    }
    ownedHeights.add(height);
    fromNotes.push({
      id: `note:${height}:${address}:${commitTag(n.commit)}`,
      kind: kind === 'send' ? 'receive' : kind,
      from: '',
      to: address,
      nanos,
      height,
      confirmed: confs >= SPENDABLE_CONFIRMATIONS,
    });
  }
  for (const [height, row] of blocks) {
    fromNotes.push({
      id: `blockfound:${height}:${address}`,
      kind: 'blockfound',
      from: 'coinbase',
      to: address,
      nanos: row.pot + row.hash,
      potNanos: row.pot,
      hashNanos: row.hash,
      height,
      confirmed: row.confs >= SPENDABLE_CONFIRMATIONS,
    });
  }
  const rest = [];
  for (const row of explorer) {
    const h = Number(row?.height) || 0;
    const kind = String(row?.kind || '');
    if (kind === 'lock' || kind === 'vote' || kind === 'withdraw') {
      rest.push(row);
      continue;
    }
    const to = String(row?.to || '');
    if (h >= 1 && ownedHeights.has(h) && (to === address || to === '')) continue;
    rest.push(row);
  }
  return fromNotes.concat(rest);
}

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
    magic: MAGIC_TESTNET,
    admit: 'ADMITv2',
    hashTxLive: HASH_TX_LIVE,
    jroot: live.jroot ? Buffer.from(live.jroot).toString('hex') : '',
    bookLawFingerprint: consensusFingerprint(),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || ''));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
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
      return p2p.connect(hostP, portP).then(() => ({ ok: true, host: hostP, port: portP }))
        .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    }
    if (m === 'setTip' || m === 'settip') {
      return { ok: false, reason: 'setTip_forbidden' };
    }
    if (m === 'getfluxset' || m === 'fluxset') {
      const live = typeof store.fluxset === 'function' ? store.fluxset() : { pubs: [], spendTags: new Set(), jroot: null, commits: [] };
      const pubs = (live.pubs || []).map((p) => Buffer.from(typeof p.toBytes === 'function' ? p.toBytes() : p).toString('hex'));
      const commits = (live.commits || []).map((c) => Buffer.from(c).toString('hex'));
      return {
        ok: true,
        jroot: live.jroot ? Buffer.from(live.jroot).toString('hex') : '',
        pubs,
        commits,
        fluxset: pubs,
        spendTags: [...(live.spendTags || [])],
        admit: 'ADMITv2',
        hashTxLive: store.hashTxLive,
      };
    }
    if (m === 'getjroot' || m === 'jroot') {
      const root = typeof store.jroot === 'function' ? store.jroot() : null;
      return { ok: true, jroot: root ? Buffer.from(root).toString('hex') : '', admit: 'ADMITv2' };
    }
    if (m === 'getfingerprint' || m === 'fingerprint') {
      const fp = typeof store.consensusFingerprint === 'function'
        ? store.consensusFingerprint()
        : '';
      return { ok: true, fingerprint: fp, admit: 'ADMITv2', hashTxLive: store.hashTxLive };
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
        admit: 'ADMITv2',
        magic: MAGIC_TESTNET,
      };
    }
    if (m === 'submitblock' || m === 'submitHeader') {
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
    if (m === 'getnotes' || m === 'notes') {
      const address = String(params.address || params[0] || '');
      if (!isDestAddress(address)) return { ok: false, reason: 'bad_address' };
      const held = destHeld(address, params);
      if (held) return held;
      return { ok: true, notes: notesForAddress(store, address) };
    }
    if (m === 'getbalance' || m === 'balance') {
      const address = String(params.address || params[0] || '');
      if (!isDestAddress(address) && !isPaymentCode(address)) {
        return { ok: false, reason: 'bad_address' };
      }
      const held = destHeld(address, params);
      if (held) return held;
      const nanos = typeof store.spendableNanos === 'function' ? Number(store.spendableNanos(address) || 0) : 0;
      return {
        ok: true,
        coin: 'SHE',
        address,
        balance: nanos / NANOS_PER_SHE,
        pending: 0,
        incoming: [],
        height: store.tip?.()?.height || 0,
      };
    }
    if (m === 'gethistory' || m === 'history') {
      const address = String(params.address || params[0] || '');
      if (!isDestAddress(address) && !isPaymentCode(address)) {
        return { ok: false, reason: 'bad_address' };
      }
      const held = destHeld(address, params);
      if (held) return held;
      return { ok: true, coin: 'SHE', txs: toHex(walletHistoryFor(store, address)) };
    }
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

  const server = http.createServer(async (req, res) => {
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
    if (req.method === 'GET' && (url.pathname === '/fluxset' || url.pathname === '/getfluxset')) {
      json(res, 200, dispatch('getfluxset'));
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
      json(res, 200, dispatch(url.pathname.endsWith('jroot') ? 'getjroot' : 'getfluxset'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/notes' || url.pathname === '/getnotes' || url.pathname === '/api/wallet/notes')) {
      const out = dispatch('getnotes', paramsFrom(url, req));
      json(res, statusFor(out), out);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/balance' || url.pathname === '/getbalance' || url.pathname === '/api/wallet/balance')) {
      const out = dispatch('getbalance', paramsFrom(url, req));
      json(res, statusFor(out), out);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/history' || url.pathname === '/gethistory' || url.pathname === '/api/wallet/history')) {
      const out = dispatch('gethistory', paramsFrom(url, req));
      json(res, statusFor(out), out);
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
        posted = JSON.parse(await readBody(req) || '{}');
      } catch {
        json(res, 400, { ok: false, reason: 'bad_json' });
        return;
      }
      const clientRaw = Number(posted.paintedOwedNanos);
      const clientOwed = Number.isFinite(clientRaw) && clientRaw > 0 ? Math.floor(clientRaw) : 0;
      const clientFrom = String(posted.from || '').trim();
      delete posted.paintedOwedNanos;
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
        posted = JSON.parse(await readBody(req) || '{}');
      } catch {
        json(res, 400, { ok: false, reason: 'bad_json' });
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
        body = JSON.parse(await readBody(req) || '{}');
      } catch {
        json(res, 400, { ok: false, reason: 'bad_json' });
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
