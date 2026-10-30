/** Public explorer view. A failed read is never coerced to 0. */
export const HIDDEN = 'hidden on chain';

const SENSITIVE_KEYS = new Set(['amount', 'payee', 'address', 'ip', 'worker']);

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

function scrub(value) {
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key) || inner == null) out[key] = HIDDEN;
      else out[key] = scrub(inner);
    }
    return out;
  }
  return value;
}

/** Pass public fields through. Hide amount, payee, address, ip, and worker at every depth. */
export function publicRecord(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record) || record.ok === false) {
    return failedRecord();
  }
  const out = { ok: true };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ok') continue;
    if (!PUBLIC_KEYS.has(key) || value == null) out[key] = HIDDEN;
    else out[key] = scrub(value);
  }
  return out;
}
