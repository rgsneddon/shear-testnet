// A real, mined, linking regtest header chain for the on-device walk-frames
// test (Russell, 28 Oct). Each header's parent link is the ShearHash-v3
// digest of the one before (the node's own crypto/shear_hash.js), and each
// meets the 4-bit regtest floor. Headers are appended as they are mined, so
// the run can stop at any depth and every prefix is a valid chain.
//
//   node wallet/tool/gen_walk_chain.mjs <out.bin> [maxHeaders]
//
// out.bin is 128-byte headers, height 1 first. The last header's digest is
// the pin the walk links down from; the test reads it by hashing.
import fs from 'node:fs';
import { encodeHeader } from '../../crypto/header.js';
import { EMPTY_ROOT } from '../../crypto/merkle.js';
import { shearHash, meetsTarget, setHashBackend } from '../../crypto/shear_hash.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }
const out = process.argv[2];
const max = Math.max(1, Math.floor(Number(process.argv[3]) || 20000));
if (!out) {
  process.stderr.write('usage: gen_walk_chain.mjs <out.bin> [maxHeaders]\n');
  process.exit(2);
}
const BITS = 4 * 65536;
const T0 = 1_700_000_000_000;
let prev = Buffer.alloc(32);
let height = 0;
if (fs.existsSync(out)) {
  // Resume: re-hash the last header to get its digest.
  const all = fs.readFileSync(out);
  height = Math.floor(all.length / 128);
  if (height > 0) prev = shearHash(all.subarray((height - 1) * 128, height * 128));
}
const fd = fs.openSync(out, 'a');
const started = Date.now();
while (height < max) {
  const h = height + 1;
  let nonce = 0n;
  let header;
  let digest;
  for (;;) {
    header = encodeHeader({
      prevBlockHash: prev,
      merkleRoot: EMPTY_ROOT,
      continuityRoot: Buffer.alloc(32),
      timestamp: T0 + (h - 1) * 90_000,
      bits: BITS,
      nonce,
    });
    digest = shearHash(header);
    if (meetsTarget(digest, BITS)) break;
    nonce += 1n;
  }
  fs.writeSync(fd, header);
  prev = digest;
  height = h;
  if (h % 100 === 0) {
    process.stdout.write(`height ${h} ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  }
}
fs.closeSync(fd);
process.stdout.write(`done ${height}\n`);
