// One stripe of a genesis search, in its own process so RandomX globals
// are not shared. Nonces are start, start+step, start+2*step.
import fs from 'node:fs';
import { setNonce } from '../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';

const [headerHex, bitsRaw, nonceStartRaw, stepRaw, maxTriesRaw, outPath, stopPath, donePath] = process.argv.slice(2);
try {
  const backend = setHashBackend('jit');
  if (backend !== 'jit') {
    fs.writeFileSync(`${outPath}.${process.pid}`, JSON.stringify({ error: `admit miner needs jit, got ${backend}` }));
  } else {
  const header0 = Buffer.from(headerHex, 'hex');
  const bits = Number(bitsRaw);
  const start = BigInt(nonceStartRaw);
  const step = BigInt(stepRaw);
  const maxTries = BigInt(maxTriesRaw);
  for (let i = 0n; i < maxTries; i += 1n) {
    if ((i & 63n) === 0n && stopPath && fs.existsSync(stopPath)) break;
    const nonce = start + i * step;
    const header = setNonce(header0, nonce);
    const hash = shearHash(header);
    if (!meetsTarget(hash, bits)) continue;
    const hitPath = `${outPath}.${process.pid}`;
    fs.writeFileSync(hitPath, JSON.stringify({
      header: header.toString('hex'),
      hash: hash.toString('hex'),
    }));
    break;
  }
  }
} finally {
  if (donePath) fs.writeFileSync(donePath, '1');
}
