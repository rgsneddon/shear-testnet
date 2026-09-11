/**
 * Pool operator dest on disk. The public pool is an adversary.
 * Disk is dest20 only. viewKey/paymentCode/spend/open/seed are leaked — rotate.
 * Abuse-control IPs never live in this file.
 */
import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { hash20FromAddress, newIdentity, isShearAddress, isDestAddress, encodeDest, silentDestFromCode } from '../../crypto/address.js';

const FORBIDDEN = ['viewKey', 'paymentCode', 'spend', 'open', 'privateKey', 'seed', 'ip', 'userAgent'];

export function poolIdentLeaked(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return FORBIDDEN.some((k) => Object.prototype.hasOwnProperty.call(obj, k) && obj[k]);
}

export function writePoolIdent(file, { dest20 } = {}) {
  const rec = {
    dest20: Buffer.from(dest20).toString('hex'),
  };
  fs.writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
  return rec;
}

export function readPoolIdent(file) {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (poolIdentLeaked(raw)) {
    const dest = (raw.address && !isShearAddress(raw.address) && isDestAddress(raw.address))
      ? raw.address
      : '';
    let dest20 = hash20FromAddress(dest);
    if (!dest20 && raw.dest20) dest20 = Buffer.from(String(raw.dest20), 'hex');
    if (!dest20 || dest20.length !== 20) dest20 = Buffer.alloc(20);
    writePoolIdent(file, { dest20 });
    return { dest20, miner: dest20.length === 20 ? encodeDest(dest20) : '', rotated: true, leaked: true };
  }
  const dest20 = Buffer.from(String(raw.dest20 || ''), 'hex');
  const miner = dest20.length === 20 ? encodeDest(dest20) : '';
  return { dest20, miner, rotated: false, leaked: false };
}

export function loadOrCreatePoolIdent(file) {
  const existing = readPoolIdent(file);
  if (existing && existing.dest20 && existing.dest20.length === 20) return existing;
  const ident = newIdentity();
  const { privateKey } = generateKeyPairSync('x25519');
  const dest = silentDestFromCode(ident.paymentCode, privateKey);
  const dest20 = hash20FromAddress(dest);
  writePoolIdent(file, { dest20 });
  return { dest20, miner: dest, rotated: false, leaked: false };
}
