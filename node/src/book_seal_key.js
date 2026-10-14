/**
 * Per-install book.seal key. The file is outside the datadir, keyed by the
 * datadir path, so a copied chain.bin plus book.seal does not carry it.
 * SHEAR_SEAL_KEY_DIR relocates that directory. It is not a second datadir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export function bookSealKeyDir() {
  const fromEnv = String(process.env.SHEAR_SEAL_KEY_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.shear', 'book-seal-keys');
}

export function bookSealKeyPath(dataDir) {
  const id = createHash('sha256').update(path.resolve(String(dataDir))).digest('hex');
  return path.join(bookSealKeyDir(), id);
}

/** 32-byte secret for this datadir. Created on first open. */
export function bookSealKeyFor(dataDir) {
  const file = bookSealKeyPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const got = fs.readFileSync(file);
    if (got.length !== 32) throw new Error('seal_key');
    return got;
  }
  const key = randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}
