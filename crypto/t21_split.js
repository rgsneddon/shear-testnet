/**
 * T21 option A. Public mint M and public total work S.
 * Each dest hides its work w and its payout v.
 * The floor identity is M·w = S·v + rem, with 0 ≤ rem < S.
 * The note amount is not a public valueProof.v.
 * The share batch is not an input to this proof.
 */
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import {
  G,
  H,
  asU8,
  bitOrProve,
  bitOrVerify,
  hashToScalar,
  pointBytes,
  pointFrom,
  randomScalar,
  scalarBytes,
  scalarFrom,
} from './note.js';

const Point = RistrettoPoint;
const Fn = Point.Fn;

export const T21_BITS_MAX = 40;
export const T21_PAYOUT_KINDS = new Set(['pot', 'hash', 'finder-fee', 'reserve-fee', 'pool-fee']);
const LINK_DST = Buffer.from('shear-t21-link-v1');
const SLACK_DST = Buffer.from('shear-t21-slack-v1');
const WORK_DST = Buffer.from('shear-t21-work-v1');

function fail(reason) {
  return { ok: false, reason };
}

function bitLength(n) {
  let x = BigInt(n);
  let k = 0;
  while (x > 0n) {
    x >>= 1n;
    k += 1;
  }
  return k;
}

function u64le(n) {
  const b = Buffer.alloc(8);
  let x = BigInt(n);
  if (x < 0n || x >= (1n << 64n)) throw new Error('t21-u64');
  for (let i = 0; i < 8; i += 1) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

/** Canonical integer in 0 .. 2^maxBits-1. Leading zeros are rejected. */
export function t21Int(v, maxBits = T21_BITS_MAX) {
  let n;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) return null;
    n = BigInt(v);
  } else if (typeof v === 'string') {
    if (v === '0') n = 0n;
    else if (!/^[1-9][0-9]*$/.test(v)) return null;
    else n = BigInt(v);
  } else return null;
  if (n < 0n) return null;
  if (maxBits < 0 || n >= (1n << BigInt(maxBits))) return null;
  return n;
}

function fieldInt(n) {
  return Fn.create(BigInt(n));
}

function mulPoint(P, n) {
  const v = BigInt(n);
  if (v === 0n) return Point.ZERO;
  return P.multiply(fieldInt(v));
}

function schnorrProve(P, r, extra) {
  const k = randomScalar();
  const R = H.multiply(k);
  const e = hashToScalar(pointBytes(P), pointBytes(R), extra);
  const z = Fn.add(k, Fn.mul(e, r));
  return { R: pointBytes(R), z: scalarBytes(z) };
}

function schnorrVerify(P, proof, extra) {
  try {
    if (!proof?.R || proof.z == null) return false;
    const R = pointFrom(proof.R);
    const z = scalarFrom(proof.z);
    const e = hashToScalar(pointBytes(P), proof.R, extra);
    const left = H.multiply(z);
    const right = R.add(P.multiply(e));
    return left.equals(right);
  } catch {
    return false;
  }
}

function proveBits(value, bits) {
  const out = [];
  let blind = Fn.ZERO;
  const v = BigInt(value);
  for (let i = 0; i < bits; i += 1) {
    const bit = Number((v >> BigInt(i)) & 1n);
    const s = randomScalar();
    const weight = fieldInt(1n << BigInt(i));
    blind = Fn.add(blind, Fn.mul(s, weight));
    const C = mulPoint(G, bit).add(H.multiply(s));
    out.push({ C: pointBytes(C), ...bitOrProve(C, bit, s) });
  }
  return { proofs: out, blind };
}

function verifyBits(C, proofs, bits) {
  if (!Array.isArray(proofs) || proofs.length !== bits) return false;
  let acc = Point.ZERO;
  for (let i = 0; i < bits; i += 1) {
    let B;
    try { B = pointFrom(proofs[i].C); } catch { return false; }
    if (!bitOrVerify(B, proofs[i])) return false;
    acc = acc.add(mulPoint(B, 1n << BigInt(i)));
  }
  return acc.equals(C);
}

function commitOf(value, blind) {
  return mulPoint(G, value).add(H.multiply(blind));
}

function rowExtra(dst, mint, totalWork, paid, rows, index, points) {
  return Buffer.concat([
    dst,
    u64le(mint),
    u64le(totalWork),
    u64le(paid),
    u64le(rows),
    u64le(index),
    ...points.map((P) => pointBytes(P)),
  ]);
}

function samePoint(buf, P) {
  try {
    return pointFrom(buf).equals(P);
  } catch {
    return false;
  }
}

/**
 * @param {{ mint: bigint|number|string, totalWork: bigint|number|string, rows: { v: bigint|number|string, w: bigint|number|string }[] }} input
 */
export function proveT21Split(input) {
  const mint = t21Int(input?.mint);
  const totalWork = t21Int(input?.totalWork);
  const rows = Array.isArray(input?.rows) ? input.rows : null;
  if (mint == null || mint < 1n) throw new Error('t21-mint');
  if (totalWork == null || totalWork < 2n) throw new Error('t21-work');
  if (!rows || !rows.length || rows.length > 64) throw new Error('t21-rows');
  const bitsV = bitLength(mint);
  const bitsW = bitLength(totalWork);
  const bitsRem = bitLength(totalWork - 1n);
  if (bitsV > T21_BITS_MAX || bitsW > T21_BITS_MAX || bitsRem > T21_BITS_MAX) {
    throw new Error('t21-bits');
  }
  let paid = 0n;
  let workSum = 0n;
  const built = [];
  for (const row of rows) {
    const w = t21Int(row?.w);
    const v = t21Int(row?.v);
    if (w == null || v == null) throw new Error('t21-row');
    if (w > totalWork) throw new Error('t21-row');
    const product = mint * w;
    const rem = product % totalWork;
    const floor = (product - rem) / totalWork;
    if (v !== floor) throw new Error('t21-floor');
    paid += v;
    workSum += w;
    const valueBits = proveBits(v, bitsV);
    const remBits = proveBits(rem, bitsRem);
    const slackBits = proveBits(totalWork - 1n - rem, bitsRem);
    const workBits = proveBits(w, bitsW);
    const workSlackBits = proveBits(totalWork - w, bitsW);
    const C = commitOf(v, valueBits.blind);
    const Crem = commitOf(rem, remBits.blind);
    const Cslack = commitOf(totalWork - 1n - rem, slackBits.blind);
    const W = commitOf(w, workBits.blind);
    const Wslack = commitOf(totalWork - w, workSlackBits.blind);
    built.push({
      v,
      w,
      rem,
      C,
      Crem,
      Cslack,
      W,
      Wslack,
      rC: valueBits.blind,
      rW: workBits.blind,
      rRem: remBits.blind,
      rSlack: slackBits.blind,
      rWSlack: workSlackBits.blind,
      valueBits: valueBits.proofs,
      remBits: remBits.proofs,
      slackBits: slackBits.proofs,
      workBits: workBits.proofs,
      workSlackBits: workSlackBits.proofs,
    });
  }
  if (workSum !== totalWork) throw new Error('t21-work-sum');
  if (paid >= (1n << BigInt(T21_BITS_MAX))) throw new Error('t21-paid');
  let noteBlind = Fn.ZERO;
  let workBlind = Fn.ZERO;
  const proofRows = [];
  built.forEach((row, index) => {
    noteBlind = Fn.add(noteBlind, row.rC);
    workBlind = Fn.add(workBlind, row.rW);
    const linkP = mulPoint(row.W, mint).subtract(mulPoint(row.C, totalWork)).subtract(row.Crem);
    const linkBlind = Fn.sub(Fn.sub(Fn.mul(row.rW, fieldInt(mint)), Fn.mul(row.rC, fieldInt(totalWork))), row.rRem);
    const slackP = row.Crem.add(row.Cslack).subtract(mulPoint(G, totalWork - 1n));
    const slackBlind = Fn.add(row.rRem, row.rSlack);
    const workP = row.W.add(row.Wslack).subtract(mulPoint(G, totalWork));
    const workBlindRow = Fn.add(row.rW, row.rWSlack);
    proofRows.push({
      commit: pointBytes(row.C),
      work: pointBytes(row.W),
      remCommit: pointBytes(row.Crem),
      slackCommit: pointBytes(row.Cslack),
      workSlack: pointBytes(row.Wslack),
      link: schnorrProve(linkP, linkBlind, rowExtra(LINK_DST, mint, totalWork, paid, built.length, index, [row.C, row.W, row.Crem])),
      remSlack: schnorrProve(slackP, slackBlind, rowExtra(SLACK_DST, mint, totalWork, paid, built.length, index, [row.Crem, row.Cslack])),
      workLink: schnorrProve(workP, workBlindRow, rowExtra(WORK_DST, mint, totalWork, paid, built.length, index, [row.W, row.Wslack])),
      valueBits: row.valueBits,
      remBits: row.remBits,
      slackBits: row.slackBits,
      workBits: row.workBits,
      workSlackBits: row.workSlackBits,
    });
  });
  return {
    mint: mint.toString(),
    totalWork: totalWork.toString(),
    paid: paid.toString(),
    excess: scalarBytes(noteBlind),
    workExcess: scalarBytes(workBlind),
    rows: proofRows,
  };
}

function parseProof(proof) {
  const mint = t21Int(proof?.mint);
  const totalWork = t21Int(proof?.totalWork);
  const paid = t21Int(proof?.paid);
  if (mint == null || totalWork == null || paid == null) return null;
  if (mint < 1n || totalWork < 2n) return null;
  if (!Array.isArray(proof?.rows) || !proof.rows.length || proof.rows.length > 64) return null;
  return { mint, totalWork, paid };
}

/**
 * @param {object} proof
 * @param {{ vouts?: object[], excess?: Uint8Array, mint?: bigint|number|string }} [bind]
 */
export function verifyT21Split(proof, bind = {}) {
  const parsed = parseProof(proof);
  if (!parsed) return fail('shape');
  const { mint, totalWork, paid } = parsed;
  if (bind.mint != null) {
    const want = t21Int(bind.mint);
    if (want == null || want !== mint) return fail('mint');
  }
  const bitsV = bitLength(mint);
  const bitsW = bitLength(totalWork);
  const bitsRem = bitLength(totalWork - 1n);
  if (bitsV > T21_BITS_MAX || bitsW > T21_BITS_MAX || bitsRem > T21_BITS_MAX || bitsRem < 1) {
    return fail('shape');
  }
  const rows = proof.rows;
  if (bind.vouts != null) {
    const committing = (Array.isArray(bind.vouts) ? bind.vouts : []).filter((o) => o?.commit);
    if (committing.length !== rows.length) return fail('row');
    for (let i = 0; i < committing.length; i += 1) {
      if (!T21_PAYOUT_KINDS.has(String(committing[i].kind || ''))) return fail('row');
      try {
        const got = Buffer.from(asU8(committing[i].commit));
        const want = Buffer.from(asU8(rows[i].commit));
        if (!got.equals(want)) return fail('row');
      } catch {
        return fail('row');
      }
    }
  }
  let accC = Point.ZERO;
  let accW = Point.ZERO;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    let C;
    let W;
    let Crem;
    let Cslack;
    let Wslack;
    try {
      C = pointFrom(row.commit);
      W = pointFrom(row.work);
      Crem = pointFrom(row.remCommit);
      Cslack = pointFrom(row.slackCommit);
      Wslack = pointFrom(row.workSlack);
    } catch {
      return fail('shape');
    }
    if (!verifyBits(C, row.valueBits, bitsV)) return fail('bits');
    if (!verifyBits(Crem, row.remBits, bitsRem)) return fail('bits');
    if (!verifyBits(Cslack, row.slackBits, bitsRem)) return fail('bits');
    if (!verifyBits(W, row.workBits, bitsW)) return fail('bits');
    if (!verifyBits(Wslack, row.workSlackBits, bitsW)) return fail('bits');
    const linkP = mulPoint(W, mint).subtract(mulPoint(C, totalWork)).subtract(Crem);
    if (!schnorrVerify(linkP, row.link, rowExtra(LINK_DST, mint, totalWork, paid, rows.length, index, [C, W, Crem]))) {
      return fail('link');
    }
    const slackP = Crem.add(Cslack).subtract(mulPoint(G, totalWork - 1n));
    if (!schnorrVerify(slackP, row.remSlack, rowExtra(SLACK_DST, mint, totalWork, paid, rows.length, index, [Crem, Cslack]))) {
      return fail('slack');
    }
    const workP = W.add(Wslack).subtract(mulPoint(G, totalWork));
    if (!schnorrVerify(workP, row.workLink, rowExtra(WORK_DST, mint, totalWork, paid, rows.length, index, [W, Wslack]))) {
      return fail('work');
    }
    if (!samePoint(row.commit, C) || !samePoint(row.work, W)) return fail('shape');
    accC = accC.add(C);
    accW = accW.add(W);
  }
  try {
    const workOpen = mulPoint(G, totalWork).add(H.multiply(scalarFrom(proof.workExcess)));
    if (!accW.equals(workOpen)) return fail('work');
    const noteOpen = mulPoint(G, paid).add(H.multiply(scalarFrom(proof.excess)));
    if (!accC.equals(noteOpen)) return fail('excess');
  } catch {
    return fail('shape');
  }
  if (bind.excess != null) {
    try {
      const got = Buffer.from(asU8(bind.excess));
      const want = Buffer.from(asU8(proof.excess));
      if (got.length !== 32 || want.length !== 32 || !got.equals(want)) return fail('excess');
    } catch {
      return fail('excess');
    }
  }
  return { ok: true, mint, paid, totalWork };
}

/**
 * Chain gate. An absent t21Split stays on the old coinbase path.
 * A present split must verify, its public mint must be the payable pot,
 * and the hidden notes plus carry must be that same pot.
 * A public valueProof.v on a payout kind is rejected.
 */
export function t21CoinbaseGate(tx, payablePot, vouts, carryOut = 0) {
  if (tx == null || tx.t21Split == null) return { ok: true, absent: true };
  const checked = verifyT21Split(tx.t21Split, {
    vouts,
    excess: tx.excess,
    mint: payablePot,
  });
  if (!checked.ok) {
    return fail(checked.reason === 'mint' ? 'pot_sched' : 't21_split');
  }
  const carry = t21Int(carryOut);
  const pot = t21Int(payablePot);
  if (carry == null || pot == null || checked.paid + carry !== pot) return fail('pot_sched');
  const rows = Array.isArray(vouts) ? vouts : [];
  for (const o of rows) {
    if (!T21_PAYOUT_KINDS.has(String(o?.kind || ''))) continue;
    const v = o?.valueProof?.v;
    if (v != null && v !== '') return fail('t21_split');
  }
  return { ok: true, paid: checked.paid, mint: checked.mint };
}
