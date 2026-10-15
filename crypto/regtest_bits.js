import { BITS_FP_SCALE, LIVE_MIN_BITS } from './asert.js';

/**
 * Book id for the reorg harness. It is not a testnet book and not mainnet.
 * createStore ignores it unless regtestBitsOverride returns a target.
 */
export const MAGIC_REGTEST = 'shear-regtest';

/** Opt-in packed-work seed. Ignored unless the node test runner is the host. */
export const REGTEST_BITS_ENV = 'SHEAR_REGTEST_BITS';

const REGTEST_BITS_MAX = 8;

function testRunnerHost() {
  const ctx = String(process.env.NODE_TEST_CONTEXT || '');
  return ctx === 'child' || ctx.startsWith('child-');
}

/**
 * Easy header bits for one test process.
 * Null on every testnet magic and on mainnet, null when the test runner
 * is not the host, and null when the harness did not opt in. Callers that
 * pass MAGIC_TESTNET or MAGIC_MAINNET always get null, so a pool or node
 * process cannot publish this target.
 */
export function regtestBitsOverride(magic) {
  if (String(magic || '') !== MAGIC_REGTEST) return null;
  if (!testRunnerHost()) return null;
  const raw = String(process.env[REGTEST_BITS_ENV] || '').trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < LIVE_MIN_BITS || n > REGTEST_BITS_MAX) return null;
  return Math.round(n * BITS_FP_SCALE) >>> 0;
}
