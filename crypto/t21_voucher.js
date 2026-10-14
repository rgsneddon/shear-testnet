/**
 * Payout vouchers. Deterministic from the wallet secret and a counter.
 * The secret is 32 bytes from shewall.bin. A seed phrase is refused.
 */
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { G, hashToScalar, scalarBytes } from './note.js';
import { openShewallBin, unpackShewall } from './shewall_bin.js';
import {
  VOUCHER_GAP, VCH_B_DOM, VCH_Y_DOM, VCH_LAM_DOM,
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

/** Restore: open shewall.bin with the password, then scan. No seed phrase. */
export function vouchersFromShewall(env, password, lambdaHexes, opts = {}) {
  const packed = openShewallBin(env, password);
  const opened = unpackShewall(packed);
  const want = new Set((lambdaHexes || []).map((h) => String(h).toLowerCase()));
  return scanVouchers(opened.seed32, (v) => want.has(v.lambdaBytes.toString('hex')), opts);
}
