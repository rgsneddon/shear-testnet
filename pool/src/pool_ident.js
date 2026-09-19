/**
 * Pool operator dest on disk. The public pool is an adversary.
 * Disk is dest20 only. viewKey/paymentCode/spend/open/seed are leaked — rotate.
 * Abuse-control IPs never live in this file.
 * Operator spend seed lives in pool-spend.seed (0600) or SHEAR_POOL_SPEND_SEED.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  hash20FromAddress,
  isShearAddress,
  isDestAddress,
  encodeDest,
  ed25519PrivateFromSeed,
  ed25519RawPub,
  spendDestOf,
} from '../../crypto/address.js';

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

export const POOL_SPEND_SEED_FILE = 'pool-spend.seed';

export function operatorKeyFromSeed(seed) {
  let raw;
  try {
    raw = Buffer.isBuffer(seed) ? seed : Buffer.from(String(seed).replace(/^0x/i, ''), 'hex');
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  try {
    const key = ed25519PrivateFromSeed(raw);
    const dest = spendDestOf(ed25519RawPub(key));
    if (!dest || !isDestAddress(dest)) return null;
    return { key, dest, seed: raw };
  } catch {
    return null;
  }
}

export function writeOperatorSpendSeed(file, seed) {
  const op = operatorKeyFromSeed(seed);
  if (!op) throw new TypeError('seed');
  fs.writeFileSync(file, `${op.seed.toString('hex')}\n`, { mode: 0o600 });
  return op;
}

export function loadOperatorSpendKey({ dataDir, env = process.env } = {}) {
  const fromEnv = String(env.SHEAR_POOL_SPEND_SEED || env.SHEAR_POOL_SPEND_KEY || '').replace(/^0x/i, '').trim();
  let hex = fromEnv.split(/\s+/)[0] || '';
  const file = dataDir ? path.join(dataDir, POOL_SPEND_SEED_FILE) : '';
  if (!/^[0-9a-f]{64}$/i.test(hex) && file && fs.existsSync(file)) {
    hex = fs.readFileSync(file, 'utf8').replace(/^0x/i, '').trim().split(/\s+/)[0];
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return operatorKeyFromSeed(hex);
}

function dest20Equal(a, b) {
  const ha = typeof a === 'string' && a.startsWith('ssa') ? hash20FromAddress(a) : Buffer.from(a || []);
  const hb = typeof b === 'string' && b.startsWith('ssa') ? hash20FromAddress(b) : Buffer.from(b || []);
  if (!ha || !hb || ha.length !== 20 || hb.length !== 20) return false;
  return Buffer.from(ha).equals(Buffer.from(hb));
}

/** Shipped boot path: ident dest20 + operator spend key that matches it. */
export function bootPoolOperator({ dataDir, minerEnv, env = process.env } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const identPath = path.join(dataDir, 'pool-miner.json');
  let miner = String(minerEnv != null ? minerEnv : (env.SHEAR_POOL_MINER || '')).trim();
  if (!miner) {
    const ident = loadOrCreatePoolIdent(identPath);
    miner = ident.miner;
  }
  const op = loadOperatorSpendKey({ dataDir, env });
  const matched = !!(op && miner && dest20Equal(op.dest, miner));
  return {
    miner,
    dest: miner,
    operatorSpendKey: matched ? op.key : null,
    signed: matched,
  };
}

export function loadOrCreatePoolIdent(file) {
  const existing = readPoolIdent(file);
  if (existing && existing.dest20 && existing.dest20.length === 20 && existing.miner) return existing;
  const seed = randomBytes(32);
  const op = operatorKeyFromSeed(seed);
  if (!op) throw new Error('pool_ident_dest');
  const dest20 = hash20FromAddress(op.dest);
  if (!dest20 || dest20.length !== 20) throw new Error('pool_ident_dest20');
  writePoolIdent(file, { dest20 });
  writeOperatorSpendSeed(path.join(path.dirname(file), POOL_SPEND_SEED_FILE), seed);
  return { dest20, miner: op.dest, rotated: false, leaked: false };
}
