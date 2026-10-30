/**
 * A pool-withdraw transaction built by hand, for tests that prove the kind is
 * refused. The builder it replaces left crypto/levy.js with the custodial
 * path: no production code shapes this transaction any more.
 */
import { KIND_POOL_WITHDRAW } from '../crypto/levy.js';

export function handPoolWithdrawTx({ from, to, nanos, fee, id } = {}) {
  const L = Math.max(0, Math.floor(Number(fee) || 0));
  return {
    id: id || `pull-${Date.now()}`,
    kind: KIND_POOL_WITHDRAW,
    from,
    to,
    nanos,
    fee: L,
    sponsor: from,
    vin: [{ address: from }],
    vout: [{ address: to, nanos, kind: KIND_POOL_WITHDRAW }],
  };
}
