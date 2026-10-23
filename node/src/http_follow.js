import { MAGIC_TESTNET, SAMPLE_PRUNE_CONFIRMATIONS } from '../../crypto/asert.js';
import { HTTP_BODY_MAX, parseBoundedJson } from '../../crypto/json_bounds.js';
import { decodeWireBlock } from './p2p.js';
import { classifyByPhase, deliverProcessFault, staysUpOnFault } from './process_guard.js';

/** Public HTTPS hosts. The desktop wallet does not follow them unless SHEAR_HTTP_FOLLOW is 1. */
export const HTTP_FOLLOW_SEEDS = [
  'https://p2p.shear.digital',
  'https://r2r.shear.digital',
  'https://b2b.shear.digital',
];

function bookMatches(stats, magic) {
  return String(stats?.magic || '') === magic;
}

async function readCappedText(res) {
  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const buf = Buffer.from(step.value);
      got += buf.length;
      if (got > HTTP_BODY_MAX) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return null;
      }
      parts.push(buf);
    }
    return Buffer.concat(parts).toString('utf8');
  }
  const text = typeof res?.text === 'function' ? await res.text() : '';
  if (String(text || '').length > HTTP_BODY_MAX) return null;
  return String(text || '');
}

async function readJson(url, signal, fetchImpl) {
  const res = await fetchImpl(url, { signal, headers: { accept: 'application/json' } });
  if (!res?.ok) return null;
  const text = await readCappedText(res);
  if (text == null) return null;
  const head = String(text || '').trimStart().slice(0, 16).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return null;
  try {
    const body = parseBoundedJson(text);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function logHttpFail(height, reason) {
  try {
    console.error(JSON.stringify({
      event: 'http_follow',
      ok: false,
      height,
      reason,
    }));
  } catch { /* ignore */ }
}

/** Headers from `from` through `to`. Explorer is only the fallback when /headers is empty. */
async function fetchHeaderPage(base, from, to, signal, fetchImpl) {
  const q = `from=${from}&to=${to}`;
  const first = await readJson(`${base}/headers?${q}`, signal, fetchImpl);
  const page = Array.isArray(first?.headers) ? first.headers : [];
  if (page.length) return page;
  const alt = await readJson(`${base}/api/explorer/headers?${q}`, signal, fetchImpl);
  return Array.isArray(alt?.headers) ? alt.headers : [];
}

/**
 * One verified block from the tallest same-magic public node.
 * Returns true when this call appended a block.
 * A pruned body is offered only after a header page that can bury it.
 * The remote stats height is not that burial.
 */
export async function pullNextHttpBlock({
  store,
  magic = MAGIC_TESTNET,
  seeds = HTTP_FOLLOW_SEEDS,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  let tip = 0;
  let base = '';
  for (const seed of seeds) {
    const root = String(seed || '').replace(/\/$/, '');
    if (!root) continue;
    const stats = await readJson(`${root}/stats`, signal, fetchImpl);
    const height = Number(stats?.height || 0);
    if (!stats || height < 1 || !bookMatches(stats, magic)) continue;
    if (height > tip) {
      tip = height;
      base = root;
    }
  }
  if (!base) return false;
  const local = Number(store.tip()?.height || 0);
  // peers=0 is not idle when the public book is taller. Status reads this.
  noteHttpSync(store, tip, local);
  if (local >= tip) return false;
  const body = await readJson(`${base}/block?height=${local + 1}`, signal, fetchImpl);
  if (!body || body.ok === false || !body.header) return false;
  const block = decodeWireBlock(body);
  const nextH = Math.max(1, Math.floor(Number(block.height) || (local + 1)));
  if (block.samplesPruned === true) {
    let headers = [];
    try {
      headers = await fetchHeaderPage(base, nextH, nextH + SAMPLE_PRUNE_CONFIRMATIONS, signal, fetchImpl);
    } catch {
      headers = [];
    }
    let above = 0;
    let own = false;
    for (const row of headers) {
      const rh = Number(row?.height) || 0;
      if (rh === nextH) own = true;
      else if (rh > nextH) above += 1;
    }
    if (!own && block.header && block.hash) {
      headers = [{
        header: Buffer.isBuffer(block.header) ? block.header.toString('hex') : String(block.header),
        hash: Buffer.isBuffer(block.hash) ? block.hash.toString('hex') : String(block.hash),
        height: nextH,
      }, ...headers];
      own = true;
    }
    // A short or missing run is not a body. Return now; the follow loop retries.
    if (!own || above < SAMPLE_PRUNE_CONFIRMATIONS || typeof store.offerHeaders !== 'function') {
      logHttpFail(nextH, 'samples_pruned');
      noteHttpSync(store, tip, Number(store.tip()?.height || local));
      return false;
    }
    try {
      store.offerHeaders(headers, { peer: 'http', tier: 'pinned' });
    } catch (err) {
      const fault = classifyByPhase(err, 'decode');
      if (!staysUpOnFault(fault)) throw fault;
      logHttpFail(nextH, 'samples_pruned');
      noteHttpSync(store, tip, Number(store.tip()?.height || local));
      return false;
    }
  }
  const got = await store.ingest([block], { offLoopPow: true });
  noteHttpSync(store, tip, Number(store.tip()?.height || local));
  if (got?.ok !== true) {
    logHttpFail(local + 1, got?.reason || 'fail');
    return false;
  }
  try {
    console.log(JSON.stringify({
      event: 'http_follow',
      ok: true,
      height: Number(store.tip()?.height || 0),
    }));
  } catch { /* ignore */ }
  return true;
}

/** Public HTTPS tip ahead of this store. Empty when follow has not seen a tip. */
export function noteHttpSync(store, remoteTip, localHeight) {
  if (!store || typeof store !== 'object') return null;
  const remote = Number(remoteTip) || 0;
  const local = Number(localHeight) || 0;
  const row = { behind: remote > local, remoteTip: remote };
  store.httpSync = row;
  return row;
}

/** Follow runs only when SHEAR_HTTP_FOLLOW is exactly 1. The desktop wallet sets 0 and syncs over P2P. */
export function startHttpFollow(opts = {}) {
  if (String(process.env.SHEAR_HTTP_FOLLOW || '').trim() !== '1') {
    return { stop() {} };
  }
  const ac = new AbortController();
  let stopped = false;
  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const run = (async () => {
    while (!stopped) {
      let advanced = false;
      try {
        advanced = await pullNextHttpBlock({ ...opts, signal: ac.signal });
      } catch (err) {
        const fault = classifyByPhase(err, 'verify');
        deliverProcessFault('http', fault);
        if (!staysUpOnFault(fault)) {
          stopped = true;
          break;
        }
        advanced = false;
      }
      if (stopped) break;
      await wait(advanced ? 20 : 3000);
    }
  })();
  run.catch((err) => {
    deliverProcessFault('http', classifyByPhase(err, 'verify'));
  });
  return {
    stop() {
      stopped = true;
      ac.abort();
    },
  };
}
