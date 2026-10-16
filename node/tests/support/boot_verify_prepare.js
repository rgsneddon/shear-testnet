/**
 * Load shearadmit before boot-verify cases import note.js.
 * A missing addon makes verifyRange fail closed, so a public v12 coinbase
 * is coinbase_output on the main thread and in the worker. The packed-proof
 * fallback is only for a machine that cannot produce the addon.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const addon = path.join(root, 'crypto/native/shearadmit.node');

function loadAddon() {
  if (!fs.existsSync(addon)) return false;
  try {
    return !!require(addon);
  } catch {
    return false;
  }
}

let nativeOk = loadAddon();
if (!nativeOk) {
  try {
    execFileSync('make', ['-C', path.join(root, 'crypto/native'), 'shearadmit.node'], {
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    console.error(`shearadmit.node build failed: ${err?.message || err}`);
  }
  try { delete require.cache[require.resolve(addon)]; } catch { /* not cached */ }
  nativeOk = loadAddon();
}

if (nativeOk) {
  console.error('boot-verify: shearadmit.node loaded');
} else {
  process.env.SHEAR_RANGE_JS = '1';
  console.error('boot-verify: shearadmit.node is not loaded; public coinbase proofs use SHEAR_RANGE_JS=1');
}
