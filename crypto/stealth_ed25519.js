/**
 * One-time Ed25519 spend keys for stealth dests.
 * dest20 = SHA256(shear-silent-v1 || oneTimeSpendPub)[0:20]
 * oneTimeSpendPub = longTermSpendPub + H(shear-stealth-tweak-v1 || shared) * G
 * Sender can compute dest20; only the recipient knows the tweaked scalar.
 */
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

const L = ed25519.CURVE.n;
const TWEAK_DOM = Buffer.from('shear-stealth-tweak-v1');
export const DEST_COMMIT_DOM = Buffer.from('shear-silent-v1');

function leToBig(buf) {
  const b = Buffer.from(buf);
  let n = 0n;
  for (let i = 0; i < b.length; i += 1) n |= BigInt(b[i]) << (8n * BigInt(i));
  return n;
}

function bigToLe32(n) {
  const out = Buffer.alloc(32);
  let x = ((n % L) + L) % L;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function stealthTweakScalar(shared) {
  const h = createHash('sha256').update(TWEAK_DOM).update(Buffer.from(shared)).digest();
  return leToBig(h) % L;
}

export function destCommitFromSpendPub(spendPub) {
  const pub = Buffer.from(spendPub || []);
  if (pub.length !== 32) return null;
  return createHash('sha256').update(DEST_COMMIT_DOM).update(pub).digest().subarray(0, 20);
}

export function stealthSpendPubFrom(longTermSpendPub, shared) {
  const t = stealthTweakScalar(shared);
  const P = ed25519.Point.fromBytes(Uint8Array.from(Buffer.from(longTermSpendPub)));
  const Q = P.add(ed25519.Point.BASE.multiply(t));
  return Buffer.from(Q.toBytes());
}

export function stealthSign(spendSeed32, shared, message) {
  const seed = Uint8Array.from(Buffer.from(spendSeed32));
  const ext = ed25519.utils.getExtendedPublicKey(seed);
  const t = stealthTweakScalar(shared);
  const scalar = (ext.scalar + t) % L;
  const pub = stealthSpendPubFrom(ext.pointBytes, shared);
  const msg = Uint8Array.from(Buffer.from(message));
  const rHash = sha512(Buffer.concat([Buffer.from(ext.prefix), Buffer.from(msg)]));
  const r = leToBig(rHash) % L;
  const R = ed25519.Point.BASE.multiply(r);
  const Rb = Buffer.from(R.toBytes());
  const kHash = sha512(Buffer.concat([Rb, pub, Buffer.from(msg)]));
  const k = leToBig(kHash) % L;
  const S = (r + k * scalar) % L;
  return Buffer.concat([Rb, bigToLe32(S)]);
}

export function stealthKey(shared, spendSeed32) {
  return {
    type: 'ed25519-stealth',
    shared: Buffer.from(shared),
    seed: Buffer.from(spendSeed32),
  };
}

export function isStealthKey(k) {
  return k && k.type === 'ed25519-stealth' && k.shared && k.seed;
}
