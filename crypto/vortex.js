import { createHash } from 'node:crypto';
import { extraMintAllowed, RESERVE_PROGRAM, JOIN_PROGRAM } from './asert.js';

export const VORTEX_PERSONAL = 'chronoflux-Omega-v1';
export const VORTICE_KEY_PREFIX = 'vort1.';
export const JOIN_WATCH_PROGRAM = 'shear-join-watch-v1';
export const RESERVE_VORTICE = { id: RESERVE_PROGRAM, name: 'The Reserve', pinned: true };
export const JOIN_VORTICE = { id: JOIN_PROGRAM, name: 'The Join', pinned: true };
export const JOIN_WATCH_VORTICE = { id: JOIN_WATCH_PROGRAM, name: '', pinned: true };

const PINNED = new Set([RESERVE_PROGRAM, JOIN_PROGRAM, JOIN_WATCH_PROGRAM]);

export function isPinnedProgram(id) {
  return PINNED.has(String(id || ''));
}

/** Issued creator dapps only. Reserve and Join VAULTs are never a public vortice. */
export function listPublicVortices(issued) {
  return Object.values(issued || {}).filter((r) => r && r.id && !isPinnedProgram(r.id));
}

export function validProgramId(programId) {
  const id = String(programId || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(id)) return null;
  if (isPinnedProgram(id)) return null;
  return id;
}

export function validOrigin(origin) {
  const s = String(origin || '').trim();
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname) return null;
    return s;
  } catch {
    return null;
  }
}

export function vorticeBundleHash({ programId, name, origin, source }) {
  return createHash('sha256')
    .update(VORTEX_PERSONAL)
    .update(String(programId || ''))
    .update('\0')
    .update(String(name || ''))
    .update('\0')
    .update(String(origin || ''))
    .update('\0')
    .update(String(source || ''))
    .digest('hex');
}

function canonicalBody({ id, name, origin, bundle }) {
  return JSON.stringify({ v: 1, id, name, origin, bundle });
}

function macOf(body) {
  return createHash('sha256').update(VORTEX_PERSONAL).update(body).digest('hex').slice(0, 40);
}

/**
 * Creator mints a deploy key. The key names the host URL users fetch.
 * `source` must be the exact bytes the origin will serve.
 */
export function mintVorticeDeployKey({ programId, name, origin, source } = {}) {
  const id = validProgramId(programId);
  const url = validOrigin(origin);
  if (!id || !url) return null;
  if (source == null) return null;
  const src = String(source);
  const label = String(name || id).trim() || id;
  if (label.length < 1 || label.length > 64) return null;
  const bundle = vorticeBundleHash({ programId: id, name: label, origin: url, source: src });
  const body = canonicalBody({ id, name: label, origin: url, bundle });
  const payload = { v: 1, id, name: label, origin: url, bundle, mac: macOf(body) };
  return `${VORTICE_KEY_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

/** @deprecated use mintVorticeDeployKey — kept as a thin alias. */
export function issueVorticeKey(programId, origin, source = '') {
  if (origin == null || origin === '') return null;
  return mintVorticeDeployKey({ programId, origin, source, name: programId });
}

export function parseVorticeKey(key) {
  const raw = String(key || '').trim();
  if (!raw.startsWith(VORTICE_KEY_PREFIX)) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw.slice(VORTICE_KEY_PREFIX.length), 'base64url').toString('utf8'));
    const id = validProgramId(payload.id);
    const origin = validOrigin(payload.origin);
    const name = String(payload.name || '');
    const bundle = String(payload.bundle || '');
    const mac = String(payload.mac || '').toLowerCase();
    if (!id || !origin || !bundle || name.length < 1 || name.length > 64) return null;
    const want = macOf(canonicalBody({ id, name, origin, bundle }));
    if (want !== mac) return null;
    return {
      id,
      name,
      origin,
      bundle,
      pinned: false,
      mint: extraMintAllowed(id),
      key: raw,
    };
  } catch {
    return null;
  }
}

export function verifyVorticeDownload(key, source) {
  const parsed = parseVorticeKey(key);
  if (!parsed) return { ok: false, reason: 'bad_key' };
  if (source == null) return { ok: false, reason: 'need_source' };
  const bundle = vorticeBundleHash({
    programId: parsed.id,
    name: parsed.name,
    origin: parsed.origin,
    source: String(source),
  });
  if (bundle !== parsed.bundle) return { ok: false, reason: 'bundle_mismatch' };
  return {
    ok: true,
    id: parsed.id,
    name: parsed.name,
    origin: parsed.origin,
    bundle,
    source: String(source),
    pinned: false,
    mint: extraMintAllowed(parsed.id),
  };
}

/** Enable only after a verified download of the hosted dapp. */
export function addVortice(list, key, source) {
  const got = verifyVorticeDownload(key, source);
  if (!got.ok) return list;
  if ((list || []).some((v) => v.id === got.id)) return list;
  return [...(list || []), {
    id: got.id,
    name: got.name,
    origin: got.origin,
    bundle: got.bundle,
    source: got.source,
    pinned: false,
    mint: got.mint,
  }];
}

export async function mintVorticeDeployKeyFromOrigin(spec, fetchFn = globalThis.fetch) {
  const url = validOrigin(spec?.origin);
  const id = validProgramId(spec?.programId);
  if (!id || !url) return { ok: false, reason: 'bad_mint' };
  if (typeof fetchFn !== 'function') return { ok: false, reason: 'need_fetch' };
  let source;
  try {
    const res = await fetchFn(url);
    if (!res || res.ok === false) return { ok: false, reason: 'origin_unreachable' };
    source = typeof res.text === 'function' ? await res.text() : String(res.body || '');
  } catch {
    return { ok: false, reason: 'origin_unreachable' };
  }
  const key = mintVorticeDeployKey({
    programId: id,
    name: spec.name,
    origin: url,
    source,
  });
  if (!key) return { ok: false, reason: 'bad_mint' };
  return { ok: true, key, source, ...parseVorticeKey(key) };
}
