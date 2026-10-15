import { createStore } from '../src/store.js';
import { MAGIC_REGTEST, sealRegtestFactory } from '../../crypto/regtest_bits.js';

// Held only by this module. createStore accepts shear-regtest only with this
// permit, and the sealer accepts a call only from createRegtestStore.
const PERMIT = Symbol('shear-regtest-factory');

/**
 * Open a store whose header target is the regtest seed.
 * This file is not on the node or pool import graph, so a release zip does
 * not contain it. A non-empty genesis pin is refused by createStore.
 * `bits` is a whole number from the asert floor through 8. Env vars are ignored.
 */
export function createRegtestStore(dir, opts = {}) {
  const {
    bits = 4,
    genesisHash = '',
    magic: _magic,
    regtestPermit: _permit,
    ...rest
  } = opts;
  const pin = String(genesisHash || '');
  if (!pin) sealRegtestFactory(PERMIT, bits);
  return createStore(dir, {
    ...rest,
    genesisHash: pin,
    magic: MAGIC_REGTEST,
    regtestPermit: PERMIT,
  });
}
