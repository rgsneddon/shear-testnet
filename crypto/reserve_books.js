/**
 * Allowed chain magics. This list is the only place those strings are written.
 * Order is the Reserve bytecode order. Do not sort it.
 * SHEAR_TESTNET is the v2 constant. v1 sits after v5. That layout is the pin.
 */
export const RESERVE_PROGRAM_ID = 'shear-reserve-v1';

export const RESERVE_BOOKS = Object.freeze([
  Object.freeze({ asert: 'MAGIC_TESTNET_V2', sol: 'SHEAR_TESTNET', magic: 'shear-testnet-v2' }),
  Object.freeze({ asert: 'MAGIC_TESTNET_V3', sol: 'SHEAR_TESTNET_V3', magic: 'shear-testnet-v3' }),
  Object.freeze({ asert: 'MAGIC_TESTNET_V4', sol: 'SHEAR_TESTNET_V4', magic: 'shear-testnet-v4' }),
  /** Previous DINS book. Not this magic. */
  Object.freeze({ asert: 'MAGIC_TESTNET_V5', sol: 'SHEAR_TESTNET_V5', magic: 'shear-testnet-v5' }),
  Object.freeze({ asert: 'MAGIC_TESTNET_V1', sol: 'SHEAR_TESTNET_V1', magic: 'shear-testnet-v1' }),
  /** Previous empty-book soak (GENESIS_BITS=12, bang-bang log2 step). Not this magic. */
  Object.freeze({ asert: 'MAGIC_TESTNET_V6', sol: 'SHEAR_TESTNET_V6', magic: 'shear-testnet-v6' }),
  /** Previous book. Not this magic. */
  Object.freeze({ asert: 'MAGIC_TESTNET_V7', sol: 'SHEAR_TESTNET_V7', magic: 'shear-testnet-v7' }),
  /** Previous book. Not this magic. */
  Object.freeze({ asert: 'MAGIC_TESTNET_V8', sol: 'SHEAR_TESTNET_V8', magic: 'shear-testnet-v8' }),
  /** Previous book (median11, harden 6, ease 2). Not this magic. Fail-closed. */
  Object.freeze({ asert: 'MAGIC_TESTNET_V9', sol: 'SHEAR_TESTNET_V9', magic: 'shear-testnet-v9' }),
  /** Closed soak. τ = 32·T, GENESIS_BITS = 15. Do not retune that book. Not this magic. */
  Object.freeze({ asert: 'MAGIC_TESTNET_V10', sol: 'SHEAR_TESTNET_V10', magic: 'shear-testnet-v10' }),
  /** Closed book. τ = 16·T, median-11, testnet lid ±1. v11 payloads do not load. */
  Object.freeze({ asert: 'MAGIC_TESTNET_V11', sol: 'SHEAR_TESTNET_V11', magic: 'shear-testnet-v11' }),
  /** Previous book. Pre-fix nodes hello with this magic and do not peer. */
  Object.freeze({ asert: 'MAGIC_TESTNET_V12', sol: 'SHEAR_TESTNET_V12', magic: 'shear-testnet-v12' }),
  /** Live book. Note principal is refused. aserti3-2d, T = 90s, τ = 2h. v12 payloads do not load. */
  Object.freeze({ asert: 'MAGIC_TESTNET_V13', sol: 'SHEAR_TESTNET_V13', magic: 'shear-testnet-v13' }),
  Object.freeze({ asert: 'MAGIC_MAINNET', sol: 'SHEAR_MAINNET', magic: 'shear-v1' }),
]);

function bookMagic(asert) {
  const row = RESERVE_BOOKS.find((b) => b.asert === asert);
  if (!row) throw new Error(`missing reserve book ${asert}`);
  return row.magic;
}

export const MAGIC_TESTNET_V1 = bookMagic('MAGIC_TESTNET_V1');
export const MAGIC_TESTNET_V2 = bookMagic('MAGIC_TESTNET_V2');
export const MAGIC_TESTNET_V3 = bookMagic('MAGIC_TESTNET_V3');
export const MAGIC_TESTNET_V4 = bookMagic('MAGIC_TESTNET_V4');
export const MAGIC_TESTNET_V5 = bookMagic('MAGIC_TESTNET_V5');
export const MAGIC_TESTNET_V6 = bookMagic('MAGIC_TESTNET_V6');
export const MAGIC_TESTNET_V7 = bookMagic('MAGIC_TESTNET_V7');
export const MAGIC_TESTNET_V8 = bookMagic('MAGIC_TESTNET_V8');
export const MAGIC_TESTNET_V9 = bookMagic('MAGIC_TESTNET_V9');
export const MAGIC_TESTNET_V10 = bookMagic('MAGIC_TESTNET_V10');
export const MAGIC_TESTNET_V11 = bookMagic('MAGIC_TESTNET_V11');
export const MAGIC_TESTNET_V12 = bookMagic('MAGIC_TESTNET_V12');
export const MAGIC_TESTNET_V13 = bookMagic('MAGIC_TESTNET_V13');
/** ADMITv3 book. Note-principal withdraw refusal. Pre-fix v12 nodes do not peer. */
export const MAGIC_TESTNET = MAGIC_TESTNET_V13;
export const MAGIC_MAINNET = bookMagic('MAGIC_MAINNET');
