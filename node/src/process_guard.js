/**
 * Last-resort logger for faults that escape a request handler.
 * A request fault is logged and the process stays up.
 * The process exits only for an explicit store-corruption flag or code.
 * Message text is not a signal.
 */

let installed = false;

/** sysexits EX_SOFTWARE. Distinct from a request-fault exit. */
export const STORE_CORRUPT_EXIT = 70;

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

function onProcessFault(kind, err) {
  const corrupt = isStoreCorruptError(err);
  const stack = err?.stack || err?.message || err;
  console.error(`SHEAR ${kind}${corrupt ? ' store-corrupt' : ''}\n${stack}`);
  if (!corrupt) return;
  process.exit(STORE_CORRUPT_EXIT);
}

/** Install once. Safe to call from the node entry only. */
export function installNodeGuards() {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (err) => onProcessFault('unhandledRejection', err));
  process.on('uncaughtException', (err) => onProcessFault('uncaughtException', err));
}
