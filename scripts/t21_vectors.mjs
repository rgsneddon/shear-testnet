/**
 * Writes crypto/vectors/t21_voucher.txt from the JS voucher check.
 * crypto/t21.test.js and shear-fs1 tests/t21_vectors.rs read the same file.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { G, hashToScalar } from '../crypto/note.js';
import { VCH_PROBE_DOM } from '../crypto/t21_params.js';
import { publicVoucher, voucherAt, voucherKeysOk } from '../crypto/t21_voucher.js';

const hex = (b) => Buffer.from(b).toString('hex');
const ORDER_LE = Buffer.from('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010', 'hex');

function probe(B) {
  const probeC = RistrettoPoint.hashToCurve(createHash('sha512').update(VCH_PROBE_DOM).update(B).digest());
  const delta = hashToScalar(Buffer.from(VCH_PROBE_DOM), B, Buffer.from(probeC.toBytes()));
  const P = RistrettoPoint.fromBytes(Uint8Array.from(B)).add(G.multiply(delta));
  return { probeC: hex(probeC.toBytes()), P: hex(P.toBytes()) };
}

const rows = [];
function row(name, pub) {
  const ok = voucherKeysOk(pub);
  const p = ok ? probe(pub.B) : { probeC: '-', P: '-' };
  rows.push([name, hex(pub.B), hex(pub.Y), hex(pub.lambda), p.probeC, p.P, ok ? 'ok' : 'refuse'].join('\t'));
}

for (let i = 1; i <= 4; i += 1) row(`wallet-${i}`, publicVoucher(voucherAt(Buffer.alloc(32, i), i - 1)));
const base = publicVoucher(voucherAt(Buffer.alloc(32, 7), 0));
row('y-equals-b', { ...base, Y: base.B });
row('b-identity', { ...base, B: Buffer.alloc(32) });
row('b-non-canonical', { ...base, B: Buffer.alloc(32, 0xff) });
row('y-identity', { ...base, Y: Buffer.alloc(32) });
row('lambda-zero', { ...base, lambda: Buffer.alloc(32) });
row('lambda-order', { ...base, lambda: ORDER_LE });
row('lambda-ff', { ...base, lambda: Buffer.alloc(32, 0xff) });
row('lambda-unbound', { ...base, lambda: publicVoucher(voucherAt(Buffer.alloc(32, 6), 0)).lambda });

const head = [
  '# T21 voucher acceptance (payeeFs1Ok for a voucher). Shared by crypto/t21_voucher.js and shear-fs1.',
  '# name, B*, Y, lambda, probeC, P, ok|refuse. probeC = map(SHA-512(shear-vch-probe-v1 || B*)).',
  '# delta = SHA-512(shear-vch-probe-v1 || B* || probeC) mod L, P = B* + delta*G, and (P, probeC) is an FS-1 leaf.',
  '# lambda = SHA-512(shear-vch-lam-v2 || B* || Y) mod L; any other lambda is refused.',
];
writeFileSync(new URL('../crypto/vectors/t21_voucher.txt', import.meta.url), `${head.concat(rows).join('\n')}\n`);
console.log(rows.length, 'rows');
