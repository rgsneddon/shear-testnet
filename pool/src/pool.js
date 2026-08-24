import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredJobFields, decodeHeader } from '../../crypto/header.js';
import { headerFromHex, setNonce } from '../../crypto/header.js';
import { shearHash, meetsTarget, ALGO, CLIENT } from '../../crypto/shear_hash.js';
import { isDestAddress } from '../../crypto/address.js';
import { createStore } from '../../node/src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, '../public');

export function parseLogin(login) {
  const raw = String(login || '').trim();
  const cut = raw.split('.')[0];
  return cut;
}

export function admitClient(params) {
  const client = String(params?.client || params?.algo || '');
  if (client !== CLIENT && client !== ALGO) {
    return { ok: false, reason: 'client_refused' };
  }
  const login = parseLogin(params?.login || params?.user);
  if (!isDestAddress(login)) return { ok: false, reason: 'bad_login' };
  return { ok: true, login };
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

  function snapshotRound() {
    return [...miners.values()]
      .filter((m) => (m.roundHashes || 0) > 0)
      .map((m) => ({
        miner: m.login,
        nonce: String(m.hashes || 0),
        tag: m.tag || m.login.slice(0, 12),
        count: m.roundHashes,
      }));
  }

  function issueJob() {
    const payout = miner || [...miners.values()][0]?.login;
    if (!payout) return null;
    const samples = pendingPayout.filter((s) => (s.count || 0) > 0);
    const { job } = store.template({
      miner: payout,
      samples,
      shareBits,
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

  const sockets = new Set();
  const stratum = net.createServer((sock) => {
    sockets.add(sock);
    let buf = '';
    let session = null;
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
          session = miners.get(adm.login) || {
            login: adm.login,
            hashes: 0,
            roundHashes: 0,
            accepted: 0,
            stale: 0,
            blocks: 0,
            threads: Number(params.threads) || 1,
            seen: Date.now(),
          };
          session.sock = sock;
          session.seen = Date.now();
          miners.set(adm.login, session);
          const job = lastJob || issueJob();
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
          }
          let nextJob = null;
          if (scored.block) {
            const got = store.submitHeader({
              jobId: params.jobId || job.jobId,
              nonce: params.nonce,
              miner: session?.login,
            });
            if (got.ok) {
              stats.blocks += 1;
              if (session) session.blocks += 1;
              pendingPayout = snapshotRound();
              for (const m of miners.values()) m.roundHashes = 0;
              nextJob = issueJob();
            }
          }
          sock.write(line({ id: msg.id, result: { status: 'OK', hash: scored.hash } }));
          if (nextJob) {
            for (const s of sockets) {
              try { s.write(line({ method: 'job', params: nextJob })); } catch { /* ignore */ }
            }
          }
        }
      }
    });
    sock.on('close', () => {
      sockets.delete(sock);
      if (session) session.sock = null;
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
      hashrate: workers.reduce((a, m) => a + (m.hashes || 0), 0),
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
        miner: m.login.slice(0, 18) + '…',
        hashes: m.hashes,
        roundHashes: m.roundHashes,
        accepted: m.accepted,
        stale: m.stale,
        blocks: m.blocks,
        threads: m.threads,
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
    if (url.pathname.startsWith('/api/wallet/') || url.pathname.startsWith('/api/explorer/')) {
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
