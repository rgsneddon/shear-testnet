/**
 * Writes crypto/vectors/t21_prover.txt from the JS prover primitives.
 * shear-fs1 tests/t21_vectors.rs reads the same file, so the native prover
 * derives the same nonces, blinds and limb ciphertexts byte for byte.
 */
import { writeFileSync } from 'node:fs';
import { H, pointBytes, pointFrom, scalarBytes } from '../crypto/note.js';
import { encryptLimb, t21Nonce, vaultBlind, vaultCommit } from '../crypto/t21.js';
import { publicVoucher, voucherAt } from '../crypto/t21_voucher.js';

const hex = (b) => Buffer.from(b).toString('hex');
const rows = [`H\t${hex(pointBytes(H))}`];

const seeds = [Buffer.alloc(32, 7), Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex')];
const binds = [Buffer.alloc(0), Buffer.alloc(32, 0xab)];
const labels = ['r', 'rw', 'enc-t', 'bp-sl', 'agg-ktv', 'mint'];
for (const seed of seeds) {
  for (const label of labels) {
    for (const [i, j] of [[0, 0], [3, 1], [469, 31]]) {
      for (const bind of binds) {
        rows.push(['nonce', hex(seed), label, i, j, hex(bind) || '-', hex(scalarBytes(t21Nonce(seed, label, i, j, bind)))].join('\t'));
      }
    }
  }
}

const parent = Buffer.alloc(32, 1);
for (const [v, id, h] of [[50n, 'mint-1', 7], [322453069963n, 'mint-2', 123456], [1n, 'm', 1]]) {
  const mintId = Buffer.from(id);
  const built = vaultCommit(v, mintId, h, parent);
  rows.push(['vault', v.toString(), hex(mintId), h, hex(parent), hex(scalarBytes(vaultBlind(mintId, h, parent))), hex(built.commit)].join('\t'));
}

const seed = Buffer.alloc(32, 9);
for (let k = 0; k < 4; k += 1) {
  const Y = pointFrom(publicVoucher(voucherAt(Buffer.alloc(32, k + 1), 0)).Y);
  const m = [0n, 1n, 0xffffn, 0x1234n][k];
  const t = t21Nonce(seed, 'enc-t', k, 0);
  const s = t21Nonce(seed, 'enc-s', k, 0);
  const e = encryptLimb(m, Y, t, s);
  rows.push(['limb', m.toString(), hex(pointBytes(Y)), hex(scalarBytes(t)), hex(scalarBytes(s)), hex(pointBytes(e.epV)), hex(pointBytes(e.epD)), hex(pointBytes(e.M))].join('\t'));
}

const head = [
  '# T21 prover primitives shared by crypto/t21.js and shear-fs1 (tests/t21_vectors.rs).',
  '# H: the note generator these rows use (GEN_H; a change regenerates this file).',
  '# nonce: seed, label, i, j, bind (- for empty), H_s(shear-t21-nonce-v1 || seed || bind || len || label || u32le i || u32le j).',
  '# vault: v, mintId, height, parentId, r, v*G + r*H with r = vaultBlind.',
  '# limb: m, Y, t, s, t*G, t*Y + m*G, m*G + s*H.',
];
writeFileSync(new URL('../crypto/vectors/t21_prover.txt', import.meta.url), `${head.concat(rows).join('\n')}\n`);
console.log(rows.length, 'rows');
