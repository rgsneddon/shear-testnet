/**
 * Thin solo stratum. Local ShearK → 127.0.0.1:1111. Does not import the pool operator stack.
 * No HTTP dashboard, auto-payout, pool fee, or operator custody.
 */
import net from 'node:net';
import { isDestAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { SHARE_FLOOR_BITS } from '../../crypto/asert.js';

export const SOLO_STRATUM_PORT = 1111;
export const SOLO_STRATUM_BIND = '127.0.0.1';
export const SOLO_JOB_RESTAMP_MS = 10_000;

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

export function parseSoloLogin(login) {
  const s = String(login || '').trim();
  const dest = s.split('.')[0];
  const worker = s.split('.').slice(1).join('.') || 'solo';
  if (!isDestAddress(dest)) return { ok: false, reason: 'need_dest' };
  return { ok: true, dest, worker, login: s };
}

export function soloWireJob(job, shareBits) {
  if (!job || typeof job !== 'object') return job;
  const { headerHistory, shareBitsHist, ...rest } = job;
  void headerHistory;
  void shareBitsHist;
  const out = { ...rest };
  if (shareBits != null) out.shareBits = shareBits;
  out.shareBind = 'dest';
  return out;
}

export function createSoloStratum({
  store,
  port = Number(process.env.SHEAR_STRATUM || process.env.SHEAR_STRATUM_PORT || SOLO_STRATUM_PORT) || SOLO_STRATUM_PORT,
  host = process.env.SHEAR_STRATUM_BIND || SOLO_STRATUM_BIND,
} = {}) {
  const sockets = new Set();
  let lastJob = null;
  let lastMiner = '';
  let restamp = null;

  function issueJob(miner, shareBits = SHARE_FLOOR_BITS) {
    const dest = destForLogin(miner) || miner;
    const { job } = store.template({ miner: dest, shareBits });
    lastJob = job;
    lastMiner = dest;
    return job;
  }

  function pushJob(job, shareBits) {
    const payload = line({ method: 'job', params: soloWireJob(job, shareBits) });
    for (const sock of sockets) {
      try { sock.write(payload); } catch { /* ignore */ }
    }
  }

  const server = net.createServer((sock) => {
    try { sock.setNoDelay(true); } catch { /* ignore */ }
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
        const isLogin = method === 'login'
          || (params.login && method !== 'submit' && method !== 'job' && method !== 'stats'
            && method !== 2 && method !== '2');
        if (isLogin) {
          const adm = parseSoloLogin(params.login || params.user || '');
          if (!adm.ok) {
            try { sock.write(line({ id: msg.id, error: adm.reason })); } catch { /* ignore */ }
            try { sock.destroy(); } catch { /* ignore */ }
            continue;
          }
          session = { dest: adm.dest, worker: adm.worker, login: adm.login };
          const shareBits = Number(params.shareBits) || SHARE_FLOOR_BITS;
          const job = issueJob(adm.dest, shareBits);
          try {
            sock.write(line({
              id: msg.id,
              result: { status: 'OK' },
              job: soloWireJob(job, shareBits),
            }));
          } catch { /* ignore */ }
          continue;
        }
        if (method === 'stats') continue;
        if (method === 'submit') {
          if (!session) {
            try { sock.write(line({ id: msg.id, error: 'need_login' })); } catch { /* ignore */ }
            continue;
          }
          const jobId = String(params.jobId || lastJob?.jobId || '');
          const nonce = params.nonce;
          const powHash = params.hash || params.powHash || params.digest;
          const got = store.submitHeader({
            jobId,
            nonce,
            miner: session.dest,
            powHash,
          });
          try {
            if (got?.ok) sock.write(line({ id: msg.id, result: { status: 'OK' } }));
            else sock.write(line({ id: msg.id, error: got?.reason || 'reject' }));
          } catch { /* ignore */ }
          if (got?.ok) {
            const job = issueJob(session.dest);
            pushJob(job, job.shareBits || SHARE_FLOOR_BITS);
          }
          continue;
        }
      }
    });
    sock.on('close', () => { sockets.delete(sock); });
    sock.on('error', () => { sockets.delete(sock); });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        restamp = setInterval(() => {
          if (!lastMiner || !sockets.size) return;
          try {
            const job = issueJob(lastMiner);
            pushJob(job, job.shareBits || SHARE_FLOOR_BITS);
          } catch { /* ignore */ }
        }, SOLO_JOB_RESTAMP_MS);
        if (typeof restamp.unref === 'function') restamp.unref();
        resolve({
          port: typeof addr === 'object' && addr ? addr.port : port,
          host,
        });
      });
    });
  }

  function close() {
    if (restamp) {
      clearInterval(restamp);
      restamp = null;
    }
    for (const sock of sockets) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
    try { server.close(); } catch { /* ignore */ }
  }

  return {
    listen,
    close,
    server,
    issueJob,
    get lastJob() { return lastJob; },
  };
}
