// R28 BluNotes: wallet test vectors from the authoritative JS (crypto/blunote.js).
// Run from the repo root (needs the root node_modules):
//   node wallet/test/fixtures/gen_blunote_vectors.mjs > wallet/test/fixtures/blunote_vectors.json
// Every input is fixed, so a rerun prints the same file byte for byte.
import { createHash } from 'node:crypto';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { G, H, hashToScalar, pointBytes, scalarBytes } from '../../../crypto/note.js';
import { admitBaseScalar, admitBasePub } from '../../../crypto/admit.js';
import {
  BLUNOTE_WINNERS,
  blunoteNote,
  blunoteRho,
  drawPieces,
  encodeRecord,
  notesFromRecord,
  oneTimeKey,
  oneTimeSpendScalar,
  recogniseOneTime,
  recordRoot,
  scanPub,
  scanScalar,
} from '../../../crypto/blunote.js';

const Fn = RistrettoPoint.Fn;
const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest();

function wallet(label) {
  const seed = sha(`shear-blunote-wallet-vector-${label}`);
  const xBase = admitBaseScalar(seed);
  return {
    label,
    seed,
    xBase,
    B: pointBytes(admitBasePub(seed)),
    y: scanScalar(seed),
    Y: scanPub(seed),
  };
}

const wallets = ['alice', 'bob', 'stranger'].map(wallet);

function rOf(label, j) {
  return hashToScalar(Buffer.from('shear-blunote-vector-r'), Buffer.from(label), Buffer.from([j]));
}

function key(w, j) {
  const r = rOf(w.label, j);
  const k = oneTimeKey({ B: w.B, Y: w.Y }, r);
  const delta = recogniseOneTime({ y: w.y, B: w.B }, k.R, k.P);
  if (delta == null) throw new Error('own key not recognised');
  const x = oneTimeSpendScalar(w.xBase, delta);
  if (!pointBytes(G.multiply(x)).equals(Buffer.from(k.P))) throw new Error('x·G != P');
  return { r, ...k, delta, x };
}

const oneTime = [];
for (const w of wallets) {
  for (let j = 0; j < 2; j += 1) {
    const k = key(w, j);
    oneTime.push({
      wallet: w.label,
      r: hex(scalarBytes(k.r)),
      R: hex(k.R),
      P: hex(k.P),
      delta: hex(scalarBytes(k.delta)),
      x: hex(scalarBytes(k.x)),
      rho: hex(scalarBytes(blunoteRho(k.P))),
    });
  }
}

// One block record: bob holds the pool fee key, alice wins two rows,
// bob one, the stranger one. T leaves a remainder so floor(T/16) matters.
const T = 16n * 123456789n + 7n;
const feeV = 50000000n;
const kFee = key(wallets[1], 7);
const rows = [
  { w: wallets[0], j: 3, m: 3 },
  { w: wallets[2], j: 3, m: 7 },
  { w: wallets[1], j: 3, m: 5 },
  { w: wallets[0], j: 4, m: 1 },
];
const winners = rows.map(({ w, j, m }) => {
  const k = key(w, j);
  return { R: k.R, P: k.P, m, owner: w.label, x: k.x };
});
const record = encodeRecord({
  batchRoot: sha('shear-blunote-vector-batch'),
  n: 9,
  W: 4096n,
  T,
  feeV,
  feeR: kFee.R,
  feeP: kFee.P,
  winners,
});
const notes = notesFromRecord(record);
const owners = [{ owner: 'bob', x: kFee.x }, ...winners.map((w) => ({ owner: w.owner, x: w.x }))];
const piece = drawPieces(T, BLUNOTE_WINNERS).piece;

// A record with no fee key and no winners: an empty batch.
const empty = encodeRecord({ batchRoot: Buffer.alloc(32), n: 0, W: 0n, T: 0n, winners: [] });

const out = {
  spec: 'crypto/blunote.js (R28)',
  k: BLUNOTE_WINNERS,
  H: hex(pointBytes(H)),
  wallets: wallets.map((w) => ({
    label: w.label,
    seed: hex(w.seed),
    y: hex(scalarBytes(w.y)),
    Y: hex(w.Y),
    xBase: hex(scalarBytes(w.xBase)),
    B: hex(w.B),
    miningAddress: hex(w.B) + hex(w.Y),
  })),
  oneTime,
  record: {
    hex: hex(record),
    root: hex(recordRoot(record)),
    T: T.toString(),
    piece: piece.toString(),
    feeV: feeV.toString(),
    notes: notes.map((n, i) => ({
      kind: n.kind,
      owner: owners[i].owner,
      R: hex(n.R),
      P: hex(n.admitPub),
      v: n.v.toString(),
      m: n.m ?? null,
      C: hex(n.commit),
      rho: hex(scalarBytes(blunoteRho(n.admitPub))),
      x: hex(scalarBytes(owners[i].x)),
    })),
  },
  emptyRecord: hex(empty),
};

// Self-checks before the file is written.
for (const n of out.record.notes) {
  const C = blunoteNote(Buffer.from(n.P, 'hex'), BigInt(n.v)).commit;
  if (hex(C) !== n.C) throw new Error('C mismatch');
  const x = Fn.fromBytes(Buffer.from(n.x, 'hex'));
  if (hex(pointBytes(G.multiply(x))) !== n.P) throw new Error('x mismatch');
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
