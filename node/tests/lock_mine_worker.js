import { setNonce } from '../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';

const headerHex = process.argv[2];
const bits = Number(process.argv[3]);
const start = BigInt(process.argv[4] || '0');
const stride = BigInt(process.argv[5] || '1');
setHashBackend('jit-full');
const base = Buffer.from(headerHex, 'hex');
for (let i = 0n; i < 8_000_000n; i += 1n) {
  const n = start + i * stride;
  const header = setNonce(base, n);
  const hash = shearHash(header);
  if (meetsTarget(hash, bits)) {
    process.stdout.write(`FOUND ${n.toString()} ${hash.toString('hex')}\n`);
    process.exit(0);
  }
}
process.stdout.write('MISS\n');
process.exit(2);
