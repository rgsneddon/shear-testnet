import { parentPort } from 'node:worker_threads';
import { shearHash } from '../../crypto/shear_hash.js';

parentPort.on('message', (msg) => {
  const id = msg?.id;
  try {
    const raw = msg?.headerHex != null ? Buffer.from(String(msg.headerHex), 'hex') : Buffer.from(msg.header || []);
    const hash = shearHash(raw);
    parentPort.postMessage({ id, ok: true, hash: Buffer.from(hash) });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
});
