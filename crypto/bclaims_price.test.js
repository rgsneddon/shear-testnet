// R28 B-claims price vectors. Pure integers, constants are parameters.
// Expected lines are the checked output efd4e6b3… (PA note v6 §2.3).
// AC A2/A3 are X3/X5, A4/A5 are W, A8 is the single round after a step,
// A9 is X4, A10 is P3, A11 is P9, A12 is P7/P8/X6, A14/A15 are L/P6.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  floorDiv,
  frameSeat,
  mixClose,
  roundPrice,
  seatBudget,
  shareFloorBits,
  shareWeight,
} from './bclaims_price.js';

const EXPECTED = `W k=15 d=-1: F=8 o=8192
W k=15 d=0: F=8 o=8192
W k=15 d=1: F=9 o=16383
W k=16 d=-1: F=9 o=8192
W k=16 d=0: F=9 o=8192
W k=16 d=1: F=10 o=16383
W k=40 d=-1: F=33 o=8192
W k=40 d=0: F=33 o=8192
W k=40 d=1: F=34 o=16383
W k=64 d=-1: F=57 o=8192
W k=64 d=0: F=57 o=8192
W k=64 d=1: F=58 o=16383
L work=16384: F=8 o=16383
L work=1024: F=8 o=16383
L work=16: F=8 o=16383
L work=2: F=8 o=16383
floorDiv(-1,1024)=-1
P1 work 2^40, base 1e11, carry=C0: {"pi":"781250000","adj":"0","refuse":false}
P2 work 2^40+1: {"pi":"1562404632","adj":"0","refuse":false}
P3 carry=C0-1: {"pi":"781249999","adj":"-1","refuse":false}
P4 carry=0: {"pi":"732421875","adj":"-6250000000","refuse":false}
P5 tail, carry=0 (min reachable): {"pi":"146484375","adj":"-1250000000","refuse":false}
P6 B=4 (cap): {"pi":"1562404632","adj":"0","refuse":false}
P7 mocked base+adj<=0 (unreachable): {"pi":"0","adj":"-6250000000","refuse":true}
P8 mocked quantisation pi=0 (unreachable): {"pi":"0","adj":"0","refuse":true}
P9 carry 2^63-1e11-1: {"pi":"140730361649293","adj":"9007192907084741","refuse":false}
P10 carry >= 2^63: REFUSE carry range
S1 frame split pi=781250000: {"toProducer":"3906250","toPot":"777343750"}
X1 single round N=100: {"open":true,"N":"100","a":"777343750","v":"769570313","g":"7773437","potOpen":"77734375000","toCarry":"0"}
X2 thin N=31: {"open":false,"reason":"thin","N":"31","pot":"24097656250"}
X3 merged 20+15 across epoch step: {"open":true,"N":"35","a":"769570313","v":"761874610","g":"7695703","potOpen":"26934960955","toCarry":"155468740"}
X4 merged at floor, equal pi: {"open":true,"N":"35","a":"145751954","v":"144294435","g":"1457519","potOpen":"5101318390","toCarry":"0"}
X5 merged across a B step (o 8192 vs 16383): {"open":true,"N":"35","a":"777343750","v":"769570313","g":"7773437","potOpen":"27207031250","toCarry":"11658732885"}
X6 V-2 mocked a=1: {"open":true,"N":"40","a":"1","v":"1","g":"0","potOpen":"40","toCarry":"0"}
B1 seat budget exact: {"seated":8,"carryOutBeforeCloses":"0"}
B2 seat budget one short -> last spills: {"seated":7,"carryOutBeforeCloses":"812499999999"}
B3 empty block with fees + expiry: {"seated":0,"carryOutBeforeCloses":"6505473750000"}
B4 T+carry >= 2^63: REFUSE T+carry range`;

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
      out.push(`W k=${k} d=${d}: F=${shareFloorBits(w)} o=${shareWeight(w)}`);
    }
  }
  for (const w of [E(14), E(10), E(4), 2n]) {
    out.push(`L work=${w}: F=${shareFloorBits(w)} o=${shareWeight(w)}`);
  }
  out.push(`floorDiv(-1,1024)=${floorDiv(-1n, 1024n)}`);
  T('P1 work 2^40, base 1e11, carry=C0', () => roundPrice({ work: E(40), base: S0, carryIn: C0, C0 }));
  T('P2 work 2^40+1', () => roundPrice({ work: E(40) + 1n, base: S0, carryIn: C0, C0 }));
  T('P3 carry=C0-1', () => roundPrice({ work: E(40), base: S0, carryIn: C0 - 1n, C0 }));
  T('P4 carry=0', () => roundPrice({ work: E(40), base: S0, carryIn: 0n, C0 }));
  T('P5 tail, carry=0 (min reachable)', () => roundPrice({ work: E(40), base: ST, carryIn: 0n, C0: C0t }));
  T('P6 B=4 (cap)', () => roundPrice({ work: 16n, base: S0, carryIn: C0, C0 }));
  T('P7 mocked base+adj<=0 (unreachable)', () => roundPrice({ work: E(40), base: 1n, carryIn: 0n, C0 }));
  T('P8 mocked quantisation pi=0 (unreachable)', () => roundPrice({ work: E(40), base: 100n, carryIn: C0, C0 }));
  T('P9 carry 2^63-1e11-1', () => roundPrice({ work: E(40) + 1n, base: S0, carryIn: E(63) - S0 - 1n, C0 }));
  T('P10 carry >= 2^63', () => roundPrice({ work: E(40), base: S0, carryIn: E(63), C0 }));
  T('S1 frame split pi=781250000', () => frameSeat(781_250_000n));
  T('X1 single round N=100', () => mixClose({ rounds: [{ pi: 781_250_000n, frames: 100n }] }));
  T('X2 thin N=31', () => mixClose({ rounds: [{ pi: 781_250_000n, frames: 31n }] }));
  T('X3 merged 20+15 across epoch step', () => mixClose({
    rounds: [
      { pi: 781_250_000n, frames: 20n },
      { pi: roundPrice({ work: E(40), base: 99_000_000_000n, carryIn: C0, C0 }).pi, frames: 15n },
    ],
  }));
  T('X4 merged at floor, equal pi', () => mixClose({
    rounds: [{ pi: 146_484_375n, frames: 10n }, { pi: 146_484_375n, frames: 25n }],
  }));
  T('X5 merged across a B step (o 8192 vs 16383)', () => mixClose({
    rounds: [{ pi: 781_250_000n, frames: 20n }, { pi: 1_562_404_632n, frames: 15n }],
  }));
  T('X6 V-2 mocked a=1', () => mixClose({ rounds: [{ pi: 1n, frames: 40n }] }));
  T('B1 seat budget exact', () => seatBudget({
    T: S0, carryIn: C0, reserve: 0n, framePis: Array(8).fill((S0 + C0) / 8n),
  }));
  T('B2 seat budget one short -> last spills', () => seatBudget({
    T: S0 - 1n, carryIn: C0, reserve: 0n, framePis: Array(8).fill((S0 + C0) / 8n),
  }));
  T('B3 empty block with fees + expiry', () => seatBudget({
    T: S0 + 5_000_000n, carryIn: C0, expired: 781_250_000n * 7n, reserve: 0n, framePis: [],
  }));
  T('B4 T+carry >= 2^63', () => seatBudget({
    T: S0, carryIn: E(63) - S0, reserve: 0n, framePis: [],
  }));
  return out.join('\n');
}

test('B-claims price vectors match efd4e6b3', () => {
  assert.equal(lines(), EXPECTED);
});
