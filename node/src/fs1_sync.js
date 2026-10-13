// FS-1 sync channel rules for node HTTP routes. Mirrors shear-fs1 src/witness.rs;
// shear-fs1/vectors/sync_routes.txt is checked against both.

export const SYNC_EPOCH = 64;
export const SYNC_MAX_EPOCHS = 16;
export const SYNC_ROUTES = Object.freeze(['/sync', '/tx']);
export const SYNC_BANNED_ROUTES = Object.freeze(['/path', '/witness', '/leaf', '/bucket']);
export const SYNC_KEYED_PARAMS = Object.freeze([
  'leaf', 'index', 'chunk', 'path', 'tag', 'spendtag', 'commit', 'notecommit', 'address', 'owned',
  'note', 'send', 'scanhit', 'clear',
]);

function names(params) {
  if (!params) return [];
  if (typeof params.keys === 'function' && !Array.isArray(params)) return [...params.keys()];
  if (typeof params === 'object' && !Array.isArray(params)) return Object.keys(params);
  return [];
}

export function keyedFetchRejected(params) {
  return names(params).some((n) => SYNC_KEYED_PARAMS.includes(String(n).toLowerCase()));
}

export function witnessRouteBanned(pathname) {
  const p = String(pathname || '');
  return SYNC_BANNED_ROUTES.includes(p) || (p.startsWith('/sync/'));
}

export function rangeAligned(from, to, epoch = SYNC_EPOCH) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || epoch <= 0) return false;
  return to > from && from >= 0 && from % epoch === 0 && to % epoch === 0
    && to - from <= SYNC_MAX_EPOCHS * epoch;
}

function u64(v) {
  if (v == null || !/^\d+$/.test(String(v))) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function lowerGet(params, name) {
  for (const n of names(params)) {
    if (String(n).toLowerCase() === name) return typeof params.get === 'function' ? params.get(n) : params[n];
  }
  return null;
}

// Same order as SyncServer::handle: route, keyed-fetch ban, then the S-1 grid.
export function syncVerdict(pathname, params) {
  if (pathname !== '/sync' || witnessRouteBanned(pathname)) return { ok: false, reason: 'route' };
  if (keyedFetchRejected(params)) return { ok: false, reason: 'keyed' };
  const from = u64(lowerGet(params, 'from'));
  const to = u64(lowerGet(params, 'to'));
  if (from == null || to == null || !rangeAligned(from, to)) return { ok: false, reason: 'range' };
  return { ok: true, from, to };
}
