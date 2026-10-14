/**
 * Nonce search for the foreign-load test. jit-full is the 2 GiB dataset.
 * The parent re-hashes every hit with the light verifier before it trusts it.
 * Same ShearHash-v3 digest either way.
 */
import { setHashBackend, shearHash, meetsTarget } from '../../crypto/shear_hash.js';
import { setNonce } from '../../crypto/header.js';

const headerHex = process.argv[2];
const bits = Number(process.argv[3]);
const max = BigInt(process.argv[4] || '4000000');
const backend = setHashBackend('jit-full');
const base = Buffer.from(headerHex, 'hex');
const t0 = Date.now();
process.stderr.write(`backend ${backend}\n`);
for (let i = 0n; i < max; i += 1n) {
  const header = setNonce(base, i);
  const hash = shearHash(header);
  if (meetsTarget(hash, bits)) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      nonce: i.toString(),
      hash: Buffer.from(hash).toString('hex'),
      ms: Date.now() - t0,
      backend,
    })}\n`);
    process.exit(0);
  }
  if (i > 0n && i % 10000n === 0n) {
    process.stderr.write(`tried ${i} ms ${Date.now() - t0}\n`);
  }
}
process.stdout.write(`${JSON.stringify({ ok: false, ms: Date.now() - t0, backend })}\n`);
process.exit(2);
