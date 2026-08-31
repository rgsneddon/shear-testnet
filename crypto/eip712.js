/**
 * EIP-712 PoolWithdraw. chainId 2701. she1 never in the mined body.
 * Digest is keccak("\x19\x01" || domainSeparator || structHash).
 * secp256k1 signature is 65-byte compact r||s||v (v = 27/28).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const EIP712_CHAIN_ID = 2701;
export const EIP712_NAME = 'Shear';
export const EIP712_VERSION = '1';
export const EIP712_PRIMARY = 'PoolWithdraw';

function keccak(data) {
  return Buffer.from(keccak_256(data));
}

function pad32(buf) {
  const out = Buffer.alloc(32);
  Buffer.from(buf).copy(out, 32 - buf.length);
  return out;
}

function encodeUint(n) {
  const hex = BigInt(n).toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

function typeHash(s) {
  return keccak(Buffer.from(s, 'utf8'));
}

function hashString(s) {
  return keccak(Buffer.from(String(s), 'utf8'));
}

export function poolWithdrawDigest({ login, dest, nanos } = {}) {
  const domainType = typeHash('EIP712Domain(string name,string version,uint256 chainId)');
  const domainSep = keccak(Buffer.concat([
    domainType,
    hashString(EIP712_NAME),
    hashString(EIP712_VERSION),
    encodeUint(EIP712_CHAIN_ID),
  ]));
  const msgType = typeHash('PoolWithdraw(string login,string dest,uint256 nanos)');
  const structHash = keccak(Buffer.concat([
    msgType,
    hashString(login),
    hashString(dest),
    encodeUint(Math.max(0, Math.floor(Number(nanos) || 0))),
  ]));
  return keccak(Buffer.concat([Buffer.from([0x19, 0x01]), domainSep, structHash]));
}

export function evmPrivFromSeed(seed) {
  const raw = Buffer.isBuffer(seed) ? seed : Buffer.from(String(seed), 'hex');
  return Buffer.from(sha256(Buffer.concat([Buffer.from('shear-evm-secp-v1'), raw])));
}

/** 33-byte compressed pub || 64-byte compact sig || 1-byte v(27/28). */
export function signPoolWithdraw({ seed, login, dest, nanos } = {}) {
  const digest = poolWithdrawDigest({ login, dest, nanos });
  const priv = evmPrivFromSeed(seed);
  const pub = secp256k1.getPublicKey(priv, true);
  const rec = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' });
  const u8 = rec instanceof Uint8Array ? rec : rec.toBytes('recovered');
  const recBit = u8[0] & 1;
  const compact = Buffer.from(u8.subarray(1));
  return Buffer.concat([Buffer.from(pub), compact, Buffer.from([27 + recBit])]).toString('hex');
}

export function verifyPoolWithdrawSig({ login, dest, nanos, sig } = {}) {
  const raw = String(sig || '').trim();
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-f]{196}$/i.test(hex)) return false;
  const buf = Buffer.from(hex, 'hex');
  const pub = buf.subarray(0, 33);
  const compact = buf.subarray(33, 97);
  const v = buf[97];
  if (v !== 27 && v !== 28) return false;
  try {
    const digest = poolWithdrawDigest({ login, dest, nanos });
    return secp256k1.verify(compact, digest, pub, { prehash: false, format: 'compact' });
  } catch {
    return false;
  }
}
