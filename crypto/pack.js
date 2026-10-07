/**
 * shear-enc-v1: packed txs and leaves as hash bytes, not JSON.
 * Magic 12 ASCII + type u8 + body. Digest is SHA-256 of the packed buffer.
 */
import { createHash } from 'node:crypto';
import { sha256 } from './shear_hash.js';
import { hash20FromAddress } from './address.js';
import { noteCommitOfDest20 } from './note.js';

export const ENC_MAGIC = Buffer.from('shear-enc-v1');
export const ENC_A = 1;
export const ENC_B = 2;
export const ENC_TX = 3;
export const ENC_SHARE = 4;
export const ENC_SHARE_V5 = 5;
export const ENC_A_V5 = 6;
/** note_commit || nonce || lz || credited share bits. v12 work weight. */
export const ENC_SHARE_WORK = 7;
export const LEAF_A_LAYOUT = 'dest20+u64count';
export const LEAF_A_LAYOUT_V5 = 'note_commit+u64count';
export const LEAF_B_LAYOUT = 'dest20+u64unit+u64nonce+h32memo+tag8';
export const A_BODY_LEN = 28;
export const B_BODY_LEN = 76;
export const SHARE_BODY_LEN = 29;
export const SHARE_V5_BODY_MIN = 41;
export const SHARE_WORK_BODY_LEN = 42;

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

/** Credited share bits travel with the share. A v5 frame has no bits and pays the floor.
 * v12 work frames always carry the header slot: 0 on this block's parent, 1 on that parent's parent.
 * A 42-byte body is not a work share. */
export function packShareWork({ noteCommit, nonce, lz = 0, shareBits = 0, proofSlot } = {}) {
  const commit = Buffer.isBuffer(noteCommit) ? noteCommit : Buffer.from(noteCommit);
  if (commit.length !== 32) throw new Error('note_commit must be 32 bytes');
  const bits = Math.max(0, Math.min(255, Math.floor(Number(shareBits) || 0)));
  const slot = Number(proofSlot);
  if (proofSlot == null || proofSlot === '' || (slot !== 0 && slot !== 1)) {
    throw new Error('bad_share_work');
  }
  const parts = [
    commit,
    u64le(nonce || 0),
    Buffer.from([Number(lz) & 0xff, bits & 0xff, slot]),
  ];
  return Buffer.concat([ENC_MAGIC, Buffer.from([ENC_SHARE_WORK]), Buffer.concat(parts)]);
}

export function unpackShareWork(packed) {
  const { type, body } = unpackType(packed);
  if (type !== ENC_SHARE_WORK) throw new Error('bad_share_work');
  if (body.length !== SHARE_WORK_BODY_LEN + 1) throw new Error('bad_share_work');
  const slot = body[SHARE_WORK_BODY_LEN];
  if (slot !== 0 && slot !== 1) throw new Error('bad_share_work');
  return {
    noteCommit: Buffer.from(body.subarray(0, 32)),
    nonce: body.readBigUInt64LE(32),
    lz: body[40],
    shareBits: body[41],
    proofSlot: slot,
  };
}

function slotRootBytes(v) {
  if (v == null || v === '') return null;
  if (Buffer.isBuffer(v) && v.length === 32) return Buffer.from(v);
  if (v instanceof Uint8Array && v.length === 32) return Buffer.from(v);
  if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  if (v && typeof v === 'object' && typeof v.$hex === 'string' && /^[0-9a-fA-F]{64}$/.test(v.$hex)) {
    return Buffer.from(v.$hex, 'hex');
  }
  if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data) && v.data.length === 32) {
    return Buffer.from(v.data);
  }
  return null;
}

/** sha256 over the packed frames in stored order. The empty batch has a root.
 * Frames are the disk form: a dest with no noteCommit still packs as work when it has bits. */
export function shareSlotRoot(shares = []) {
  const list = (Array.isArray(shares) ? shares : []).map(shareForPack);
  const frames = packShareBatch(list);
  const h = createHash('sha256');
  h.update(Buffer.from('shareslot1'));
  const n = Buffer.alloc(4);
  n.writeUInt32LE(frames.length);
  h.update(n);
  for (const frame of frames) {
    if (frame[ENC_MAGIC.length] === ENC_SHARE_WORK) {
      const bodyLen = frame.length - ENC_MAGIC.length - 1;
      if (bodyLen !== SHARE_WORK_BODY_LEN + 1) throw new Error('bad_share_work');
      const slot = frame[frame.length - 1];
      if (slot !== 0 && slot !== 1) throw new Error('bad_share_work');
    }
    const len = Buffer.alloc(4);
    len.writeUInt32LE(frame.length);
    h.update(len);
    h.update(frame);
  }
  return h.digest();
}

/** Empty when the coinbase has no root. Null when the field is present and not 32 bytes. */
export function shareSlotDigestSuffix(tx) {
  if (!tx || tx.shareSlotRoot == null || tx.shareSlotRoot === '') return Buffer.alloc(0);
  const root = slotRootBytes(tx.shareSlotRoot);
  if (!root) return null;
  return Buffer.concat([Buffer.from('shareslot1'), root]);
}

/**
 * Null when the committed root matches the batch.
 * A buried pruned block has no frames left, so a sealed root is not recomputed.
 * An empty batch with no root is an older empty round.
 */
export function shareSlotCommitment(tx, shares, { samplesPruned = false, buried = false } = {}) {
  const list = Array.isArray(shares) ? shares : [];
  const rawPresent = !!(tx && tx.shareSlotRoot != null && tx.shareSlotRoot !== '');
  const committed = rawPresent ? slotRootBytes(tx.shareSlotRoot) : null;
  if (rawPresent && !committed) return 'share_slot';
  if (samplesPruned && buried && list.length === 0) return null;
  if (!list.length) {
    if (!committed) return null;
    if (!committed.equals(shareSlotRoot([]))) return 'share_slot';
    return null;
  }
  let expect;
  try { expect = shareSlotRoot(list); } catch { return 'share_slot'; }
  if (!committed || !committed.equals(expect)) return 'share_slot';
  return null;
}

export function packShareBatch(shares = []) {
  const list = Array.isArray(shares) ? shares : [];
  return list.map((s) => {
    if (Buffer.isBuffer(s)) return s;
    if (s?.noteCommit && Buffer.from(s.noteCommit).length === 32) {
      const bits = s.shareBits != null && s.shareBits !== ''
        ? s.shareBits
        : s.creditedShareBits;
      if (bits != null && bits !== '') {
        return packShareWork({
          noteCommit: s.noteCommit,
          nonce: s.nonce,
          lz: s.lz,
          shareBits: bits,
          proofSlot: s.proofSlot,
        });
      }
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

function asNoteCommit(v) {
  if (Buffer.isBuffer(v) && v.length === 32) return Buffer.from(v);
  if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  if (v && typeof v === 'object' && Array.isArray(v.data) && v.data.length === 32) return Buffer.from(v.data);
  return null;
}

function shareForPack(s) {
  if (Buffer.isBuffer(s) || typeof s === 'string') return s;
  const dest = String(s?.dest || s?.address || s?.miner || '');
  const dest20 = coerceDest20(s?.dest20, dest);
  const nc = asNoteCommit(s?.noteCommit)
    || ((dest20 && !dest20.equals(Buffer.alloc(20))) ? noteCommitOfDest20(dest20) : null);
  if (nc && nc.length === 32) {
    const bits = s?.shareBits != null && s.shareBits !== ''
      ? s.shareBits
      : s?.creditedShareBits;
    const slot = s?.proofSlot;
    const stamped = slot === 0 || slot === 1 || slot === '0' || slot === '1';
    return {
      noteCommit: nc,
      nonce: s?.nonce,
      lz: s?.lz,
      viewTag: s?.viewTag,
      ...(bits != null && bits !== '' ? { shareBits: bits } : {}),
      ...(stamped ? { proofSlot: Number(slot) } : {}),
    };
  }
  return { dest20, nonce: s?.nonce, lz: s?.lz };
}

/** Count + length-prefixed v5 (or v4) frames. Not a JSON share array. */
export function packShareBatchBytes(shares = []) {
  const frames = packShareBatch((Array.isArray(shares) ? shares : []).map(shareForPack));
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(frames.length, 0);
  for (const frame of frames) {
    const len = Buffer.alloc(2);
    if (frame.length > 0xffff) throw new Error('share_frame');
    len.writeUInt16LE(frame.length, 0);
    parts.push(len, frame);
  }
  return Buffer.concat(parts);
}

/** Dual-read: a leading `[` is a legacy JSON share array. Otherwise packed frames. */
export function unpackShareBatchBytes(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!b.length) return [];
  if (b[0] === 0x5b) {
    try { return JSON.parse(b.toString()); } catch { return []; }
  }
  if (b.length < 4) return [];
  const n = b.readUInt32LE(0);
  const out = [];
  let o = 4;
  for (let i = 0; i < n && o + 2 <= b.length; i += 1) {
    const len = b.readUInt16LE(o);
    o += 2;
    if (len < 1 || o + len > b.length) break;
    const frame = b.subarray(o, o + len);
    o += len;
    const type = frame[ENC_MAGIC.length];
    out.push(unpackShareFrame(frame));
  }
  return out;
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
  let nc = null;
  if (s?.noteCommit) {
    if (typeof s.noteCommit === 'string' && /^[0-9a-fA-F]{64}$/.test(s.noteCommit)) {
      nc = Buffer.from(s.noteCommit, 'hex');
    } else {
      const raw = Buffer.from(s.noteCommit);
      if (raw.length === 32) nc = raw;
    }
  }
  if (!nc && dest20 && !dest20.equals(Buffer.alloc(20))) {
    nc = noteCommitOfDest20(dest20);
  }
  const tag = s?.viewTag != null && s.viewTag !== ''
    ? (Buffer.isBuffer(s.viewTag) ? s.viewTag : Buffer.from([Number(s.viewTag) & 0xff]))
    : null;
  return {
    noteCommit: nc ? nc.toString('hex') : '',
    nonce: String(s?.nonce ?? 0),
    lz: Number(s?.lz || 0) & 0xff,
    ...(tag ? { viewTag: tag.subarray(0, 1).toString('hex') } : {}),
    ...(s?.shareBits != null && s.shareBits !== '' ? { shareBits: Number(s.shareBits) } : {}),
  };
}

function unpackShareFrame(buf) {
  const type = buf[ENC_MAGIC.length];
  if (type === ENC_SHARE_V5) return unpackShareV5(buf);
  if (type === ENC_SHARE_WORK) return unpackShareWork(buf);
  return unpackShare(buf);
}

export function unpackShareBatch(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((s) => {
    if (Buffer.isBuffer(s) || typeof s === 'string') {
      return unpackShareFrame(Buffer.from(s));
    }
    const dest = String(s.dest || s.address || s.miner || '');
    let nc;
    if (s.noteCommit) {
      nc = typeof s.noteCommit === 'string'
        ? Buffer.from(s.noteCommit, /^[0-9a-fA-F]+$/.test(s.noteCommit) ? 'hex' : 'utf8')
        : Buffer.from(s.noteCommit);
    }
    const row = {
      dest20: coerceDest20(s.dest20, dest),
      dest,
      noteCommit: nc && nc.length === 32 ? nc : undefined,
      nonce: typeof s.nonce === 'bigint' ? s.nonce : BigInt(s.nonce || 0),
      lz: Number(s.lz || 0) & 0xff,
      viewTag: s.viewTag || null,
    };
    // In-memory selection keeps the parent binding. A work frame also carries
    // proofSlot, and the coinbase shareSlotRoot commits that byte.
    if (s.verifiedHeader) row.verifiedHeader = s.verifiedHeader;
    if (s.shareBits != null && s.shareBits !== '') row.shareBits = Number(s.shareBits);
    else if (s.creditedShareBits != null && s.creditedShareBits !== '') {
      row.shareBits = Number(s.creditedShareBits);
    }
    if (s.jobId) row.jobId = String(s.jobId);
    if (s.hash) row.hash = s.hash;
    if (s.proofSlot === 0 || s.proofSlot === 1 || s.proofSlot === '0' || s.proofSlot === '1') {
      row.proofSlot = Number(s.proofSlot);
    }
    return row;
  });
}
