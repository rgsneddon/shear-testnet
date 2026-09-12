/**
 * shear-enc-v1: packed txs and leaves as hash bytes, not JSON.
 * Magic 12 ASCII + type u8 + body. Digest is SHA-256 of the packed buffer.
 */
import { sha256 } from './shear_hash.js';
import { hash20FromAddress } from './address.js';

export const ENC_MAGIC = Buffer.from('shear-enc-v1');
export const ENC_A = 1;
export const ENC_B = 2;
export const ENC_TX = 3;
export const ENC_SHARE = 4;
export const ENC_SHARE_V5 = 5;
export const ENC_A_V5 = 6;
export const LEAF_A_LAYOUT = 'dest20+u64count';
export const LEAF_A_LAYOUT_V5 = 'note_commit+u64count';
export const LEAF_B_LAYOUT = 'dest20+u64unit+u64nonce+h32memo+tag8';
export const A_BODY_LEN = 28;
export const B_BODY_LEN = 76;
export const SHARE_BODY_LEN = 29;
export const SHARE_V5_BODY_MIN = 41;

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

export function packALeafV5({ noteCommit, count }) {
  const nc = Buffer.from(noteCommit);
  if (nc.length !== 32) throw new Error('note_commit must be 32 bytes');
  const body = Buffer.concat([nc, u64le(count || 0)]);
  return Buffer.concat([ENC_MAGIC, Buffer.from([ENC_A_V5]), body]);
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

/** dest20 || nonce_u64le || lz_u8 */
export function packShare({ dest20, nonce, lz = 0 } = {}) {
  const body = Buffer.concat([
    need20(dest20),
    u64le(nonce || 0),
    Buffer.from([Number(lz) & 0xff]),
  ]);
  return Buffer.concat([ENC_MAGIC, Buffer.from([ENC_SHARE]), body]);
}

export function unpackShare(packed) {
  const { type, body } = unpackType(packed);
  if (type !== ENC_SHARE || body.length !== SHARE_BODY_LEN) throw new Error('bad_share');
  return {
    dest20: Buffer.from(body.subarray(0, 20)),
    nonce: body.readBigUInt64LE(20),
    lz: body[28],
  };
}

/** note_commit32 || nonce_u64le || lz_u8 || view_tag? */
export function packShareV5({ noteCommit, nonce, lz = 0, viewTag } = {}) {
  const commit = Buffer.isBuffer(noteCommit) ? noteCommit : Buffer.from(noteCommit);
  if (commit.length !== 32) throw new Error('note_commit must be 32 bytes');
  const parts = [commit, u64le(nonce || 0), Buffer.from([Number(lz) & 0xff])];
  if (viewTag != null && viewTag !== '') {
    const tag = Buffer.isBuffer(viewTag) ? viewTag : Buffer.from([Number(viewTag) & 0xff]);
    parts.push(tag.subarray(0, 1));
  }
  return Buffer.concat([ENC_MAGIC, Buffer.from([ENC_SHARE_V5]), Buffer.concat(parts)]);
}

export function unpackShareV5(packed) {
  const { type, body } = unpackType(packed);
  if (type !== ENC_SHARE_V5 || body.length < SHARE_V5_BODY_MIN) throw new Error('bad_share_v5');
  return {
    noteCommit: Buffer.from(body.subarray(0, 32)),
    nonce: body.readBigUInt64LE(32),
    lz: body[40],
    viewTag: body.length > 41 ? Buffer.from(body.subarray(41, 42)) : null,
  };
}

export function packShareBatch(shares = []) {
  const list = Array.isArray(shares) ? shares : [];
  return list.map((s) => {
    if (Buffer.isBuffer(s)) return s;
    if (s?.noteCommit && Buffer.from(s.noteCommit).length === 32) {
      return packShareV5({
        noteCommit: s.noteCommit,
        nonce: s.nonce,
        lz: s.lz,
        viewTag: s.viewTag,
      });
    }
    return packShare(s);
  });
}

function coerceDest20(raw, dest) {
  if (Buffer.isBuffer(raw) && raw.length === 20) return Buffer.from(raw);
  if (typeof raw === 'string' && /^[0-9a-fA-F]{40}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  if (raw && typeof raw === 'object' && Array.isArray(raw.data) && raw.data.length === 20) {
    return Buffer.from(raw.data);
  }
  if (raw) {
    const b = Buffer.from(raw);
    if (b.length === 20) return b;
  }
  return hash20FromAddress(dest) || Buffer.alloc(20);
}

export function shareRowJson(s) {
  if (Buffer.isBuffer(s) || (typeof s === 'string' && s.length > 8)) {
    const u = unpackShareBatch([s])[0];
    if (u && u !== s) return shareRowJson(u);
  }
  const dest = String(s?.dest || s?.address || s?.miner || '');
  const dest20 = coerceDest20(s?.dest20, dest);
  const nc = s?.noteCommit && Buffer.from(s.noteCommit).length === 32
    ? Buffer.from(s.noteCommit)
    : null;
  return {
    dest,
    dest20: dest20.toString('hex'),
    nonce: String(s?.nonce ?? 0),
    lz: Number(s?.lz || 0) & 0xff,
    ...(nc ? { noteCommit: nc.toString('hex') } : {}),
  };
}

export function unpackShareBatch(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((s) => {
    if (Buffer.isBuffer(s) || typeof s === 'string') {
      const buf = Buffer.from(s);
      const type = buf[ENC_MAGIC.length];
      if (type === ENC_SHARE_V5) return unpackShareV5(buf);
      return unpackShare(buf);
    }
    const dest = String(s.dest || s.address || s.miner || '');
    return {
      dest20: coerceDest20(s.dest20, dest),
      dest,
      noteCommit: s.noteCommit ? Buffer.from(s.noteCommit) : undefined,
      nonce: typeof s.nonce === 'bigint' ? s.nonce : BigInt(s.nonce || 0),
      lz: Number(s.lz || 0) & 0xff,
      viewTag: s.viewTag || null,
    };
  });
}
