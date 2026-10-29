// R28 B-claims price vectors. Pure integers.
// Frozen note dc1e64a173886f9c156c3c105250e84db3261b5b7a30848b4d6089750b35682f.
// Vectors 2d3d4dcf953a189e5e07d416987cc5137ade295a3a1065bca53517f9d7e455d9.
// Output dcee111537be1e7131aa3ad724e47804d4fb7430564692048dfe75abd4f43df0 (63 lines).
// Reference behaviour 623f3f0a0cb5db32c6f1e658e34f5f6a66e2b8ba2b2ef92ca630661b103ea6b2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as price from './bclaims_price.js';

const OUTPUT_SHA = 'dcee111537be1e7131aa3ad724e47804d4fb7430564692048dfe75abd4f43df0';
const fixture = fs.readFileSync(new URL('./bclaims_price_vectors.out.txt', import.meta.url));

const E = (k) => 1n << BigInt(k);
const S0 = 100_000_000_000n;
const ST = 20_000_000_000n;
const C0 = 64n * S0;
const C0t = 64n * ST;
const J = (o) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

function lines() {
  const out = [];
  const T = (n, f) => {
    try { out.push(`${n}: ${J(f())}`); } catch (e) { out.push(`${n}: REFUSE ${e.message}`); }
  };
  for (const k of [15, 16, 40, 64]) {
    for (const d of [-1n, 0n, 1n]) {
      const w = E(k) + d;
      out.push(`W k=${k} d=${d}: F=${price.shareFloorBits(w)} o=${price.shareWeight(w)}`);
    }
  }
  for (const w of [E(14), E(10), E(4), 2n]) {
    out.push(`L work=${w}: F=${price.shareFloorBits(w)} o=${price.shareWeight(w)}`);
  }
  out.push(`floorDiv(-1,1024)=${price.floorDiv(-1n, 1024n)}`);
  T('P1 work 2^40, base 1e11, carry=C0', () => price.roundPrice({ work: E(40), base: S0, carryIn: C0, C0 }));
  T('P2 work 2^40+1', () => price.roundPrice({ work: E(40) + 1n, base: S0, carryIn: C0, C0 }));
  T('P3 carry=C0-1', () => price.roundPrice({ work: E(40), base: S0, carryIn: C0 - 1n, C0 }));
  T('P4 carry=0', () => price.roundPrice({ work: E(40), base: S0, carryIn: 0n, C0 }));
  T('P5 tail, carry=0 (min reachable)', () => price.roundPrice({ work: E(40), base: ST, carryIn: 0n, C0: C0t }));
  T('P6 B=4 (cap)', () => price.roundPrice({ work: 16n, base: S0, carryIn: C0, C0 }));
  T('P7 mocked base+adj<=0 (unreachable)', () => price.roundPrice({ work: E(40), base: 1n, carryIn: 0n, C0 }));
  T('P8 mocked quantisation pi=0 (unreachable)', () => price.roundPrice({ work: E(40), base: 100n, carryIn: C0, C0 }));
  T('P9 carry 2^63-1e11-1', () => price.roundPrice({ work: E(40) + 1n, base: S0, carryIn: E(63) - S0 - 1n, C0 }));
  T('P10 carry >= 2^63', () => price.roundPrice({ work: E(40), base: S0, carryIn: E(63), C0 }));
  T('S1 frame split pi=781250000', () => price.frameSeat(781_250_000n));
  T('X1 single round N=100', () => price.mixClose({ rounds: [{ pi: 781_250_000n, frames: 100n }] }));
  T('X2 thin N=31', () => price.mixClose({ rounds: [{ pi: 781_250_000n, frames: 31n }] }));
  T('X3 merged 20+15 across epoch step', () => price.mixClose({
    rounds: [
      { pi: 781_250_000n, frames: 20n },
      { pi: price.roundPrice({ work: E(40), base: 99_000_000_000n, carryIn: C0, C0 }).pi, frames: 15n },
    ],
  }));
  T('X4 merged at floor, equal pi', () => price.mixClose({
    rounds: [{ pi: 146_484_375n, frames: 10n }, { pi: 146_484_375n, frames: 25n }],
  }));
  T('X5 merged across a B step (o 8192 vs 16383)', () => price.mixClose({
    rounds: [{ pi: 781_250_000n, frames: 20n }, { pi: 1_562_404_632n, frames: 15n }],
  }));
  T('X6 V-2 mocked a=1', () => price.mixClose({ rounds: [{ pi: 1n, frames: 40n }] }));
  T('B1 seat budget exact', () => price.seatBudget({
    T: S0, carryIn: C0, reserve: 0n, framePis: Array(8).fill((S0 + C0) / 8n),
  }));
  T('B2 seat budget one short -> last spills', () => price.seatBudget({
    T: S0 - 1n, carryIn: C0, reserve: 0n, framePis: Array(8).fill((S0 + C0) / 8n),
  }));
  T('B3 empty block with fees + expiry', () => price.seatBudget({
    T: S0 + 5_000_000n, carryIn: C0, expired: 781_250_000n * 7n, reserve: 0n, framePis: [],
  }));
  T('B4 T+carry >= 2^63', () => price.seatBudget({
    T: S0, carryIn: E(63) - S0, reserve: 0n, framePis: [],
  }));
  T('G3a zero-frame round does not set min-pi', () => price.mixClose({
    rounds: [{ pi: 146_484_375n, frames: 0n }, { pi: 781_250_000n, frames: 40n }],
  }));
  T('G3b only zero-frame rounds, K=0 -> thin (no a)', () => price.mixClose({
    rounds: [{ pi: 0n, frames: 0n }], K: 0n,
  }));
  T('G4a seatBudget pi=0 frame -> REFUSE', () => price.seatBudget({
    T: S0, carryIn: C0, reserve: 0n, framePis: [0n, 0n, 0n],
  }));
  T('G4b seatBudget negative pi -> REFUSE', () => price.seatBudget({
    T: S0, carryIn: C0, reserve: 0n, framePis: [-5n],
  }));
  T('G5a negative frames -> REFUSE', () => price.mixClose({
    rounds: [{ pi: 781_250_000n, frames: -40n }, { pi: 781_250_000n, frames: 80n }],
  }));
  T('G5b empty rounds -> REFUSE', () => price.mixClose({ rounds: [], K: 0n }));
  T('G5c negative pi -> REFUSE', () => price.mixClose({ rounds: [{ pi: -1n, frames: 40n }] }));
  T('G6 pot >= 2^63 before open -> REFUSE', () => price.mixClose({ rounds: [{ pi: E(62), frames: 4n }] }));
  T('G7a roundPrice oMax override (cap 4095 at B=4)', () => price.roundPrice({
    work: 16n, base: S0, carryIn: C0, C0, oMax: 4095n,
  }));
  T('G7b roundPrice fMin default at work 2^20 (F=13, o=8192)', () => price.roundPrice({
    work: E(20), base: S0, carryIn: C0, C0,
  }));
  T('G7c roundPrice fMin override 16 at work 2^20 (o capped 16383)', () => price.roundPrice({
    work: E(20), base: S0, carryIn: C0, C0, fMin: 16n,
  }));
  const show = (n, r) => out.push(`${n}: opened=${J(r.opened)} open=${J([...r.state].map(([f, m]) => ({
    F: f,
    ids: m.rounds.map((x) => x.id),
    N: m.rounds.reduce((s, x) => s + x.frames, 0n),
  })))}`);
  const close = (...args) => {
    if (typeof price.classChainClose !== 'function') throw new Error('missing classChainClose');
    return price.classChainClose(...args);
  };
  const PA = 781_250_000n;
  const PB = 1_562_404_632n;
  try {
    let s = new Map();
    let r = close(s, { id: 'A1', h: 100, F: 33n, pi: PA, frames: 20n });
    show('X5prime step1 (F33, 20 frames)', r);
    r = close(r.state, { id: 'B1', h: 101, F: 34n, pi: PB, frames: 15n });
    show('X5prime step2 (F34, 15 frames)', r);
    r = close(r.state, { id: 'A2', h: 102, F: 33n, pi: PA, frames: 12n });
    show('X5prime step3 (F33 +12 -> 32, opens alone)', r);
    r = close(r.state, { id: 'B2', h: 103, F: 34n, pi: PB, frames: 17n });
    show('X5prime step4 (F34 +17 -> 32, opens alone)', r);
    s = new Map();
    r = close(s, { id: 'S', h: 100, F: 34n, pi: PB, frames: 20n });
    show('X7 step1 straggler F34', r);
    r = close(r.state, { id: 'C', h: 1041, F: 33n, pi: PA, frames: 12n });
    show('X7 step2 age 959 (no fallback yet)', r);
    r = close(r.state, { id: 'D', h: 1042, F: 33n, pi: PA, frames: 5n });
    show('X7 step3 age 960 -> fallback merge, min-pi', r);
    s = { state: new Map() };
    const seq = [[33n, PA, 10n], [34n, PB, 9n], [33n, PA, 11n], [34n, PB, 8n], [33n, PA, 12n], [34n, PB, 15n], [33n, PA, 3n]];
    seq.forEach(([F, pi, n], i) => {
      s = close(s.state, { id: `R${i}`, h: 200 + i, F, pi, frames: n });
      show(`X8 round ${i} F${F} +${n}`, s);
    });
  } catch (e) {
    out.push(`ROLL-OVER: ${e.message}`);
  }
  return `${out.join('\n')}\n`;
}

test('B-claims price vectors match the frozen 63 lines', () => {
  assert.equal(createHash('sha256').update(fixture).digest('hex'), OUTPUT_SHA);
  assert.equal(fixture.toString('utf8').split('\n').filter((row) => row.length > 0).length, 63);
  assert.equal(lines(), fixture.toString('utf8'));
});
