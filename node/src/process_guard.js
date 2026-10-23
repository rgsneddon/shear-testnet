/**
 * Last-resort logger for faults that escape a handler.
 * A fault explicitly tagged request-scoped is logged and the process stays up.
 * Chain-state faults and anything untagged are logged and the process exits.
 * Message text is not a signal. There is no silent recovery.
 */

let installed = false;

/** sysexits EX_SOFTWARE. Store corruption, distinct from a plain fault exit. */
export const STORE_CORRUPT_EXIT = 70;
/** Untagged faults and chain-state faults. */
export const FAULT_EXIT = 1;

const CHAIN_STATE_CODES = new Set([
  'chain_state',
  'datadir_magic',
  'spent_checkpoint',
  'supply_state',
  'book_seal',
]);

/** Flag or code only. Message text is not a chain-state signal. */
export function isChainStateError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.chainState === true) return true;
  return CHAIN_STATE_CODES.has(String(err.code || ''));
}

export function chainStateError(message, code = 'chain_state') {
  const err = new Error(message);
  err.chainState = true;
  err.code = code;
  return err;
}

/** Flag or code only. Message text is not store corruption. */
export function isStoreCorruptError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.storeCorrupt === true) return true;
  return String(err.code || '') === 'store_corrupt';
}

export function storeCorruptError(message, code = 'store_corrupt') {
  const err = new Error(message);
  err.storeCorrupt = true;
  err.code = code;
  return err;
}

export function isRequestScoped(err) {
  return !!(err && typeof err === 'object' && err.shearScope === 'request');
}

/** Stay up only for an explicit request tag that is not chain-state or store corruption. */
export function staysUpOnFault(err) {
  if (isChainStateError(err) || isStoreCorruptError(err)) return false;
  return isRequestScoped(err);
}

export function faultLabel(err) {
  if (isStoreCorruptError(err)) return 'store-corrupt';
  if (isChainStateError(err)) return 'chain-state';
  if (isRequestScoped(err)) return 'request';
  return 'untagged';
}

export function faultExitCode(err) {
  if (isStoreCorruptError(err)) return STORE_CORRUPT_EXIT;
  return FAULT_EXIT;
}

function logFault(kind, err) {
  const stack = err?.stack || err?.message || err;
  console.error(`SHEAR ${kind} ${faultLabel(err)}\n${stack}`);
}

function onProcessFault(kind, err) {
  logFault(kind, err);
  if (staysUpOnFault(err)) return;
  const label = faultLabel(err);
  console.error(`SHEAR exit ${label}`);
  process.exit(faultExitCode(err));
}

/**
 * A caught fault from p2p or a timer. Request-scoped faults are logged and
 * the caller continues. Anything else is thrown on a later turn so the
 * process guard exits loudly.
 */
export function deliverProcessFault(kind, err) {
  if (staysUpOnFault(err)) {
    logFault(kind, err);
    return;
  }
  setTimeout(() => { throw err; }, 0);
}

/** Install once. Safe to call from the node entry only. */
export function installNodeGuards() {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (err) => onProcessFault('unhandledRejection', err));
  process.on('uncaughtException', (err) => onProcessFault('uncaughtException', err));
}
