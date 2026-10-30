/** Public explorer view. A failed read is never coerced to 0. */
export const HIDDEN = 'hidden on chain';

const PUBLIC_KEYS = new Set([
  'height',
  'hash',
  'txid',
  'txId',
  'nullifier',
  'output',
  'commitment',
  'fee',
  'emission',
  'supply',
  'coinbase',
  'hashBonus',
  'hash_bonus',
  'difficulty',
  'timestamp',
  'vault',
  'mempool',
  'pins',
  'fingerprint',
  'fingerprints',
]);

function failedRecord() {
  return {
    ok: false,
    height: HIDDEN,
    hash: HIDDEN,
    txid: HIDDEN,
    amount: HIDDEN,
    payee: HIDDEN,
    address: HIDDEN,
    ip: HIDDEN,
    worker: HIDDEN,
  };
}

/** Pass public fields through. Hide amount, payee, address, ip, worker, unknown keys, and nulls. */
export function publicRecord(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record) || record.ok === false) {
    return failedRecord();
  }
  const out = { ok: true };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ok') continue;
    if (!PUBLIC_KEYS.has(key) || value == null) out[key] = HIDDEN;
    else out[key] = value;
  }
  return out;
}
