import { parentPort } from 'node:worker_threads';
import { setHashBackend, shearHash } from './shear_hash.js';

const backend = String(process.env.SHEAR_HASH_BACKEND || '').trim();
if (backend) {
  try { setHashBackend(backend); } catch { /* interpreter stays */ }
}

// Real ShearHash-v3. The parent counts in-flight calls around this message.
parentPort.on('message', (msg) => {
  const id = msg?.id;
  try {
    const raw = Buffer.from(String(msg?.headerHex || ''), 'hex');
    parentPort.postMessage({ id, phase: 'start' });
    const hash = shearHash(raw);
    parentPort.postMessage({ id, phase: 'done', ok: true, hash: Buffer.from(hash) });
  } catch (e) {
    parentPort.postMessage({
      id,
      phase: 'done',
      ok: false,
      error: String(e?.message || e),
    });
  }
});
