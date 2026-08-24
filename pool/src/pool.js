import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredJobFields, decodeHeader } from '../../crypto/header.js';
import { headerFromHex, setNonce } from '../../crypto/header.js';
import { shearHash, meetsTarget, ALGO, CLIENT } from '../../crypto/shear_hash.js';
import { isMineLogin, isPaymentCode, payoutDest } from '../../crypto/address.js';
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

/** Dest (shp1) or silent ID (she1) — worker identity. Payout dest is never she1. */
export function parseLogin(login) {
  const raw = String(login || '').trim();
  return raw.split('.')[0];
}

/** Pool page / stats: never print a she1 payload. */
export function publicMinerLabel(login) {
  const raw = String(login || '').trim();
  const [id, ...rest] = raw.split('.');
  const worker = rest.filter(Boolean).join('.');
  if (isPaymentCode(id)) return worker ? `she1….${worker}` : 'she1…';
  if (id.length > 18) return `${id.slice(0, 18)}…`;
  return raw;
}

/** Full login dest.worker. Two copied worker names stay distinct rows. */
export function workerKey(login) {
  const raw = String(login || '').trim();
  return raw || parseLogin(login);
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
  const others = (peers || []).filter((p) => p && p !== miner);
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
    const payout = payoutDest(miner) || payoutDest([...miners.values()][0]?.login);
    if (!payout) return null;
    const samples = pendingPayout.filter((s) => (s.count || 0) > 0);
    const sb = clampShareBits(shareBitsNow ?? shareBits, { blockBits: blockBitsNow() });
    const { job } = store.template({
      miner: payout,
      samples,
      shareBits: sb,
      bits,
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
    return [...miners.values()];
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
          };
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
          session.sock = sock;
          session.seen = Date.now();
          miners.set(key, session);
          applyFoldedHonesty(session, { peers: honestyPeers() });
          const job = issueJob(conn.shareBits);
          sock.write(line({ id: msg.id, result: { status: 'OK' }, job }));
          continue;
        }
        if (method === 'submit') {
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
            session.roundHashes += 1;
            session.hashes += 1;
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
              if (session) session.blocks += 1;
              pendingPayout = snapshotRound();
              for (const m of miners.values()) m.roundHashes = 0;
              nextJob = true;
            }
          }
          sock.write(line({ id: msg.id, result: { status: 'OK', hash: scored.hash } }));
          if (conn) {
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

  function publicStats() {
    const workers = [...miners.values()].filter((m) => Date.now() - m.seen < 120_000);
    const tip = store.tip();
    return {
      ok: true,
      coin: 'SHE',
      algo: ALGO,
      stratum: `:${stratumPort}`,
      proof: 'PoW',
      miners: workers.length,
      threads: workers.reduce((a, m) => a + (m.threads || 0), 0),
      hashrate: workers.reduce((a, m) => a + (provenHashrate(m) || m.hashes || 0), 0),
      blocks: stats.blocks,
      accepted: stats.accepted,
      stale: stats.stale,
      height: tip?.height || 0,
      header: tip?.header ? Buffer.from(tip.header).toString('hex') : '',
      bits: lastJob?.bits || bits,
      lastFoundAt: (() => {
        if (!tip?.header) return 0;
        try { return Number(decodeHeader(Buffer.from(tip.header)).timestamp); } catch { return 0; }
      })(),
      uptimeMs: Date.now() - stats.started,
      workers: workers.map((m) => ({
        miner: publicMinerLabel(m.login),
        hashes: m.hashes,
        roundHashes: m.roundHashes,
        accepted: m.accepted,
        stale: m.stale,
        blocks: m.blocks,
        threads: m.threads,
        honesty: m.threadHonesty || 'unknown',
      })),
    };
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/stats') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(publicStats()));
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
