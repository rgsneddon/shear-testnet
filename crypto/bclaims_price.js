// R28 B-claims price. Pure integers. Every constant is a parameter.
// Not consensus: nothing in chain, pins, or fingerprints imports this module.
// Frozen note 8f8ba8760572b304565bd575b3b12ec83057419f63db28995f017cf6a8c50774.
// Reference r28-bclaims-mix-price.mjs 623f3f0a0cb5db32c6f1e658e34f5f6a66e2b8ba2b2ef92ca630661b103ea6b2.
// R28 B-claims pricing: pure integer reference. No pins: every constant is a parameter.
// PA r28-draw-redesign-pa.md v10 §2.3 (G-3/G-4/G-5/G-6/G-7 fixes from review-145-price-pa.md 4c7ed924). MF-1 (own-round subsidy, fees into carry), ME r28-me-bclaims.md
// (min-pi roll-over, inclusion reward), AC r28-me-p1-ca.md (M-2 cap, M-3 min base, M-4 integer F_r).
export const bitlen = (x) => (x <= 0n ? 0n : BigInt(x.toString(2).length));
export const floorDiv = (a, b) => { const q = a / b; return (a % b !== 0n && ((a < 0n) !== (b < 0n))) ? q - 1n : q; };
const LIM = 1n << 63n;
export function shareFloorBits(work, fMin = 8n) {            // M-4
  if (work < 2n) throw new Error('work');
  const f = bitlen(work - 1n) - 7n; return f > fMin ? f : fMin;
}
export function shareWeight(work, { Q = 20n, oMax = (1n << 14n) - 1n, fMin = 8n } = {}) { // M-2
  const o = (1n << (shareFloorBits(work, fMin) + Q)) / work; return o < oMax ? o : oMax;
}
// pi_r: one integer per round, fixed at block h_r+1 (the round's first frame block).
// base = chain subsidy of round r's block (timestamp epoch, as the chain defines it) minus the epoch-only reserve cut.
export function roundPrice({ work, base, carryIn, C0, C = 1024n, Q = 20n, oMax = (1n << 14n) - 1n, fMin = 8n }) { // G-7: all weight params forwarded
  if (carryIn < 0n || carryIn >= LIM) throw new Error('carry range');
  const adj = floorDiv(carryIn - C0, C);
  const num = (base + adj) * shareWeight(work, { Q, oMax, fMin });
  const pi = num > 0n ? num >> Q : 0n;
  return { pi, adj, refuse: pi < 1n };                         // V-2: a round with pi_r < 1 seats no frames
}
// Split of one frame's value at seating.
export function frameSeat(pi, { gFrameBps = 50n } = {}) {
  const g = (pi * gFrameBps) / 10000n; return { toProducer: g, toPot: pi - g };
}
// Mix close. rounds: [{pi, frames}] (frames seated). Returns open/roll, per-claim allocation a, claim note v, claim reward g.
export function mixClose({ rounds, K = 32n, gFrameBps = 50n, gClaimBps = 100n }) {
  if (!Array.isArray(rounds) || rounds.length < 1) throw new Error('empty rounds');           // G-5
  let N = 0n, pot = 0n, a = null;
  for (const r of rounds) {
    if (r.frames < 0n) throw new Error('negative frames');                                   // G-5
    if (r.pi < 0n) throw new Error('negative pi');                                           // G-5
    const s = frameSeat(r.pi, { gFrameBps });
    N += r.frames; pot += r.frames * s.toPot;
    if (r.frames >= 1n) a = a === null || s.toPot < a ? s.toPot : a; // G-3: min only over rounds with >= 1 seated frame
  }
  if (pot >= LIM) throw new Error('pot range');                 // G-6: pot < 2^63 before any open
  if (N < K || a === null) return { open: false, reason: 'thin', N, pot };   // roll into the next round's mix
  const g = (a * gClaimBps) / 10000n, v = a - g;
  if (v < 1n) return { open: false, reason: 'V-2', N, pot };
  const potOpen = a * N, toCarry = pot - potOpen;               // public integer, pot -> carry
  if (potOpen >= LIM) throw new Error('pot range');
  return { open: true, N, a, v, g, potOpen, toCarry };
}
// Block-level budget for frame seating: debit pi per frame; frames beyond the budget spill.
export function seatBudget({ T, carryIn, expired = 0n, reserve, framePis /* [pi,...] in seat order */ }) {
  if (T + carryIn + expired >= LIM) throw new Error('T+carry range');
  let avail = T + carryIn + expired - reserve; if (avail < 0n) throw new Error('reserve');
  let seated = 0;
  for (const pi of framePis) {
    if (pi < 1n) throw new Error('V-2 seat');                   // G-4: a frame of a refused round (pi < 1) is never seated
    if (pi > avail) break; avail -= pi; seated++; }
  return { seated, carryOutBeforeCloses: avail };
}

// ---- Roll-over (normative, Russell Q5 17:44 GMT "(b) one merge chain per F_r class"), with a 960-round fallback. ----
// state: Map F -> { rounds: [{id, h, pi, frames}] } (open, unclaimable mixes). Call once per round at its close
// height (h_r + mixWindow). Returns the mixes opened for claims. Pure, deterministic; constants are parameters.
export function classChainClose(state, round /* {id, h, F, pi, frames} */,
  { K = 32n, fallbackAge = 960, mixWindow = 18, gFrameBps = 50n, gClaimBps = 100n } = {}) {
  const st = new Map([...state].map(([f, m]) => [f, { rounds: [...m.rounds] }]));
  const now = round.h + mixWindow;
  const cur = st.get(round.F) || { rounds: [] };
  cur.rounds.push({ id: round.id, h: round.h, pi: round.pi, frames: round.frames });
  st.set(round.F, cur);
  // fallback: a class mix still short of K whose first round is >= fallbackAge old merges into the current class (min-pi)
  for (const [f, m] of [...st].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (f === round.F) continue;
    if (now - m.rounds[0].h >= fallbackAge) { cur.rounds.push(...m.rounds); st.delete(f); }
  }
  cur.rounds.sort((a, b) => a.h - b.h);
  const opened = [];
  const r = mixClose({ rounds: cur.rounds, K, gFrameBps, gClaimBps });
  if (r.open) { opened.push({ F: round.F, ids: cur.rounds.map((x) => x.id), ...r }); st.delete(round.F); }
  return { state: st, opened };
}

