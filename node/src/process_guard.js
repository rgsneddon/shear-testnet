/**
 * Last-resort logger for faults that escape a handler.
 * A throw while parsing, decoding, or verifying input, before any book write,
 * is request-scoped: the handler drops it and the process stays up.
 * A throw during commit or apply is chain-state and the process exits 70,
 * the same code as store corruption. An untagged fault still exits 1.
 * Message text is not a signal. There is no silent recovery.
 */

let installed = false;

/** sysexits EX_SOFTWARE. Store corruption, distinct from a plain fault exit. */
export const STORE_CORRUPT_EXIT = 70;
/** Untagged faults. Chain-state uses STORE_CORRUPT_EXIT. */
export const FAULT_EXIT = 1;

/** Before any book write. A throw here stays in process. */
export const INPUT_PHASES = new Set(['decode', 'verify', 'pre-commit']);
/** During commit or apply. A throw here is chain-state. */
export const COMMIT_PHASES = new Set(['mid-commit', 'post-commit']);

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

export function faultPhase(err) {
  if (!err || typeof err !== 'object') return '';
  return String(err.shearPhase || '');
}

/** A throw before any book write. Chain-state and store corruption are left alone. */
export function asInputFault(err, phase = 'pre-commit') {
  if (!err || typeof err !== 'object') {
    const wrapped = new Error(String(err == null ? 'input' : err));
    wrapped.shearScope = 'request';
    wrapped.shearPhase = phase;
    return wrapped;
  }
  if (isChainStateError(err) || isStoreCorruptError(err)) return err;
  if (COMMIT_PHASES.has(faultPhase(err))) return asCommitFault(err, faultPhase(err));
  err.shearScope = 'request';
  if (!err.shearPhase) err.shearPhase = phase;
  return err;
}

/** A throw during commit or apply. Store corruption keeps its own flag. */
export function asCommitFault(err, phase = 'mid-commit') {
  if (!err || typeof err !== 'object') {
    const wrapped = chainStateError(String(err == null ? 'commit' : err));
    wrapped.shearPhase = phase;
    return wrapped;
  }
  if (isStoreCorruptError(err)) return err;
  err.chainState = true;
  if (!CHAIN_STATE_CODES.has(String(err.code || ''))) err.code = 'chain_state';
  if (!err.shearPhase) err.shearPhase = phase;
  return err;
}

/**
 * Classify by when the throw happened. An explicit commit phase wins.
 * An already-marked chain-state or store-corruption fault is not retagged
 * as a request. An unknown phase is left untagged.
 */
export function classifyByPhase(err, fallbackPhase) {
  const marked = faultPhase(err);
  const phase = marked || fallbackPhase || '';
  if (COMMIT_PHASES.has(phase)) return asCommitFault(err, phase);
  if (isStoreCorruptError(err) || isChainStateError(err)) return err;
  if (INPUT_PHASES.has(phase)) return asInputFault(err, phase);
  return err;
}

/** Stay up only for a request-scoped fault that is not chain-state or store corruption. */
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
  if (isStoreCorruptError(err) || isChainStateError(err)) return STORE_CORRUPT_EXIT;
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

/** A timer or feed callback. Request-scoped faults are logged. Commit faults exit. */
export function guardPeerWork(kind, fn, phase = 'pre-commit') {
  const fail = (err) => {
    deliverProcessFault(kind, classifyByPhase(err, phase));
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.catch(fail);
    return out;
  } catch (err) {
    fail(err);
    return undefined;
  }
}

/** Install once. Safe to call from the node entry only. */
export function installNodeGuards() {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (err) => onProcessFault('unhandledRejection', err));
  process.on('uncaughtException', (err) => onProcessFault('uncaughtException', err));
}
