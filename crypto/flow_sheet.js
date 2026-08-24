import { createHash, pbkdf2Sync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { encodeDest, encodeHrp, isShearAddress, isDestAddress, hash20FromAddress, payoutDest } from './address.js';
import { EMPTY_ROOT } from './merkle.js';

/** continuity-tethered Flow (CTF). Paid dests need independent Closure C, not C-from-S. */
export const FLOW_PERSONAL = 'chronoflux-J-v1';
export const CLOSURE_PERSONAL = 'chronoflux-G-v1';
export const DEST_INDEX_PERSONAL = 'chronoflux-J-n-v1';
export const VAULT_DOMAIN = 'shear-reserve-v1';
export const JOIN_DOMAIN = 'shear-join-v1';
export const VIEW_KDF_INFO = 'chronoflux-G-v1';

export function asBuf(x, n) {
  if (Buffer.isBuffer(x) && x.length === n) return x;
  if (typeof x === 'string' && /^[0-9a-f]+$/i.test(x) && x.length === n * 2) {
    return Buffer.from(x, 'hex');
  }
  const b = Buffer.isBuffer(x) ? x : Buffer.from(String(x || ''));
  if (b.length === n) return b;
  return createHash('sha256').update(b).digest().subarray(0, n);
}

/** Password → view secret V. Same KDF as shewall (PBKDF2-SHA256-100000). */
export function viewSecretFromPassword(password, salt) {
  const s = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'utf8');
  const k = pbkdf2Sync(String(password || ''), s, 100000, 32, 'sha256');
  return createHash('sha256').update(VIEW_KDF_INFO).update(k).digest();
}

export function closureCommit(viewSecret) {
  const v = Buffer.isBuffer(viewSecret) ? viewSecret : Buffer.from(String(viewSecret || ''), 'utf8');
  return createHash('sha256').update(CLOSURE_PERSONAL).update(v).digest();
}

/** Degenerate: C from S. Not the paid dest generator. */
export function impliedClosure(spendHash20) {
  return createHash('sha256')
    .update(CLOSURE_PERSONAL)
    .update(asBuf(spendHash20, 20))
    .digest();
}

export function flowTweak({ closureCommit: C, continuityRoot, height }) {
  const c = asBuf(C, 32);
  const root = asBuf(continuityRoot || EMPTY_ROOT, 32);
  const h = Buffer.alloc(8);
  h.writeBigUInt64LE(BigInt(height || 0));
  return createHash('sha256')
    .update(FLOW_PERSONAL)
    .update(c)
    .update(root)
    .update(h)
    .digest();
}

export function flowDestHash({ spendHash20, closureCommit: C, continuityRoot, height }) {
  const s = asBuf(spendHash20, 20);
  const t = flowTweak({ closureCommit: C, continuityRoot, height });
  return createHash('sha256')
    .update(FLOW_PERSONAL)
    .update(s)
    .update(t)
    .digest()
    .subarray(0, 20);
}

export function flowDestAddress(args) {
  return encodeDest(flowDestHash(args));
}

export function destEncodings(hash20) {
  const h = asBuf(hash20, 20);
  return [encodeHrp('shp', h)];
}

export function indexedDestHash({ spendHash20, closureCommit: C, index }) {
  const s = asBuf(spendHash20, 20);
  const c = asBuf(C, 32);
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64LE(BigInt(index));
  const t = createHash('sha256').update(DEST_INDEX_PERSONAL).update(c).update(idx).digest();
  return createHash('sha256').update(FLOW_PERSONAL).update(s).update(t).digest().subarray(0, 20);
}

export function destAtIndex(login, { index = 0, viewKey, closureCommit: C } = {}) {
  const s = spendHashFromAddress(login);
  if (!s) return null;
  const commit = C ? asBuf(C, 32) : (viewKey ? closureCommit(viewKey) : null);
  if (!commit) return null;
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return null;
  return encodeDest(indexedDestHash({ spendHash20: s, closureCommit: commit, index: n }));
}

export function spendHashFromAddress(address) {
  if (!isShearAddress(address)) return null;
  return hash20FromAddress(address);
}

/**
 * Paid dest. Login already shp1 → pay as-is.
 * she1 silent ID → shp1 of the same 20 bytes (she1 string never on chain).
 * Rest-frame shear1 requires independent C. No C-from-S.
 */
export function destForLogin(login, { continuityRoot, height, viewKey, closureCommit: C } = {}) {
  const paid = payoutDest(login);
  if (paid) return paid;
  const id = String(login || '').trim().split('.')[0];
  const s = spendHashFromAddress(id);
  if (!s) return null;
  const commit = C ? asBuf(C, 32) : (viewKey ? closureCommit(viewKey) : null);
  if (!commit) return null;
  return flowDestAddress({
    spendHash20: s,
    closureCommit: commit,
    continuityRoot,
    height,
  });
}

export function degenerateDest(login, opts = {}) {
  const s = spendHashFromAddress(login);
  if (!s) return null;
  return flowDestAddress({
    spendHash20: s,
    closureCommit: impliedClosure(s),
    continuityRoot: opts.continuityRoot,
    height: opts.height,
  });
}

export function flowSpendMatches({ dest, spendHash20, closureCommit: C, continuityRoot, height }) {
  const want = flowDestAddress({ spendHash20, closureCommit: C, continuityRoot, height });
  return String(dest) === want;
}

export function destsForViewKey(viewKey, restAddress, rounds, { ownerViewKey } = {}) {
  if (!String(viewKey || '')) return [];
  const rest = String(restAddress || '');
  if (!isShearAddress(rest)) return [];
  if (ownerViewKey != null && String(viewKey) !== String(ownerViewKey)) return [];
  const C = closureCommit(viewKey);
  return rounds.map((r) => destForLogin(rest, {
    continuityRoot: r.continuityRoot,
    height: r.height,
    closureCommit: C,
  })).filter(Boolean);
}

export function vaultRoot() {
  return createHash('sha256').update(VAULT_DOMAIN).digest();
}

export function vaultDest(restFrame, { viewKey, closureCommit: C } = {}) {
  const s = spendHashFromAddress(restFrame);
  if (!s) return null;
  const commit = C ? asBuf(C, 32) : (viewKey ? closureCommit(viewKey) : null);
  if (!commit) return null;
  return flowDestAddress({
    spendHash20: s,
    closureCommit: commit,
    continuityRoot: vaultRoot(),
    height: 0,
  });
}

export function joinRoot() {
  return createHash('sha256').update(JOIN_DOMAIN).digest();
}

export function joinDest(restFrame, { viewKey, closureCommit: C } = {}) {
  const s = spendHashFromAddress(restFrame);
  if (!s) return null;
  const commit = C ? asBuf(C, 32) : (viewKey ? closureCommit(viewKey) : null);
  if (!commit) return null;
  return flowDestAddress({
    spendHash20: s,
    closureCommit: commit,
    continuityRoot: joinRoot(),
    height: 0,
  });
}

export function reservePrincipal(restFrame, opts = {}) {
  return vaultDest(restFrame, opts);
}

export function reserveRejectsDest(restFrame, maybeDest, opts = {}) {
  if (isShearAddress(maybeDest)) return true;
  const vault = vaultDest(restFrame, opts);
  const round = destForLogin(restFrame, opts);
  return String(maybeDest) === round && vault && String(maybeDest) !== vault;
}

export function memoKey(dest) {
  const d = hash20FromAddress(dest) || asBuf(dest, 20);
  return createHash('sha256').update(FLOW_PERSONAL).update(d).digest();
}

export function memoSeal(dest, plaintext) {
  const key = memoKey(dest);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(String(plaintext || ''), 'utf8'), c.final()]);
  return {
    v: 1,
    nonce: nonce.toString('base64'),
    mac: c.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function memoOpen(dest, env) {
  if (!env || env.v !== 1) return null;
  try {
    const key = memoKey(dest);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'));
    d.setAuthTag(Buffer.from(env.mac, 'base64'));
    return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function explorerRowPublic(row) {
  const { memoCt, memoPlain, from, to, ...rest } = row || {};
  return {
    id: rest.id,
    amount: rest.amount,
    height: rest.height,
    memo: !!(memoCt || row?.memo),
  };
}

export { EMPTY_ROOT, isDestAddress, isShearAddress, payoutDest };
