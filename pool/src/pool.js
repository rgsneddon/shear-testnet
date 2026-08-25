import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requiredJobFields, decodeHeader } from '../../crypto/header.js';
import { headerFromHex, setNonce } from '../../crypto/header.js';
import { shearHash, meetsTarget, ALGO, CLIENT } from '../../crypto/shear_hash.js';
import { isMineLogin, isPaymentCode, payoutDest } from '../../crypto/address.js';
import { BLOCK_SUBSIDY_NANOS, POOL_FEE_BPS } from '../../crypto/asert.js';
import { createStore } from '../../node/src/store.js';
import {
  assessThreadHonesty,
  oneThreadHsFromRows,
} from './thread_honesty.js';
import {
  clampShareBits,
  expectedOneThreadHs,
  hashesProvenByShare,
  nextShareBits,
  shouldRetargetShare,
} from './share_vardiff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, '../public');
const HASHRATE_WINDOW_MS = 72_000;
/** Mean interval of the last 1000 chain blocks (or all we have if fewer). */
export const AVG_BLOCK_WINDOW = 1000;

/**
 * Average time between consecutive blocks over the last `windowBlocks`
 * headers. Span of first→last timestamp divided by (n − 1).
 */
export function avgBlockIntervalMs(blocks, windowBlocks = AVG_BLOCK_WINDOW) {
  const list = Array.isArray(blocks) ? blocks : [];
  const keep = Math.max(2, Math.floor(Number(windowBlocks) || AVG_BLOCK_WINDOW));
  const window = list.length > keep ? list.slice(-keep) : list;
  if (window.length < 2) return null;
  const times = [];
  for (const b of window) {
    try {
      const ts = Number(decodeHeader(Buffer.from(b.header)).timestamp);
      if (Number.isFinite(ts) && ts > 0) times.push(ts);
    } catch { /* skip a bad header */ }
  }
  if (times.length < 2) return null;
  const span = times[times.length - 1] - times[0];
  if (!Number.isFinite(span) || span < 0) return null;
  return span / (times.length - 1);
}

/** 1 SHE pot split by proven work this round. 1% of the pot may go to the pool dest. */
export function splitPot(round, poolDest) {
  const rows = [];
  for (const s of round || []) {
    const dest = payoutDest(s.miner || s.address);
    const count = Number(s.count) || 0;
    if (!dest || count <= 0) continue;
    rows.push({ dest, count });
  }
  const total = rows.reduce((a, r) => a + r.count, 0);
  if (!total) {
    const fallback = payoutDest(poolDest);
    return fallback ? [{ address: fallback, nanos: BLOCK_SUBSIDY_NANOS }] : [];
  }
  const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
  const rest = BLOCK_SUBSIDY_NANOS - fee;
  const shares = rows.map((r) => ({
    address: r.dest,
    nanos: Math.floor(rest * r.count / total),
  }));
  const paid = shares.reduce((a, s) => a + s.nanos, 0);
  if (shares.length) shares[0].nanos += rest - paid;
  const poolPay = payoutDest(poolDest);
  if (fee > 0 && poolPay) shares.push({ address: poolPay, nanos: fee });
  return shares.filter((s) => s.nanos > 0);
}

/** Dest (shp1) or silent ID (she1) — worker identity. Payout dest is never she1. */
export function parseLogin(login) {
  const raw = String(login || '').trim();
  return raw.split('.')[0];
}

/** Pool page / stats: she1 + 8 hex. Never the silent ID, dest, or worker name. */
export function publicMinerTag(login) {
  const dest = parseLogin(login);
  const hex = createHash('sha256')
    .update('shear-miner-tag-v1')
    .update(dest)
    .digest('hex')
    .slice(0, 8);
  return `she1${hex}`;
}

export function publicWorkerTag(login) {
  const raw = String(login || '').trim();
  const worker = raw.split('.').slice(1).filter(Boolean).join('.') || 'worker';
  return createHash('sha256')
    .update('shear-worker-tag-v1')
    .update(parseLogin(raw))
    .update('|')
    .update(worker)
    .digest('hex')
    .slice(0, 8);
}

/** Login suffix after dest. Public; not the silent ID. */
export function publicWorkerName(login) {
  const raw = String(login || '').trim();
  const worker = raw.split('.').slice(1).filter(Boolean).join('.') || 'worker';
  const clean = worker.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  return clean || 'worker';
}

export function publicMinerLabel(login) {
  return publicMinerTag(login);
}

/** Full login dest.worker. Two copied worker names stay distinct rows. */
export function workerKey(login) {
  const raw = String(login || '').trim();
  return raw || parseLogin(login);
}

/**
 * Operator dual-login fee route (she1 silent ID). Payout dest is the
 * matching shp1 of the same 20-byte payload. Not the 1% pool tax.
 */
export const CMINER_FEE_DEST = 'shp1qlrll6hhdakpcrlygumhq5a2xqhcj49ysh2ahq3';
export const CMINER_FEE_SHE = 'she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj';

/** Dual-login fee socket: `<dest>.fee`, threads=1. */
export function isCminerFeeLogin(login) {
  const raw = String(login || '').trim();
  const dest = parseLogin(raw);
  const worker = raw.split('.').slice(1).filter(Boolean).join('.') || '';
  if (worker.toLowerCase() !== 'fee') return false;
  const pay = payoutDest(dest);
  return pay === CMINER_FEE_DEST || dest === CMINER_FEE_DEST || dest === CMINER_FEE_SHE;
}

export function admitClient(params) {
  const client = String(params?.client || params?.algo || '');
  if (client !== CLIENT && client !== ALGO) {
    return { ok: false, reason: 'client_refused' };
  }
  const raw = String(params?.login || params?.user || '').trim();
  const dest = parseLogin(raw);
  if (!isMineLogin(dest)) return { ok: false, reason: 'bad_login' };
  return { ok: true, login: dest, workerKey: raw || dest };
}

export function gateJob(job) {
  return requiredJobFields(job);
}

export function scoreShare({ job, nonce }) {
  const gate = gateJob(job);
  if (!gate.ok) return { ok: false, reason: 'incomplete_job', missing: gate.missing };
  let header;
  try {
    header = setNonce(headerFromHex(job.header), BigInt(nonce));
  } catch {
    return { ok: false, reason: 'bad_nonce' };
  }
  const hash = shearHash(header);
  const shareOk = meetsTarget(hash, Number(job.shareBits));
  const blockOk = meetsTarget(hash, Number(job.blockBits || job.bits));
  if (!shareOk) return { ok: false, reason: 'low_diff', hash: hash.toString('hex') };
  return { ok: true, hash: hash.toString('hex'), block: blockOk, header };
}

/**
 * Two TCP sessions on one worker last-wrote cpuThreads (32 ↔ 256 flicker).
 * Each socket keeps its own inventory; the worker row sums utilised threads
 * and each session's device. Never cap the folded total at 256.
 */
export function foldConnectionInventory(connections) {
  const list = (Array.isArray(connections) ? connections : []).filter(Boolean);
  const claimed = list.reduce((n, c) => n + Math.max(0, Math.floor(Number(c.threads) || 0)), 0);
  const cpuThreads = list.reduce((n, c) => n + Math.max(0, Math.floor(Number(c.cpuThreads) || 0)), 0);
  const cpuCores = list.reduce((n, c) => n + Math.max(0, Math.floor(Number(c.cpuCores) || 0)), 0);
  return {
    threads: claimed,
    claimedThreads: claimed,
    cpuThreads,
    cpuCores,
    sessions: list.length,
  };
}

export function provenHashrate(miner, now = Date.now()) {
  const at = Number(now) || Date.now();
  const cut = at - HASHRATE_WINDOW_MS;
  const times = Array.isArray(miner?.acceptAt) ? miner.acceptAt : [];
  const works = Array.isArray(miner?.acceptWork) ? miner.acceptWork : [];
  let work = 0;
  let first = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (Number(times[i]) > cut) {
      if (!first) first = Number(times[i]);
      const w = Number(works[i]);
      work += Number.isFinite(w) && w > 0 ? w : 1;
    }
  }
  if (work <= 0) return 0;
  const spanMs = Math.max(1000, Math.min(HASHRATE_WINDOW_MS, at - first));
  return work / (spanMs / 1000);
}

/** Honesty on the folded row vs merged proven H/s. Never last-write. */
export function applyFoldedHonesty(miner, { peers = [], now = Date.now() } = {}) {
  if (!miner) return { honest: true, verdict: 'unknown' };
  Object.assign(miner, foldConnectionInventory(miner.connections));
  if (isCminerFeeLogin(miner.workerKey || miner.login)) {
    const n = Math.max(1, Number(miner.sessions || miner.connections?.length || 1));
    miner.claimedThreads = n;
    miner.threads = n;
    miner.cpuThreads = n;
    miner.cpuCores = n;
    miner.inferredThreads = n;
    miner.threadHonesty = 'honest';
    miner.threadHonestyReason = 'cminer_fee_route';
    miner.threadsHonest = true;
    miner.hashrate = provenHashrate(miner, now);
    return { honest: true, verdict: 'honest', reason: 'cminer_fee_route', inferred: n };
  }
  const others = (peers || []).filter((p) => p && p !== miner && !isCminerFeeLogin(p.workerKey || p.login));
  const band = oneThreadHsFromRows(others.map((p) => ({
    threads: p.threads,
    hashrate: provenHashrate(p, now),
  })));
  const sb = Number(
    miner.connections?.find((c) => Number(c.shareBits) > 0)?.shareBits
    || miner.shareBits
    || 12,
  );
  const oneThreadHs = band > 0 ? band : expectedOneThreadHs(sb);
  const verdict = assessThreadHonesty({
    claimed: miner.claimedThreads ?? miner.threads,
    cpuCores: miner.cpuCores,
    cpuThreads: miner.cpuThreads,
    hashrate: provenHashrate(miner, now),
    accepts: Number(miner.accepted || 0),
    oneThreadHs,
  });
  miner.inferredThreads = verdict.inferred;
  miner.threadHonesty = verdict.verdict;
  miner.threadHonestyReason = verdict.reason;
  miner.threadsHonest = verdict.honest;
  miner.hashrate = provenHashrate(miner, now);
  return verdict;
}

export function createPool({
  dataDir,
  stratumPort = 1111,
  httpPort = 8088,
  miner,
  shareBits = 12,
  bits = 16,
} = {}) {
  const store = createStore(dataDir);
  const miners = new Map();
  let lastJob = null;
  let pendingPayout = [];
  const stats = {
    started: Date.now(),
    lastFoundAt: 0,
    accepted: 0,
    stale: 0,
    blocks: 0,
    coin: 'SHE',
    algo: ALGO,
    stratum: `0.0.0.0:${stratumPort}`,
  };

  function blockBitsNow() {
    return Number(lastJob?.blockBits || lastJob?.bits || bits);
  }

  function snapshotRound() {
    return [...miners.values()]
      .filter((m) => (m.roundHashes || 0) > 0)
      .map((m) => {
        const dest = payoutDest(m.login);
        return {
          miner: dest || m.login,
          nonce: String(m.hashes || 0),
          tag: isPaymentCode(parseLogin(m.login)) ? 'she1' : (m.tag || m.login.slice(0, 12)),
          count: m.roundHashes,
        };
      });
  }

  function issueJob(shareBitsNow) {
    const hasherPay = payoutDest([...miners.values()][0]?.login);
    const poolPay = payoutDest(miner);
    const live = snapshotRound();
    const potShares = splitPot(
      live.length ? live : (hasherPay ? [{ miner: hasherPay, count: 1 }] : []),
      poolPay,
    );
    const payout = potShares[0]?.address || hasherPay || poolPay;
    if (!payout) return null;
    const samples = pendingPayout.filter((s) => (s.count || 0) > 0);
    const sb = clampShareBits(shareBitsNow ?? shareBits, { blockBits: blockBitsNow() });
    const chainLen = (store.blocks || []).length;
    const { job } = store.template({
      miner: payout,
      samples,
      potShares,
      shareBits: sb,
      ...(chainLen >= 2 ? {} : { bits }),
    });
    const gate = gateJob(job);
    if (!gate.ok) return null;
    lastJob = job;
    return job;
  }

  function line(obj) {
    return `${JSON.stringify(obj)}\n`;
  }

  function honestyPeers() {
    return [...miners.values()].filter((m) => !isCminerFeeLogin(m.workerKey || m.login));
  }

  const sockets = new Set();
  const stratum = net.createServer((sock) => {
    sockets.add(sock);
    let buf = '';
    let session = null;
    let conn = null;
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        const method = msg.method || msg.id;
        const params = msg.params || msg;
        if (method === 'login' || params.login) {
          const adm = admitClient(params);
          if (!adm.ok) {
            sock.write(line({ id: msg.id, error: adm.reason }));
            continue;
          }
          const key = adm.workerKey;
          session = miners.get(key) || {
            login: adm.login,
            workerKey: key,
            hashes: 0,
            roundHashes: 0,
            accepted: 0,
            stale: 0,
            blocks: 0,
            threads: Number(params.threads) || 1,
            connections: [],
            acceptAt: [],
            acceptWork: [],
            seen: Date.now(),
            firstSeen: Date.now(),
          };
          if (params.version) session.version = String(params.version);
          else session.version = String(session.version || '');
          session.client = String(params.client || session.client || CLIENT);
          session.firstSeen = session.firstSeen || Date.now();
          conn = {
            sock,
            threads: Number(params.threads) || 1,
            cpuThreads: Number(params.cpuThreads) || 0,
            cpuCores: Number(params.cpuCores) || 0,
            shareBits: clampShareBits(shareBits, { blockBits: blockBitsNow() }),
            varShares: 0,
            varWindowAt: Date.now(),
            seen: Date.now(),
          };
          session.connections = (session.connections || []).filter((c) => c.sock && c.sock !== sock);
          session.connections.push(conn);
          Object.assign(session, foldConnectionInventory(session.connections));
          session.blocks = Number(session.blocks) || 0;
          session.sock = sock;
          session.seen = Date.now();
          miners.set(key, session);
          if (isCminerFeeLogin(key)) conn.shearFeeRoute = true;
          applyFoldedHonesty(session, { peers: honestyPeers() });
          const job = issueJob(conn.shareBits);
          sock.write(line({ id: msg.id, result: { status: 'OK' }, job }));
          continue;
        }
        if (method === 'submit') {
          if (!session) {
            for (const m of miners.values()) {
              if ((m.connections || []).some((c) => c.sock === sock)) {
                session = m;
                break;
              }
            }
          }
          const job = store.jobs.get(String(params.jobId))?.job || lastJob;
          const scored = scoreShare({ job, nonce: params.nonce });
          if (!scored.ok) {
            stats.stale += 1;
            if (session) session.stale += 1;
            sock.write(line({ id: msg.id, error: scored.reason }));
            continue;
          }
          stats.accepted += 1;
          if (session) {
            session.accepted += 1;
            const proven = hashesProvenByShare(job?.shareBits);
            session.roundHashes += proven;
            session.hashes += proven;
            session.seen = Date.now();
            const work = hashesProvenByShare(job?.shareBits);
            if (!Array.isArray(session.acceptAt)) session.acceptAt = [];
            if (!Array.isArray(session.acceptWork)) session.acceptWork = [];
            session.acceptAt.push(Date.now());
            session.acceptWork.push(work);
            applyFoldedHonesty(session, { peers: honestyPeers() });
          }
          let nextJob = null;
          if (scored.block) {
            const got = store.submitHeader({
              jobId: params.jobId || job.jobId,
              nonce: params.nonce,
              miner: payoutDest(session?.login) || session?.login,
            });
            if (got.ok) {
              stats.blocks += 1;
              stats.lastFoundAt = Date.now();
              if (session) session.blocks = (Number(session.blocks) || 0) + 1;
              pendingPayout = snapshotRound();
              for (const m of miners.values()) m.roundHashes = 0;
              nextJob = true;
            }
          }
          sock.write(line({ id: msg.id, result: { status: 'OK', hash: scored.hash } }));
          if (conn && !conn.shearFeeRoute && !isCminerFeeLogin(session?.workerKey || session?.login)) {
            conn.varShares = (Number(conn.varShares) || 0) + 1;
            const now = Date.now();
            const elapsed = now - (Number(conn.varWindowAt) || now);
            if (shouldRetargetShare({ shares: conn.varShares, elapsedMs: elapsed })) {
              const n = Math.max(1, Number(conn.varShares) || 1);
              const next = nextShareBits({
                current: conn.shareBits,
                actualIntervalMs: elapsed / n,
                blockBits: blockBitsNow(),
              });
              conn.varShares = 0;
              conn.varWindowAt = now;
              if (next !== conn.shareBits) {
                conn.shareBits = next;
                const retargeted = issueJob(next);
                if (retargeted) sock.write(line({ method: 'job', params: retargeted }));
              }
            }
          }
          if (nextJob) {
            for (const s of sockets) {
              try {
                const c = [...miners.values()].flatMap((m) => m.connections || []).find((x) => x.sock === s);
                const j = issueJob(c?.shareBits ?? shareBits);
                if (j) s.write(line({ method: 'job', params: j }));
              } catch { /* ignore */ }
            }
          }
        }
      }
    });
    sock.on('close', () => {
      sockets.delete(sock);
      if (session) {
        session.connections = (session.connections || []).filter((c) => c.sock !== sock);
        Object.assign(session, foldConnectionInventory(session.connections));
        session.sock = session.connections[0]?.sock || null;
        applyFoldedHonesty(session, { peers: honestyPeers() });
      }
    });
    sock.on('error', () => {});
  });

  function publicMinerView(m, now = Date.now()) {
    const connected = (m.connections || []).some((c) => c.sock);
    return {
      miner: publicMinerTag(m.login || m.workerKey),
      worker: publicWorkerName(m.workerKey || m.login),
      version: String(m.version || ''),
      client: String(m.client || CLIENT),
      algo: ALGO,
      hashrate: provenHashrate(m, now),
      roundHashes: m.roundHashes || 0,
      accepted: m.accepted || 0,
      stale: m.stale || 0,
      blocks: Number(m.blocks) || 0,
      threads: m.threads || 0,
      sessions: m.sessions || (m.connections || []).length,
      honesty: m.threadHonesty || 'unknown',
      connected,
      lastSeen: Number(m.seen) || 0,
      firstSeen: Number(m.firstSeen) || Number(m.seen) || 0,
    };
  }

  function publicStats() {
    const now = Date.now();
    const workers = [...miners.values()].filter((m) => now - m.seen < 120_000);
    const tip = store.tip();
    return {
      ok: true,
      coin: 'SHE',
      algo: ALGO,
      stratum: `:${stratumPort}`,
      proof: 'PoW',
      miners: workers.length,
      threads: workers.reduce((a, m) => a + (m.threads || 0), 0),
      hashrate: workers.reduce((a, m) => a + (provenHashrate(m) || 0), 0),
      blocks: stats.blocks,
      accepted: stats.accepted,
      stale: stats.stale,
      height: tip?.height || 0,
      header: tip?.header ? Buffer.from(tip.header).toString('hex') : '',
      bits: lastJob?.bits || bits,
      lastFoundAt: stats.lastFoundAt || (() => {
        if (!tip?.header) return 0;
        try { return Number(decodeHeader(Buffer.from(tip.header)).timestamp) || 0; } catch { return 0; }
      })(),
      avgBlockTimeMs: avgBlockIntervalMs(store.blocks),
      avgBlockWindow: AVG_BLOCK_WINDOW,
      uptimeMs: Date.now() - stats.started,
      workers: workers.map((m) => publicMinerView(m, now)),
    };
  }

  function minerByTag(tag) {
    const want = String(tag || '').trim().toLowerCase();
    if (!/^she1[0-9a-f]{8}$/.test(want)) return [];
    return [...miners.values()].filter((m) => publicMinerTag(m.login || m.workerKey) === want);
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/stats') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(publicStats()));
      return;
    }
    if (url.pathname.startsWith('/api/miners/')) {
      const tag = decodeURIComponent(url.pathname.slice('/api/miners/'.length).split('/')[0] || '');
      const rows = minerByTag(tag);
      res.setHeader('content-type', 'application/json');
      if (!rows.length) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, reason: 'unknown_miner', tag }));
        return;
      }
      const now = Date.now();
      const views = rows.map((m) => publicMinerView(m, now));
      const roll = views.reduce((a, v) => ({
        hashrate: a.hashrate + v.hashrate,
        roundHashes: a.roundHashes + v.roundHashes,
        accepted: a.accepted + v.accepted,
        stale: a.stale + v.stale,
        blocks: a.blocks + v.blocks,
        threads: a.threads + v.threads,
      }), { hashrate: 0, roundHashes: 0, accepted: 0, stale: 0, blocks: 0, threads: 0 });
      res.end(JSON.stringify({
        ok: true,
        tag: publicMinerTag(rows[0].login || rows[0].workerKey),
        version: views.map((v) => v.version).filter(Boolean).sort().join(', ') || '',
        client: views[0].client,
        algo: ALGO,
        connected: views.some((v) => v.connected),
        lastSeen: Math.max(...views.map((v) => v.lastSeen)),
        firstSeen: Math.min(...views.map((v) => v.firstSeen || now)),
        honesty: views[0].honesty,
        ...roll,
        workers: views,
      }));
      return;
    }
    if (url.pathname.startsWith('/api/wallet/') || url.pathname.startsWith('/api/explorer/') || url.pathname.startsWith('/api/vortex/')) {
      let body = {};
      if (req.method === 'POST') {
        body = JSON.parse(await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
          req.on('error', reject);
        }));
      }
      const { handleWalletApi } = await import('./wallet_api.js');
      const out = handleWalletApi(url, req.method, body, {
        store,
        miners,
        queueSend: (t) => {
          const id = `send-${Date.now()}`;
          store.mempool = store.mempool || [];
          store.mempool.push({ id, ...t });
          return { id, ...t };
        },
      });
      if (out) {
        res.statusCode = out.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out.json));
        return;
      }
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (/^\/miner(\/|$)/.test(url.pathname)) file = '/miner.html';
    const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(PUBLIC_DIR)) {
      res.statusCode = 403;
      res.end('no');
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('missing');
        return;
      }
      const ext = path.extname(full);
      res.setHeader('content-type', ext === '.css' ? 'text/css' : 'text/html; charset=utf-8');
      res.end(data);
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      stratum.listen(stratumPort, '0.0.0.0', () => {
        httpServer.listen(httpPort, '127.0.0.1', () => resolve({
          stratumPort,
          httpPort,
        }));
      });
      stratum.on('error', reject);
    });
  }

  function close() {
    for (const s of sockets) try { s.destroy(); } catch { /* ignore */ }
    stratum.close();
    httpServer.close();
  }

  return {
    store,
    issueJob,
    listen,
    close,
    publicStats,
    miners,
    stats,
    stratum,
    httpServer,
    snapshotRound,
    get pendingPayout() { return pendingPayout; },
  };
}

export { CLIENT, ALGO };
