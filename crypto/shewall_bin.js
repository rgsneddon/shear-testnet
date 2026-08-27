/**
 * Packed shewall.bin (not JSON, not wallet.dat).
 * Body is shear-enc-v1 style records; encryption wraps the packed bytes.
 */
import { createHash, randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { ENC_MAGIC } from './pack.js';
import { u64le } from './pack.js';

export const SHEWALL_KIND = 'shear-shewall-bin-v1';
export const SHEWALL_FILE = 'shewall.bin';
export const SHEWALL_ENC_KIND = 'shear-shewall-bin-v1-enc';

export function packShewall({ seed32, dest20, spendableNanos = 0, pendingNanos = 0 } = {}) {
  const seed = Buffer.from(seed32);
  if (seed.length !== 32) throw new Error('seed32');
  const dest = Buffer.from(dest20);
  if (dest.length !== 20) throw new Error('dest20');
  return Buffer.concat([
    ENC_MAGIC,
    Buffer.from([0x77]),
    seed,
    dest,
    u64le(spendableNanos),
    u64le(pendingNanos),
  ]);
}

export function unpackShewall(buf) {
  const b = Buffer.from(buf);
  if (b.length < 13 + 32 + 20 + 16 || !b.subarray(0, 12).equals(ENC_MAGIC) || b[12] !== 0x77) {
    throw new Error('not_shewall_bin');
  }
  if (b.length >= 4 && b.subarray(0, 4).toString() === '{') throw new Error('json_refused');
  return {
    seed32: Buffer.from(b.subarray(13, 45)),
    dest20: Buffer.from(b.subarray(45, 65)),
    spendableNanos: b.readBigUInt64LE(65),
    pendingNanos: b.readBigUInt64LE(73),
  };
}

export function sealShewallBin(packed, password) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = pbkdf2Sync(String(password), salt, 100000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(packed)), cipher.final()]);
  const mac = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(SHEWALL_ENC_KIND),
    salt,
    nonce,
    mac,
    ct,
  ]);
}

export function openShewallBin(env, password) {
  const b = Buffer.from(env);
  const prefix = Buffer.from(SHEWALL_ENC_KIND);
  if (b.length < prefix.length + 16 + 12 + 16) throw new Error('not_shewall_bin');
  if (!b.subarray(0, prefix.length).equals(prefix)) {
    if (b.subarray(0, 1).toString() === '{') throw new Error('json_refused');
    throw new Error('not_shewall_bin');
  }
  let o = prefix.length;
  const salt = b.subarray(o, o + 16); o += 16;
  const nonce = b.subarray(o, o + 12); o += 12;
  const mac = b.subarray(o, o + 16); o += 16;
  const ct = b.subarray(o);
  const key = pbkdf2Sync(String(password), salt, 100000, 32, 'sha256');
  const dec = createDecipheriv('aes-256-gcm', key, nonce);
  dec.setAuthTag(mac);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

export function shewallDigest(packed) {
  return createHash('sha256').update(packed).digest();
}
