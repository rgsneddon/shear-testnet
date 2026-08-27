import { HEADER_LEN } from './shear_hash.js';

export const VERSION = 1;

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u64le(n) {
  const b = Buffer.alloc(8);
  const v = BigInt(n);
  b.writeBigUInt64LE(v, 0);
  return b;
}

function need32(buf, name) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return b;
}

export function encodeHeader({
  version = VERSION,
  prevBlockHash,
  merkleRoot,
  continuityRoot,
  timestamp,
  bits,
  nonce = 0n,
  baseFee = 1n,
} = {}) {
  const parts = [
    u32le(version),
    need32(prevBlockHash, 'prevBlockHash'),
    need32(merkleRoot, 'merkleRoot'),
    need32(continuityRoot, 'continuityRoot'),
    u64le(timestamp),
    u32le(bits),
    u64le(nonce),
    u64le(baseFee ?? 1),
  ];
  const out = Buffer.concat(parts);
  if (out.length !== HEADER_LEN) throw new Error(`packed header ${out.length}`);
  return out;
}

export function decodeHeader(buf) {
  const h = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (h.length !== HEADER_LEN) throw new Error(`header must be ${HEADER_LEN} bytes`);
  return {
    version: h.readUInt32LE(0),
    prevBlockHash: Buffer.from(h.subarray(4, 36)),
    merkleRoot: Buffer.from(h.subarray(36, 68)),
    continuityRoot: Buffer.from(h.subarray(68, 100)),
    timestamp: h.readBigUInt64LE(100),
    bits: h.readUInt32LE(108),
    nonce: h.readBigUInt64LE(112),
    baseFee: h.readBigUInt64LE(120),
  };
}

export function setNonce(header, nonce) {
  const h = Buffer.from(header);
  u64le(nonce).copy(h, 112);
  return h;
}

export function headerHex(header) {
  return Buffer.from(header).toString('hex');
}

export function headerFromHex(hex) {
  const h = Buffer.from(String(hex), 'hex');
  if (h.length !== HEADER_LEN) throw new Error('bad header hex');
  return h;
}

export function requiredJobFields(job) {
  const need = [
    'jobId',
    'height',
    'version',
    'prevBlockHash',
    'merkleRoot',
    'continuityRoot',
    'timestamp',
    'bits',
    'shareBits',
    'blockBits',
    'header',
    'nonce',
    'baseFee',
  ];
  const missing = need.filter((k) => job?.[k] == null || job[k] === '');
  return { ok: missing.length === 0, missing };
}
