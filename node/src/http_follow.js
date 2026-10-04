import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { decodeWireBlock } from './p2p.js';

/** Public node HTTP. Port 30303 stays fleet-only; these are the same hosts on 443. */
export const HTTP_FOLLOW_SEEDS = [
  'https://p2p.shear.digital',
  'https://r2r.shear.digital',
  'https://b2b.shear.digital',
];

function bookMatches(stats, magic) {
  return String(stats?.magic || '') === magic;
}

async function readJson(url, signal, fetchImpl) {
  const res = await fetchImpl(url, { signal, headers: { accept: 'application/json' } });
  if (!res?.ok) return null;
  const text = await res.text();
  const head = String(text || '').trimStart().slice(0, 16).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/**
 * One verified block from the tallest same-magic public node.
 * Returns true when this call appended a block.
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
  if (local >= tip) return false;
  const body = await readJson(`${base}/block?height=${local + 1}`, signal, fetchImpl);
  if (!body || body.ok === false || !body.header) return false;
  const block = decodeWireBlock(body);
  const got = await store.ingest([block], { offLoopPow: true, tipHeight: tip });
  if (got?.ok !== true) {
    try {
      console.error(JSON.stringify({
        event: 'http_follow',
        ok: false,
        height: local + 1,
        reason: got?.reason || 'fail',
      }));
    } catch { /* ignore */ }
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

/** Desktop Continuum sets SHEAR_HTTP_FOLLOW=1. Unset leaves fleet nodes on P2P only. */
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
      } catch {
        advanced = false;
      }
      if (stopped) break;
      await wait(advanced ? 20 : 3000);
    }
  })();
  run.catch(() => {});
  return {
    stop() {
      stopped = true;
      ac.abort();
    },
  };
}
