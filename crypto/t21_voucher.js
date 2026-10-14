/**
 * Payout vouchers. Deterministic from the wallet secret and a counter.
 * The secret is 32 bytes from shewall.bin. A seed phrase is refused.
 */
import { createHash } from 'node:crypto';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { fs1Leaf } from './fs1_leaf.js';
import { G, hashToScalar, scalarBytes } from './note.js';
import { openShewallBin, unpackShewall } from './shewall_bin.js';
import {
  VOUCHER_GAP, VCH_B_DOM, VCH_Y_DOM, VCH_LAM_DOM, VCH_PROBE_DOM,
} from './t21_params.js';

const Point = RistrettoPoint;
const Fn = Point.Fn;

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export function walletSecretBytes(secret) {
  if (typeof secret === 'string') {
    const err = new Error('seed_phrase');
    err.reason = 'seed_phrase';
    throw err;
  }
  const b = Buffer.from(secret);
  if (b.length !== 32) {
    const err = new Error('wallet_secret');
    err.reason = 'wallet_secret';
    throw err;
  }
  return b;
}

export function voucherAt(secret, ctr) {
  const key = walletSecretBytes(secret);
  const c = u64le(ctr);
  const b = hashToScalar(Buffer.from(VCH_B_DOM), key, c);
  const y = hashToScalar(Buffer.from(VCH_Y_DOM), key, c);
  const lambda = hashToScalar(Buffer.from(VCH_LAM_DOM), key, c);
  return {
    ctr,
    b,
    y,
    lambda,
    lambdaBytes: Buffer.from(scalarBytes(lambda)),
    B: G.multiply(b),
    Y: G.multiply(y),
  };
}

/**
 * Scan counters from `start`. A run of `gap` misses stops the scan.
 * The next counter after that run is not returned.
 */
export function scanVouchers(secret, match, { start = 0, gap = VOUCHER_GAP, max = 1_000_000 } = {}) {
  const found = [];
  let misses = 0;
  const from = Math.max(0, Math.floor(Number(start) || 0));
  const limit = Math.max(1, Math.floor(Number(gap) || VOUCHER_GAP));
  for (let c = from; c < from + max; c += 1) {
    if (misses >= limit) break;
    const v = voucherAt(secret, c);
    if (Fn.is0(v.b) || Fn.is0(v.y) || Fn.is0(v.lambda)) {
      misses += 1;
      continue;
    }
    if (match(v)) {
      found.push(v);
      misses = 0;
    } else {
      misses += 1;
    }
  }
  return found;
}

/** The public half a miner hands to the pool. */
export function publicVoucher(v) {
  return { B: Buffer.from(v.B.toBytes()), Y: Buffer.from(v.Y.toBytes()), lambda: Buffer.from(v.lambdaBytes) };
}

function canonicalPoint(bytes) {
  const b = Buffer.from(bytes || []);
  if (b.length !== 32) return null;
  try {
    const P = Point.fromBytes(Uint8Array.from(b));
    if (P.equals(Point.ZERO)) return null;
    if (!Buffer.from(P.toBytes()).equals(b)) return null;
    return P;
  } catch {
    return null;
  }
}

/**
 * Voucher acceptance (payeeFs1Ok for a voucher). B* and Y are canonical,
 * non-identity, and distinct. λ is a canonical non-zero scalar. A probe
 * note P = B* + δ·G over a fixed commitment must be an FS-1 leaf, so the
 * admit point Hp(P) decodes. A pool refuses a voucher that fails this.
 */
export function voucherKeysOk(pub) {
  const B = canonicalPoint(pub?.B);
  const Y = canonicalPoint(pub?.Y);
  if (!B || !Y || B.equals(Y)) return false;
  const lam = Buffer.from(pub?.lambda || []);
  if (lam.length !== 32) return false;
  let l;
  try {
    l = Fn.fromBytes(Uint8Array.from(lam));
  } catch {
    return false;
  }
  if (Fn.is0(l)) return false;
  const probeC = Point.hashToCurve(createHash('sha512').update(VCH_PROBE_DOM).update(Buffer.from(pub.B)).digest());
  const delta = hashToScalar(Buffer.from(VCH_PROBE_DOM), Buffer.from(pub.B), Buffer.from(probeC.toBytes()));
  const P = B.add(G.multiply(delta));
  return !!fs1Leaf({ admitPub: Buffer.from(P.toBytes()), commit: Buffer.from(probeC.toBytes()) });
}

/** Restore: open shewall.bin with the password, then scan. No seed phrase. */
export function vouchersFromShewall(env, password, lambdaHexes, opts = {}) {
  const packed = openShewallBin(env, password);
  const opened = unpackShewall(packed);
  const want = new Set((lambdaHexes || []).map((h) => String(h).toLowerCase()));
  return scanVouchers(opened.seed32, (v) => want.has(v.lambdaBytes.toString('hex')), opts);
}
