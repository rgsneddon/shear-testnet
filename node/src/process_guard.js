/**
 * Last-resort logger for faults that escape a request handler.
 * Request-scoped errors are logged and the process stays up.
 * Anything else, including a chain-state fault, is logged and exits.
 * The handler must not swallow a chain-state error.
 */

let installed = false;

export function isChainStateError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.chainState === true || err.code === 'chain_state') return true;
  if (err.shearScope === 'request') return false;
  const msg = String(err.message || '');
  return /^(?:datadir_magic:|spent_checkpoint|supply_state\b|chain_state:|book_seal\b)/.test(msg);
}

function onProcessFault(kind, err) {
  const chain = isChainStateError(err);
  const request = !!(err && typeof err === 'object' && err.shearScope === 'request' && !chain);
  const stack = err?.stack || err?.message || err;
  console.error(`SHEAR ${kind}${chain ? ' chain-state' : request ? ' request' : ''}\n${stack}`);
  if (request) return;
  process.exit(1);
}

/** Install once. Safe to call from the node entry only. */
export function installNodeGuards() {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (err) => onProcessFault('unhandledRejection', err));
  process.on('uncaughtException', (err) => onProcessFault('uncaughtException', err));
}
