import { createHash } from 'node:crypto';
import { encodeAddress, isShearAddress } from './address.js';
import { EMPTY_ROOT } from './merkle.js';

/** Continuum-Tensor-Flow (CTF). Domain separator stays chronoflux-J-v1. */
export const FLOW_PERSONAL = 'chronoflux-J-v1';
export const CLOSURE_PERSONAL = 'chronoflux-G-v1';

export function asBuf(x, n) {
  if (Buffer.isBuffer(x) && x.length === n) return x;
  if (typeof x === 'string' && /^[0-9a-f]+$/i.test(x) && x.length === n * 2) {
    return Buffer.from(x, 'hex');
  }
  const b = Buffer.isBuffer(x) ? x : Buffer.from(String(x || ''));
  if (b.length === n) return b;
  return createHash('sha256').update(b).digest().subarray(0, n);
}

export function closureCommit(viewKey) {
  return createHash('sha256')
    .update(CLOSURE_PERSONAL)
    .update(String(viewKey || ''))
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
  return encodeAddress(flowDestHash(args));
}

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << to) - 1;
  const out = [];
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits) out.push((acc << (to - bits)) & maxv);
  return out;
}

export function spendHashFromAddress(address) {
  if (!isShearAddress(address)) return null;
  const raw = String(address || '').trim();
  const one = raw.lastIndexOf('1');
  if (one < 1) return null;
  const body = raw.slice(one + 1).toLowerCase();
  const vals = [];
  for (const ch of body) {
    const i = CHARSET.indexOf(ch);
    if (i < 0) return null;
    vals.push(i);
  }
  if (vals.length < 7) return null;
  const data = vals.slice(0, -6);
  const bytes = convertBits(data.slice(1), 5, 8, false);
  if (!bytes || bytes.length < 20) return null;
  return Buffer.from(bytes).subarray(0, 20);
}

export function impliedClosure(spendHash20) {
  return createHash('sha256')
    .update(CLOSURE_PERSONAL)
    .update(asBuf(spendHash20, 20))
    .digest();
}

/** Login may be rest-frame shear1. C from view key if provided, else implied from S. */
export function destForLogin(login, { continuityRoot, height, viewKey, closureCommit: C } = {}) {
  const s = spendHashFromAddress(login);
  if (!s) return login;
  const commit = C || (viewKey ? closureCommit(viewKey) : impliedClosure(s));
  return flowDestAddress({
    spendHash20: s,
    closureCommit: commit,
    continuityRoot,
    height,
  });
}

export function flowSpendMatches({ dest, spendHash20, closureCommit: C, continuityRoot, height }) {
  const want = flowDestAddress({ spendHash20, closureCommit: C, continuityRoot, height });
  return String(dest) === want;
}

/**
 * Dest list a view key can open. Dests are destForLogin(rest, lag-1, height)
 * with no viewKey (same as coinbase). ownerViewKey must match or list is empty.
 */
export function destsForViewKey(viewKey, restAddress, rounds, { ownerViewKey } = {}) {
  if (!String(viewKey || '')) return [];
  const rest = String(restAddress || '');
  if (!isShearAddress(rest)) return [];
  if (ownerViewKey != null && String(viewKey) !== String(ownerViewKey)) return [];
  return rounds.map((r) => destForLogin(rest, {
    continuityRoot: r.continuityRoot,
    height: r.height,
  }));
}

/** Reserve/Vortex principal must be rest-frame, never this round's dest. */
export function reserveRejectsDest(restFrame, maybeDest, { continuityRoot, height = 1 } = {}) {
  const dest = destForLogin(restFrame, { continuityRoot, height });
  return String(maybeDest) === dest && String(maybeDest) !== String(restFrame);
}

export { EMPTY_ROOT };
