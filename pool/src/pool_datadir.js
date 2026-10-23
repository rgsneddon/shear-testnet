/**
 * Pool book folder. Distinct from the node's default so one host can run both.
 * An explicit SHEAR_DATA is shared with the node and still takes the one lock.
 */
import { defaultDataDir } from '../../node/src/node.js';

export const POOL_BOOK_LEAF = 'testnet-v11-pool';

export function defaultPoolDataDir(opts = {}) {
  return defaultDataDir({ ...opts, leaf: POOL_BOOK_LEAF });
}
