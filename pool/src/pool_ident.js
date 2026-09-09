/**
 * Pool operator dest on disk. Secrets never sit in pool-miner.json plaintext.
 * Treat a file that still has viewKey/paymentCode/spend/open as leaked and rotate.
 */
import fs from 'node:fs';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { hash20FromAddress, payoutDest, newIdentity, isShearAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

const FORBIDDEN = ['viewKey', 'paymentCode', 'spend', 'open', 'privateKey', 'seed'];

function wrapKey() {
  const secret = process.env.SHEAR_POOL_SECRET || '';
  return createHash('sha256').update('shear-pool-ident-v1').update(secret).digest();
}

function encryptBlob(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', wrapKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decryptBlob(b64) {
  const raw = Buffer.from(String(b64 || ''), 'base64');
  if (raw.length < 28) throw new Error('ident_blob');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = createDecipheriv('aes-256-gcm', wrapKey(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

export function poolIdentLeaked(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return FORBIDDEN.some((k) => Object.prototype.hasOwnProperty.call(obj, k) && obj[k]);
}

export function writePoolIdent(file, { dest20, paymentCode } = {}) {
  const rec = {
    dest20: Buffer.from(dest20).toString('hex'),
    enc: encryptBlob({ paymentCode: paymentCode || '' }),
  };
  fs.writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
  return rec;
}

export function readPoolIdent(file) {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (poolIdentLeaked(raw)) {
    const dest = payoutDest(raw.paymentCode)
      || (raw.address && !isShearAddress(raw.address) ? raw.address : '')
      || destForLogin(raw.address || '', { viewKey: raw.viewKey, height: 1 });
    const dest20 = hash20FromAddress(dest) || Buffer.alloc(20);
    writePoolIdent(file, { dest20, paymentCode: '' });
    return { dest20, miner: dest, rotated: true, leaked: true };
  }
  const dest20 = Buffer.from(String(raw.dest20 || ''), 'hex');
  let paymentCode = '';
  try {
    paymentCode = decryptBlob(raw.enc).paymentCode || '';
  } catch {
    paymentCode = '';
  }
  return { dest20, paymentCode, miner: payoutDest(paymentCode) || '', rotated: false, leaked: false };
}

export function loadOrCreatePoolIdent(file) {
  const existing = readPoolIdent(file);
  if (existing && existing.dest20 && existing.dest20.length === 20) return existing;
  const ident = newIdentity();
  const dest = payoutDest(ident.paymentCode)
    || destForLogin(ident.address, { viewKey: ident.viewKey, height: 1 });
  const dest20 = hash20FromAddress(dest);
  writePoolIdent(file, { dest20, paymentCode: ident.paymentCode });
  return { dest20, paymentCode: ident.paymentCode, miner: dest, rotated: false, leaked: false };
}
