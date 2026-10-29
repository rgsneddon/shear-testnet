// R28 B-claims price. Pure integers. Every constant is a parameter.
// Not consensus: nothing in chain, pins, or fingerprints imports this module.
// PA note v6 §2.3. Reference r28-bclaims-mix-price.mjs (8960358b…).

export const bitlen = (x) => (x <= 0n ? 0n : BigInt(x.toString(2).length));

// Toward −∞. BigInt division truncates toward 0, so floorDiv(-1, 1024) must be -1.
export const floorDiv = (a, b) => {
  const q = a / b;
  return (a % b !== 0n && ((a < 0n) !== (b < 0n))) ? q - 1n : q;
};

const LIM = 1n << 63n;

export function shareFloorBits(work, fMin = 8n) {
  if (work < 2n) throw new Error('work');
  const f = bitlen(work - 1n) - 7n;
  return f > fMin ? f : fMin;
}

export function shareWeight(work, { Q = 20n, oMax = (1n << 14n) - 1n, fMin = 8n } = {}) {
  const o = (1n << (shareFloorBits(work, fMin) + Q)) / work;
  return o < oMax ? o : oMax;
}

export function roundPrice({ work, base, carryIn, C0, C = 1024n, Q = 20n }) {
  if (carryIn < 0n || carryIn >= LIM) throw new Error('carry range');
  const adj = floorDiv(carryIn - C0, C);
  const num = (base + adj) * shareWeight(work, { Q });
  const pi = num > 0n ? num >> Q : 0n;
  return { pi, adj, refuse: pi < 1n };
}

export function frameSeat(pi, { gFrameBps = 50n } = {}) {
  const g = (pi * gFrameBps) / 10000n;
  return { toProducer: g, toPot: pi - g };
}

export function mixClose({ rounds, K = 32n, gFrameBps = 50n, gClaimBps = 100n }) {
  let N = 0n;
  let pot = 0n;
  let a = null;
  for (const r of rounds) {
    const s = frameSeat(r.pi, { gFrameBps });
    N += r.frames;
    pot += r.frames * s.toPot;
    a = a === null || s.toPot < a ? s.toPot : a;
  }
  if (N < K) return { open: false, reason: 'thin', N, pot };
  const g = (a * gClaimBps) / 10000n;
  const v = a - g;
  if (v < 1n) return { open: false, reason: 'V-2', N, pot };
  const potOpen = a * N;
  const toCarry = pot - potOpen;
  if (potOpen >= LIM) throw new Error('pot range');
  return { open: true, N, a, v, g, potOpen, toCarry };
}

export function seatBudget({ T, carryIn, expired = 0n, reserve, framePis }) {
  if (T + carryIn + expired >= LIM) throw new Error('T+carry range');
  let avail = T + carryIn + expired - reserve;
  if (avail < 0n) throw new Error('reserve');
  let seated = 0;
  for (const pi of framePis) {
    if (pi > avail) break;
    avail -= pi;
    seated += 1;
  }
  return { seated, carryOutBeforeCloses: avail };
}
