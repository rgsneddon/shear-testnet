/**
 * Thin solo stratum. Local ShearK → 127.0.0.1:1111. Does not import the pool operator stack.
 * No HTTP dashboard, auto-payout, pool fee, or operator custody.
 */
import net from 'node:net';
import { isDestAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { isInitialBlockDownload } from './status.js';
import { shearHash, meetsTarget } from '../../crypto/shear_hash.js';
import { setNonce } from '../../crypto/header.js';
import { destBoundShareHash, noteCommitOfShare } from '../../crypto/share_batch.js';

export const SOLO_STRATUM_PORT = 1111;
export const SOLO_STRATUM_BIND = '127.0.0.1';
export const SOLO_JOB_RESTAMP_MS = 10_000;

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

export function parseSoloLogin(login) {
  const s = String(login || '').trim();
  const dest = s.split('.')[0];
  const worker = s.includes('.') ? s.split('.').slice(1).join('.') : '';
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

function claimedDigest(claimed) {
  const h = String(claimed || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : '';
}

/** Recompute header hash, then dest-bound share vs block bits. Never appends. */
export function evaluateSoloSubmit({ store, jobId, nonce, claimed, dest } = {}) {
  const rec = store?.jobs?.get(String(jobId || ''));
  if (!rec) return { ok: false, reason: 'stale_job' };
  let header;
  try {
    header = setNonce(rec.tpl.header, BigInt(nonce));
  } catch {
    return { ok: false, reason: 'bad_nonce' };
  }
  const hash = shearHash(header);
  const hex = hash.toString('hex');
  const want = claimedDigest(claimed);
  if (claimed != null && String(claimed).trim() !== '' && !want) {
    return { ok: false, reason: 'bad_hash', hash: hex };
  }
  if (want && want !== hex) {
    return { ok: false, reason: 'bad_hash', hash: hex };
  }
  const job = rec.job || {};
  const blockBits = Number(job.blockBits || job.bits);
  const blockOk = meetsTarget(hash, blockBits);
  const advertised = Number(rec.shareBits ?? job.shareBits ?? SHARE_FLOOR_BITS);
  const pay = String(dest || '').trim();
  let shareOk = false;
  if (pay) {
    const nc = noteCommitOfShare({ dest: pay });
    if (!nc || nc.length !== 32) {
      if (blockOk) {
        return { ok: true, block: true, share: false, hash: hex, header };
      }
      return { ok: false, reason: 'miner_addr', hash: hex };
    }
    shareOk = meetsTarget(destBoundShareHash(hash, nc), advertised);
  } else {
    shareOk = meetsTarget(hash, advertised);
  }
  if (blockOk) {
    return { ok: true, block: true, share: shareOk, hash: hex, header };
  }
  if (shareOk) {
    return { ok: true, block: false, share: true, hash: hex, header };
  }
  return { ok: false, reason: 'low_diff', hash: hex };
}

/** Share-bits hit: OK, no append. Block-bits hit: existing submitHeader/append. */
/** True only when no live peer is ahead and sync queues are idle. */
export function soloMaySeal({ height = 0, peers } = {}) {
  if (!peers) return true;
  return !isInitialBlockDownload({ height, peers });
}

export function applySoloSubmit({ store, jobId, nonce, claimed, dest, peers } = {}) {
  const judged = evaluateSoloSubmit({ store, jobId, nonce, claimed, dest });
  if (!judged.ok) return judged;
  if (!judged.block) {
    try {
      console.error(JSON.stringify({
        event: 'solo_share',
        dest: String(dest || ''),
        jobId: String(jobId || ''),
        nonce: String(nonce),
        hash: judged.hash,
      }));
    } catch { /* ignore */ }
    return judged;
  }
  const tip = typeof store.tip === 'function' ? store.tip() : null;
  const height = Number(tip?.height) || 0;
  if (!soloMaySeal({ height, peers })) {
    return { ok: false, reason: 'syncing', hash: judged.hash, block: true };
  }
  const got = store.submitHeader({
    jobId,
    nonce,
    miner: dest,
    powHash: judged.hash,
  });
  if (got?.ok) {
    return { ...judged, appended: true };
  }
  return { ok: false, reason: got?.reason || 'reject', hash: judged.hash, block: true };
}

/**
 * Submit ACK. ShearK prints BLOCKFOUND!!! and increments blocks= only when
 * this JSON contains "block": true (or 1). Share-only accepts send
 * block:false. Shape matches the public pool: { status:'OK', hash, block }.
 * A block-bits hit whose append was rejected is an error, never status OK.
 */
export function soloSubmitAck(id, got) {
  if (!got?.ok) {
    return { id, error: String(got?.reason || 'reject') };
  }
  return {
    id,
    result: {
      status: 'OK',
      hash: got.hash,
      block: got.block === true,
    },
  };
}

export function createSoloStratum({
  store,
  port = Number(process.env.SHEAR_STRATUM || process.env.SHEAR_STRATUM_PORT || SOLO_STRATUM_PORT) || SOLO_STRATUM_PORT,
  host = process.env.SHEAR_STRATUM_BIND || SOLO_STRATUM_BIND,
  restampMs = SOLO_JOB_RESTAMP_MS,
  peers = null,
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
          const got = applySoloSubmit({
            store,
            jobId,
            nonce,
            claimed: powHash,
            dest: session.dest,
            peers: typeof peers === 'function' ? peers() : peers,
          });
          if (!got?.ok && got?.block) {
            try {
              console.error(JSON.stringify({
                event: 'solo_seal_failed',
                reason: String(got?.reason || 'reject'),
                jobId,
                hash: got?.hash || '',
              }));
            } catch { /* ignore */ }
          }
          try {
            // ShearK BLOCKFOUND!!! / blocks++ reads result.block on this ACK.
            sock.write(line(soloSubmitAck(msg.id, got)));
          } catch { /* ignore */ }
          if (got?.ok && got.block) {
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
        const interval = Number(restampMs);
        if (Number.isFinite(interval) && interval > 0) {
          restamp = setInterval(() => {
            if (!lastMiner || !sockets.size) return;
            try {
              const job = issueJob(lastMiner);
              pushJob(job, job.shareBits || SHARE_FLOOR_BITS);
            } catch { /* ignore */ }
          }, interval);
          if (typeof restamp.unref === 'function') restamp.unref();
        }
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
