import { BITS_FP_SCALE, LIVE_MIN_BITS } from './asert.js';

/**
 * Book id for the reorg harness. It is not a testnet book and not mainnet.
 * createStore accepts it only when node/tests/regtest_store.js passes the
 * permit this module sealed, and only when no genesis pin is set.
 * NODE_TEST_CONTEXT and SHEAR_REGTEST_BITS are not consulted.
 */
export const MAGIC_REGTEST = 'shear-regtest';

const REGTEST_BITS_MAX = 8;

let sealedPermit = null;
let sealedBits = null;

function callerIsRegtestFactory() {
  const stack = new Error().stack || '';
  const frames = stack.split('\n').slice(1);
  const external = frames.find((line) => {
    const normalized = line.replace(/\\/g, '/');
    return !normalized.includes('/crypto/regtest_bits.js');
  });
  if (!external) return false;
  const normalized = external.replace(/\\/g, '/');
  return normalized.includes('/node/tests/regtest_store.js')
    && normalized.includes('createRegtestStore');
}

/**
 * Arm easy header bits for this process.
 * Only createRegtestStore may call this. A repeat with the same permit and
 * the same bits is a no-op. Any other caller throws, including one that has
 * set the test-runner env vars.
 */
export function sealRegtestFactory(permit, bits) {
  if (typeof permit !== 'symbol' || !callerIsRegtestFactory()) {
    throw new Error('regtest_magic');
  }
  const n = Number(bits);
  if (!Number.isInteger(n) || n < LIVE_MIN_BITS || n > REGTEST_BITS_MAX) {
    throw new Error('regtest_bits');
  }
  const packed = Math.round(n * BITS_FP_SCALE) >>> 0;
  if (sealedPermit != null) {
    if (permit !== sealedPermit || packed !== sealedBits) throw new Error('regtest_sealed');
    return packed;
  }
  sealedPermit = permit;
  sealedBits = packed;
  return packed;
}

export function regtestPermitOk(permit) {
  return sealedPermit != null && permit === sealedPermit;
}

/**
 * Packed header bits for the regtest book, or null.
 * Null for every testnet and mainnet magic. Null until the test factory
 * has sealed a permit. A release process never seals, so this stays null.
 */
export function regtestBitsOverride(magic) {
  if (String(magic || '') !== MAGIC_REGTEST) return null;
  if (sealedBits == null) return null;
  return sealedBits;
}
