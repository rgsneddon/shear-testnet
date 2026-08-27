/**
 * shear-enc-v1: packed txs and leaves as hash bytes, not JSON.
 * Magic 12 ASCII + type u8 + body. Digest is SHA-256 of the packed buffer.
 */
import { sha256 } from './shear_hash.js';

export const ENC_MAGIC = Buffer.from('shear-enc-v1');
export const ENC_A = 1;
export const ENC_B = 2;
export const ENC_TX = 3;
export const LEAF_A_LAYOUT = 'dest20+u64count';
export const LEAF_B_LAYOUT = 'dest20+u64unit+u64nonce+h32memo+tag8';
export const A_BODY_LEN = 28;
export const B_BODY_LEN = 76;

export function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

export function need20(buf, name = 'dest20') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length !== 20) throw new Error(`${name} must be 20 bytes`);
  return b;
}

export function need32(buf, name = 'hash32') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return b;
}

export function packALeaf({ dest20, count }) {
  const body = Buffer.concat([need20(dest20), u64le(count || 0)]);
  return Buffer.concat([ENC_MAGIC, Buffer.from([ENC_A]), body]);
}

export function packBLeaf({ dest20, unit, nonce, memoH, tag }) {
  const tag8 = Buffer.alloc(8);
  Buffer.from(String(tag || '')).copy(tag8);
  const body = Buffer.concat([
    need20(dest20),
    u64le(unit || 0),
    u64le(nonce || 0),
    need32(memoH || Buffer.alloc(32)),
    tag8,
  ]);
  return Buffer.concat([ENC_MAGIC, Buffer.from([ENC_B]), body]);
}

export function packTx({
  version = 1,
  vins = [],
  vouts = [],
  memoH = null,
  bFlag = 0,
} = {}) {
  const chunks = [ENC_MAGIC, Buffer.from([ENC_TX, version & 0xff, vins.length & 0xff])];
  for (const v of vins) {
    chunks.push(need32(v.prev, 'prev'), Buffer.alloc(4));
    chunks[chunks.length - 1].writeUInt32LE(Number(v.index || 0), 0);
    chunks.push(need20(v.dest20, 'vin dest'));
  }
  chunks.push(Buffer.from([vouts.length & 0xff]));
  for (const o of vouts) {
    chunks.push(need20(o.dest20, 'vout dest'), u64le(o.nanos || 0), Buffer.from([Number(o.kind || 0) & 0xff]));
  }
  const hasMemo = memoH && Buffer.from(memoH).length === 32;
  chunks.push(Buffer.from([hasMemo ? 1 : 0, Number(bFlag || 0) & 0xff]));
  if (hasMemo) chunks.push(need32(memoH));
  return Buffer.concat(chunks);
}

export function packDigest(packed) {
  return sha256(Buffer.from(packed));
}

export function unpackType(packed) {
  const b = Buffer.from(packed);
  if (b.length < 13 || !b.subarray(0, 12).equals(ENC_MAGIC)) throw new Error('bad_magic');
  return { type: b[12], body: b.subarray(13) };
}

export function unpackALeaf(packed) {
  const { type, body } = unpackType(packed);
  if (type !== ENC_A || body.length !== A_BODY_LEN) throw new Error('bad_a_leaf');
  return { dest20: Buffer.from(body.subarray(0, 20)), count: body.readBigUInt64LE(20) };
}

export function unpackBLeaf(packed) {
  const { type, body } = unpackType(packed);
  if (type !== ENC_B || body.length !== B_BODY_LEN) throw new Error('bad_b_leaf');
  return {
    dest20: Buffer.from(body.subarray(0, 20)),
    unit: body.readBigUInt64LE(20),
    nonce: body.readBigUInt64LE(28),
    memoH: Buffer.from(body.subarray(36, 68)),
    tag: body.subarray(68, 76).toString('utf8').replace(/\0+$/, ''),
  };
}
