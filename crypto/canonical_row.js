/**
 * The one canonical encoding of a tx body. The block digest (chain.js
 * digestTx) and the mempool body key (mempool.js txBodyKey) both hash this,
 * so they cannot drift apart.
 *
 * Rules:
 * - Keys are sorted. A key whose value is undefined is absent.
 * - Bytes are one form however they are held: a Buffer, a Uint8Array, the
 *   {$hex} a p2p frame carries (p2p.js hexify) and the {type:'Buffer',data}
 *   JSON writes for a Buffer (chainbin.js) all encode as {"$b":"<hex>"}.
 * - A string is exactly its text. Hex text is not read as bytes and its case
 *   is not folded: a body keeps each field's type through HTTP, gossip,
 *   template, disk and reload, so a relayer who changes a type or a letter
 *   changes the digest.
 * - A bigint is {"$big":"<decimal>"}. A number that JSON cannot carry
 *   (NaN, Infinity) encodes as null, as JSON.stringify writes it.
 * - Those three encodings are each one value's: a body that holds a plain
 *   {"$b"} or {"$big"} object, or a NaN or Infinity, would share a digest
 *   with another body, so it is refused on arrival (canonicalAliasPath).
 */
import { createHash } from 'node:crypto';

/** The bytes of a byte container, or null when `v` is not one. */
export function byteContainer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$hex' && typeof v.$hex === 'string' && /^([0-9a-f]{2})*$/.test(v.$hex)) {
      return Buffer.from(v.$hex, 'hex');
    }
    if (keys.length === 2 && v.type === 'Buffer' && Array.isArray(v.data)
      && v.data.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
      return Buffer.from(v.data);
    }
  }
  return null;
}

export function canonicalEncode(v) {
  const bytes = byteContainer(v);
  if (bytes) return `{"$b":${JSON.stringify(bytes.toString('hex'))}}`;
  if (typeof v === 'bigint') return `{"$big":${JSON.stringify(v.toString())}}`;
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalEncode(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalEncode(v[k])}`).join(',')}}`;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * The path of the first value in `v` whose encoding is another value's, or
 * '' (Russell 26 Oct: body-v2 has no aliases). A plain object holding only
 * "$b" encodes like bytes and one holding only "$big" like a bigint; NaN
 * and +/-Infinity encode like null. Byte containers are bytes, not objects.
 */
export function canonicalAliasPath(v, at = '') {
  if (typeof v === 'number') return Number.isFinite(v) ? '' : (at || '.');
  if (!v || typeof v !== 'object' || byteContainer(v)) return '';
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const hit = canonicalAliasPath(v[i], `${at}[${i}]`);
      if (hit) return hit;
    }
    return '';
  }
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  if (keys.length === 1 && (keys[0] === '$b' || keys[0] === '$big')) return at ? `${at}.${keys[0]}` : keys[0];
  for (const k of keys) {
    const hit = canonicalAliasPath(v[k], at ? `${at}.${k}` : k);
    if (hit) return hit;
  }
  return '';
}

/** sha256(domain || canonicalEncode(v)). */
export function canonicalHash(domain, v) {
  return createHash('sha256').update(String(domain)).update(canonicalEncode(v)).digest();
}
