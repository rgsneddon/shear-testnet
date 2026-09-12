/**
 * EIP-712 PoolWithdraw. chainId 2701. she1 never in the mined body.
 * Digest is keccak("\x19\x01" || domainSeparator || structHash).
 * secp256k1 signature is 65-byte compact r||s||v (v = 27/28).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const EIP712_CHAIN_ID = 2701;
export const EIP712_NAME = 'ShearPool';
export const EIP712_VERSION = '1';
export const EIP712_PRIMARY = 'PoolWithdraw';
export const EIP712_CHAIN_MAGIC = 'shear-testnet-v3';
export const POOL_WITHDRAW_DEADLINE_MS = 2 * 3600_000;

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

export function poolWithdrawDigest({
  login,
  dest,
  nanos,
  minerShe1,
  payoutSsa1,
  height = 0,
  nonce = 0,
  deadline = 0,
  verifyingContract = Buffer.alloc(20),
  chainId = EIP712_CHAIN_MAGIC,
} = {}) {
  const she = String(minerShe1 || login || '');
  const payout = String(payoutSsa1 || dest || '');
  const domainType = typeHash('EIP712Domain(string name,string version,string chainId,address verifyingContract)');
  const contract = Buffer.from(verifyingContract || Buffer.alloc(20));
  const domainSep = keccak(Buffer.concat([
    domainType,
    hashString(EIP712_NAME),
    hashString(EIP712_VERSION),
    hashString(chainId || EIP712_CHAIN_MAGIC),
    pad32(contract.length === 20 ? contract : Buffer.alloc(20)),
  ]));
  const msgType = typeHash('PoolWithdraw(string minerShe1,string payoutSsa1,uint256 nanos,uint256 height,uint256 nonce,uint256 deadline)');
  const structHash = keccak(Buffer.concat([
    msgType,
    hashString(she),
    hashString(payout),
    encodeUint(Math.max(0, Math.floor(Number(nanos) || 0))),
    encodeUint(Math.max(0, Math.floor(Number(height) || 0))),
    encodeUint(Math.max(0, Math.floor(Number(nonce) || 0))),
    encodeUint(Math.max(0, Math.floor(Number(deadline) || 0))),
  ]));
  return keccak(Buffer.concat([Buffer.from([0x19, 0x01]), domainSep, structHash]));
}

export function evmPrivFromSeed(seed) {
  const raw = Buffer.isBuffer(seed) ? seed : Buffer.from(String(seed), 'hex');
  return Buffer.from(sha256(Buffer.concat([Buffer.from('shear-evm-secp-v1'), raw])));
}

/** 33-byte compressed pub || 64-byte compact sig || 1-byte v(27/28). */
export function signPoolWithdraw(fields = {}) {
  const digest = poolWithdrawDigest(fields);
  const priv = evmPrivFromSeed(fields.seed);
  const pub = secp256k1.getPublicKey(priv, true);
  const rec = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' });
  const u8 = rec instanceof Uint8Array ? rec : rec.toBytes('recovered');
  const recBit = u8[0] & 1;
  const compact = Buffer.from(u8.subarray(1));
  return Buffer.concat([Buffer.from(pub), compact, Buffer.from([27 + recBit])]).toString('hex');
}

export function recoverPoolWithdrawPub(sig) {
  const raw = String(sig || '').trim();
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-f]{196}$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex').subarray(0, 33);
}

export function ownerSecpPubFromSeed(seed) {
  return Buffer.from(secp256k1.getPublicKey(evmPrivFromSeed(seed), true));
}

/** Spend-pub from dest opening → same secp owner as signPoolWithdraw({ seed: spendPub }). */
export function ownerPubFromOpening(open) {
  const hex = String(open || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{128}$/i.test(hex)) return null;
  return ownerSecpPubFromSeed(Buffer.from(hex, 'hex').subarray(32, 64));
}

export function verifyPoolWithdrawSig(fields = {}) {
  const raw = String(fields.sig || '').trim();
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-f]{196}$/i.test(hex)) return false;
  const buf = Buffer.from(hex, 'hex');
  const pub = buf.subarray(0, 33);
  const compact = buf.subarray(33, 97);
  const v = buf[97];
  if (v !== 27 && v !== 28) return false;
  try {
    const digest = poolWithdrawDigest(fields);
    return secp256k1.verify(compact, digest, pub, { prehash: false, format: 'compact' });
  } catch {
    return false;
  }
}
