import { shearHash, setHashBackend, meetsTarget } from '../../crypto/shear_hash.js';
import { setNonce, headerFromHex } from '../../crypto/header.js';

// One process per searcher. The native hasher is process-global, and
// sharing it across Node worker threads died with 0xC0000005.
setHashBackend('jit');

const data = JSON.parse(process.argv[2]);
const bits = Number(data.bits);
const step = BigInt(data.step);
const cap = BigInt(data.cap);
const skip = new Set((data.skip || []).map((x) => String(x)));
const base = headerFromHex(data.headerHex);

function finish(msg) {
  if (typeof process.send === 'function') {
    process.send(msg, () => process.exit(0));
    return;
  }
  process.exit(msg ? 0 : 2);
}

function seek() {
  for (let i = BigInt(data.start); i < cap; i += step) {
    if (skip.has(String(i))) continue;
    const header = setNonce(base, i);
    const hash = shearHash(header);
    if (meetsTarget(hash, bits)) {
      finish({
        nonce: i.toString(),
        hash: Buffer.from(hash).toString('hex'),
      });
      return;
    }
  }
  finish(null);
}
seek();
