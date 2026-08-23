import { createHash } from 'node:crypto';
import { extraMintAllowed, RESERVE_PROGRAM } from './asert.js';

export const VORTEX_PERSONAL = 'chronoflux-Omega-v1';
export const RESERVE_VORTICE = { id: RESERVE_PROGRAM, name: 'The Reserve', pinned: true };

/** Dapp creator issues this key. User pastes it to add a vortice. */
export function issueVorticeKey(programId) {
  const id = String(programId || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(id)) return null;
  if (id === RESERVE_PROGRAM) return null;
  const h = createHash('sha256').update(VORTEX_PERSONAL).update(id).digest().toString('hex').slice(0, 40);
  return `${h}.${id}`;
}

export function parseVorticeKey(key) {
  const raw = String(key || '').trim();
  const m = /^([0-9a-f]{40})\.([a-z0-9._-]{3,64})$/i.exec(raw);
  if (!m) return null;
  const id = m[2].toLowerCase();
  if (id === RESERVE_PROGRAM) return null;
  const want = createHash('sha256').update(VORTEX_PERSONAL).update(id).digest().toString('hex').slice(0, 40);
  if (want !== m[1].toLowerCase()) return null;
  return { id, name: id, pinned: false, mint: extraMintAllowed(id) };
}

export function addVortice(list, key) {
  const parsed = parseVorticeKey(key);
  if (!parsed) return list;
  if ((list || []).some((v) => v.id === parsed.id)) return list;
  return [...(list || []), parsed];
}
