/**
 * Pool operator dest on disk. The public pool is an adversary.
 * Disk is dest20 only. viewKey/paymentCode/spend/open/seed are leaked — rotate.
 * Abuse-control IPs never live in this file.
 */
import fs from 'node:fs';
import { hash20FromAddress, newIdentity, isShearAddress, isDestAddress, encodeDest } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

const FORBIDDEN = ['viewKey', 'paymentCode', 'spend', 'open', 'privateKey', 'seed', 'ip', 'userAgent'];

export function poolIdentLeaked(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return FORBIDDEN.some((k) => Object.prototype.hasOwnProperty.call(obj, k) && obj[k]);
}

export function writePoolIdent(file, { dest20 } = {}) {
  const buf = Buffer.isBuffer(dest20) ? dest20 : Buffer.from(dest20 || []);
  if (buf.length !== 20) throw new TypeError('dest20');
  const rec = { dest20: buf.toString('hex') };
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
  if (existing && existing.dest20 && existing.dest20.length === 20 && existing.miner) return existing;
  const ident = newIdentity();
  const dest = destForLogin(ident.address, { viewKey: ident.viewKey, height: 1 });
  if (!dest || !isDestAddress(dest)) throw new Error('pool_ident_dest');
  const dest20 = hash20FromAddress(dest);
  if (!dest20 || dest20.length !== 20) throw new Error('pool_ident_dest20');
  writePoolIdent(file, { dest20 });
  return { dest20, miner: dest, rotated: false, leaked: false };
}
