/**
 * Writes crypto/vectors/t21_prover.txt from the JS prover primitives.
 * shear-fs1 tests/t21_vectors.rs reads the same file, so the native prover
 * derives the same nonces, blinds and limb ciphertexts byte for byte.
 */
import { writeFileSync } from 'node:fs';
import { G, H, pointBytes, pointFrom, scalarBytes } from '../crypto/note.js';
import { encryptLimb, t21Nonce, t21ProverJs, vaultBlind, vaultCommit } from '../crypto/t21.js';
import { splitLaw } from '../crypto/t21_law.js';
import { commitRequest, proveRequest } from '../crypto/t21_native.js';
import { publicVoucher, voucherAt, voucherKeysOk } from '../crypto/t21_voucher.js';

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

/* ---------- whole-row vectors for the native prover (src/t21_prove.rs) ---------- */

const pseed = Buffer.alloc(32, 0x3c);
const block = { magic: 'shear-testnet-v12', height: 77, prevHash: Buffer.alloc(32, 2) };
const nonce = (label, i = 0, j = 0, bind = Buffer.alloc(0)) => t21Nonce(pseed, label, i, j, bind);
const vchs = [];
for (let k = 0; vchs.length < 4; k += 1) {
  const v = voucherAt(Buffer.alloc(32, 0x50 + vchs.length), k);
  if (voucherKeysOk(publicVoucher(v))) vchs.push(v);
}
const R = 50_000_000_007n;
const u = 3n;
const fee = 4_000n;
const weights = [[70_000n, 1_234n], [], [90_001n], []];
const fins = [0n, fee, 5_000n, 0n];
const W = weights.flat().reduce((a, b) => a + b, 0n);
const rate = R + W * u;
const prow = weights.map((ws, i) => {
  const Wi = ws.reduce((a, b) => a + b, 0n);
  const law = i === 1 ? { v: fee, rho: 0n } : splitLaw({ R, W, Wi, u, fin: fins[i] });
  const kind = i === 1 ? 'pool-fee' : 'pot';
  return { kind, vch: vchs[i], v: i === 3 ? 0n : law.v, Wi, rho: i === 3 ? 0n : law.rho, finEff: fins[i], finPub: i === 1 ? 0n : fins[i], noLeaf: false };
});
const ctx = { ...block, nonce, W, rate };
const items = prow.map((row, i) => t21ProverJs.commitRow(ctx, row, i));
const tryOf = (it) => [...Array(8).keys()].find((k) => nonce('r', it.index, k) === it.r);
const commitReply = items.map((it) => ['row', it.index, tryOf(it), hex(it.pub.commit), hex(it.pub.admitPub), hex(it.pub.cw),
  ...it.pub.rhoK.map(hex), ...it.pub.delK.map(hex), ...it.pub.ra.chunks.flatMap((c) => [hex(c.epV), hex(c.epD), hex(c.Mpt)])].join(' '));
const stmt = Buffer.alloc(32, 0x77);
const shares = weights.flatMap((ws, i) => ws.map((w, k) => {
  const beta = t21Nonce(pseed, 'vector-beta', i, k);
  return { w, E: pointBytes(G.multiply(vchs[i].lambda).add(H.multiply(beta))), ell: vchs[i].lambda, beta };
}));
const proved = items.map((it) => t21ProverJs.proveRow(ctx, it, stmt));
const tally = t21ProverJs.proveTally(items, shares, W, stmt, nonce);
const proveReply = proved.map((p, i) => {
  const bp = p.rangeProof.bp;
  const agg = p.ra.agg;
  return ['row', i, ...p.ra.chunks.flatMap((c) => [c.bindR1, c.bindR2, c.zT, c.zS].map(hex)),
    ...[agg.RC, agg.RVv, agg.RDv, agg.RVr, agg.RDr, agg.zv, agg.zr, agg.ztv, agg.ztr].map(hex),
    hex(p.law.Rpt), hex(p.law.z),
    ...[bp.A, bp.S, bp.T1, bp.T2, bp.taux, bp.mu, bp.that, ...bp.L, ...bp.R, bp.a, bp.b].map(hex)].join(' ');
}).concat(
  tally.inv.map((v) => ['inv', v.Cinv, v.proof.Rp, v.proof.Ra, v.proof.zA, v.proof.zDiff, v.proof.zBlind].map((x, k) => (k ? hex(x) : x)).join(' ')),
  [['tally', tally.n, hex(tally.balance.Rpt), hex(tally.balance.z), hex(tally.weight.Rpt), hex(tally.weight.z)].join(' ')],
);
const commitReq = commitRequest({ seed: pseed, ...block, W, rows: prow.map((r) => ({ ...r, B: pointBytes(r.vch.B), Y: pointBytes(r.vch.Y) })) });
const proveReq = proveRequest({
  seed: pseed, stmt, W, rate, shares,
  rows: prow.map((r, i) => ({ ...r, n: tryOf(items[i]), Y: pointBytes(r.vch.Y), lambda: r.vch.lambdaBytes })),
});
const rowsFile = [
  '# T21 native prover vectors, written by scripts/t21_prover_vectors.mjs from the JS prover',
  '# (commitRow, proveRow, proveTally in crypto/t21.js). shear-fs1 tests/t21_vectors.rs feeds',
  '# each request to t21_prove::serve and expects the reply byte for byte.',
  '@commit-request', commitReq.trimEnd(),
  '@commit-reply', ...commitReply, 'ok',
  '@prove-request', proveReq.trimEnd(),
  '@prove-reply', ...proveReply, 'ok',
];
writeFileSync(new URL('../crypto/vectors/t21_prove_rows.txt', import.meta.url), `${rowsFile.join('\n')}\n`);
console.log(items.length, 'prover rows,', shares.length, 'shares');
