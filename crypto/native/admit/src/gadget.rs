//! R1CS gadgets for the v3 note bind. Field limbs are 51 bits.
//! A multiplication of two reduced field elements is an integer identity
//! in the Vesta scalar field, which is large enough for every intermediate
//! this file builds (under 2^120). Order reduction uses 52-bit limbs.
//! SHA-512 words are 64 bits. Products in the order gadget stay under 2^60.

use crate::fe25519::{edwards_d, ristretto_decompress, sqrt_m1, Ed, Fe};
use crate::r1cs::{
    r1cs_prove, r1cs_read, r1cs_verify, r1cs_write, R1csProof, Wire, ENCODE_IPA_ROUNDS,
    SLOT_IPA_ROUNDS,
};
use crate::tree::{note_u, ristretto_h_note};
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar as RScalar;
use curve25519_dalek::traits::Identity;
use sha2::{Digest, Sha512};
use ff::{Field, FromUniformBytes, PrimeField};
use group::GroupEncoding;
use pasta_curves::vesta;
use std::sync::OnceLock;

type Scalar = vesta::Scalar;

const MASK51: u128 = (1u128 << 51) - 1;
const TWO51_U: u128 = 1u128 << 51;

fn sc_u128(v: u128) -> Scalar {
    let mut b = [0u8; 32];
    b[..16].copy_from_slice(&v.to_le_bytes());
    Option::<Scalar>::from(Scalar::from_repr(b.into())).expect("u128 scalar")
}

fn two51() -> Scalar {
    Scalar::from(1u64 << 51)
}

struct Builder {
    l: Vec<Scalar>,
    r: Vec<Scalar>,
    o: Vec<Scalar>,
    cons: Vec<Vec<(Wire, Scalar)>>,
}

impl Builder {
    fn new() -> Self {
        Self { l: Vec::new(), r: Vec::new(), o: Vec::new(), cons: Vec::new() }
    }

    fn mul(&mut self, lv: Scalar, rv: Scalar) -> usize {
        let i = self.l.len();
        self.l.push(lv);
        self.r.push(rv);
        self.o.push(lv * rv);
        i
    }

    fn zero(&mut self, terms: Vec<(Wire, Scalar)>) {
        self.cons.push(terms);
    }

    fn bit(&mut self, bit: bool) -> Wire {
        let bv = if bit { Scalar::ONE } else { Scalar::ZERO };
        let i = self.mul(bv, bv - Scalar::ONE);
        // R = L - 1, so L*(L-1) = 0.
        self.zero(vec![
            (Wire::R(i), Scalar::ONE),
            (Wire::L(i), Scalar::ZERO - Scalar::ONE),
            (Wire::One, Scalar::ONE),
        ]);
        self.zero(vec![(Wire::O(i), Scalar::ONE)]);
        Wire::L(i)
    }

    /// `v` fits in `nbits`. Returns a left-wire equal to `v`.
    fn range(&mut self, v: u128, nbits: usize) -> Wire {
        assert!(nbits > 0 && nbits <= 120, "bit width");
        assert!(nbits == 120 || v < (1u128 << nbits), "value exceeds declared width");
        if nbits == 120 {
            assert!(v < (1u128 << 120), "value exceeds 120 bits");
        }
        let sv = sc_u128(v);
        let i = self.mul(sv, Scalar::ONE);
        self.zero(vec![
            (Wire::R(i), Scalar::ONE),
            (Wire::One, Scalar::ZERO - Scalar::ONE),
        ]);
        let mut terms = vec![(Wire::L(i), Scalar::ONE)];
        let mut rest = v;
        let mut pow = Scalar::ONE;
        let two = Scalar::from(2u64);
        for _ in 0..nbits {
            let bit = (rest & 1) == 1;
            rest >>= 1;
            let w = self.bit(bit);
            terms.push((w, Scalar::ZERO - pow));
            pow *= two;
        }
        assert_eq!(rest, 0, "range leftover");
        self.zero(terms);
        Wire::L(i)
    }

    fn const_eq(&mut self, w: Wire, v: Scalar) {
        self.zero(vec![(w, Scalar::ONE), (Wire::One, Scalar::ZERO - v)]);
    }
}

fn split51(cur: u128) -> (u128, u128) {
    (cur & MASK51, cur / TWO51_U)
}

/// `x + y_coeff*y = low + cout*2^51`. Only `low` and `cout` are ranged.
/// `x` and `y` are already bounded, and the sum is far below the Vesta order.
fn carry_add(
    b: &mut Builder,
    x: Wire,
    xv: u128,
    y: Option<Wire>,
    yv: u128,
    y_coeff: u128,
    cw: usize,
) -> (Wire, u128, Wire, u128) {
    let sum = xv + yv * y_coeff;
    let (low, cout) = split51(sum);
    let low_w = b.range(low, 51);
    let cout_w = b.range(cout, cw);
    let mut terms = vec![
        (x, Scalar::ONE),
        (low_w, Scalar::ZERO - Scalar::ONE),
        (cout_w, Scalar::ZERO - two51()),
    ];
    if let Some(yw) = y {
        if y_coeff == 1 {
            terms.push((yw, Scalar::ONE));
        } else {
            terms.push((yw, sc_u128(y_coeff)));
        }
    } else if y_coeff != 0 && yv != 0 {
        terms.push((Wire::One, sc_u128(yv * y_coeff)));
    }
    b.zero(terms);
    (low_w, low, cout_w, cout)
}

/// `limb0 += 19`, as a constant addend inside the carry (no extra wire).
fn carry_add_const(b: &mut Builder, x: Wire, xv: u128, extra: u128, cw: usize) -> (Wire, u128, Wire, u128) {
    let sum = xv + extra;
    let (low, cout) = split51(sum);
    let low_w = b.range(low, 51);
    let cout_w = b.range(cout, cw);
    b.zero(vec![
        (x, Scalar::ONE),
        (Wire::One, sc_u128(extra)),
        (low_w, Scalar::ZERO - Scalar::ONE),
        (cout_w, Scalar::ZERO - two51()),
    ]);
    (low_w, low, cout_w, cout)
}

/// Three reduction rounds matching `Fe::mul`, then the canonical `carry_full` finish.
fn reduce_wide(b: &mut Builder, mut wide_w: [Wire; 5], mut wide_v: [u128; 5]) -> ([Wire; 5], [u128; 5]) {
    for round in 0..3 {
        let cw = if round == 0 { 72 } else { 16 };
        let mut carry_w: Option<Wire> = None;
        let mut carry_v = 0u128;
        let mut n_w: [Wire; 5] = [Wire::One; 5];
        let mut n_v = [0u128; 5];
        for i in 0..5 {
            let (low_w, low_v, cout_w, cout_v) = carry_add(b, wide_w[i], wide_v[i], carry_w, carry_v, 1, cw);
            n_w[i] = low_w;
            n_v[i] = low_v;
            carry_w = Some(cout_w);
            carry_v = cout_v;
        }
        // `n0 + 19*carry` is the next limb 0. It is not masked.
        let sum_v = n_v[0] + carry_v * 19;
        let sum_w = b.range(sum_v, if round == 0 { 80 } else { 56 });
        b.zero(vec![
            (sum_w, Scalar::ONE),
            (n_w[0], Scalar::ZERO - Scalar::ONE),
            (carry_w.unwrap(), Scalar::ZERO - sc_u128(19)),
        ]);
        n_w[0] = sum_w;
        n_v[0] = sum_v;
        wide_w = n_w;
        wide_v = n_v;
    }
    for _ in 0..2 {
        let mut carry_w: Option<Wire> = None;
        let mut carry_v = 0u128;
        let mut n_w: [Wire; 5] = [Wire::One; 5];
        let mut n_v = [0u128; 5];
        for i in 0..5 {
            let (low_w, low_v, cout_w, cout_v) = carry_add(b, wide_w[i], wide_v[i], carry_w, carry_v, 1, 16);
            n_w[i] = low_w;
            n_v[i] = low_v;
            carry_w = Some(cout_w);
            carry_v = cout_v;
        }
        let sum_v = n_v[0] + carry_v * 19;
        let sum_w = b.range(sum_v, 56);
        b.zero(vec![
            (sum_w, Scalar::ONE),
            (n_w[0], Scalar::ZERO - Scalar::ONE),
            (carry_w.unwrap(), Scalar::ZERO - sc_u128(19)),
        ]);
        n_w[0] = sum_w;
        n_v[0] = sum_v;
        wide_w = n_w;
        wide_v = n_v;
    }
    let (low0, low0_v, c_w, c_v) = carry_add(b, wide_w[0], wide_v[0], None, 0, 0, 8);
    // `Fe::carry` leaves limb 1 unmasked. Masking it here would drop 2^51.
    let limb1_v = wide_v[1] + c_v;
    let limb1_w = b.range(limb1_v, 64);
    b.zero(vec![
        (limb1_w, Scalar::ONE),
        (wide_w[1], Scalar::ZERO - Scalar::ONE),
        (c_w, Scalar::ZERO - Scalar::ONE),
    ]);
    wide_w[0] = low0;
    wide_v[0] = low0_v;
    wide_w[1] = limb1_w;
    wide_v[1] = limb1_v;
    let (_d0, _, mut q_w, mut q_v) = carry_add_const(b, wide_w[0], wide_v[0], 19, 8);
    for i in 1..5 {
        let (_low, _, cout_w, cout_v) = carry_add(b, wide_w[i], wide_v[i], Some(q_w), q_v, 1, 8);
        q_w = cout_w;
        q_v = cout_v;
    }
    let (l0, l0v, c_w, c_v) = carry_add(b, wide_w[0], wide_v[0], Some(q_w), q_v, 19, 8);
    let (l1, l1v, c_w, c_v) = carry_add(b, wide_w[1], wide_v[1], Some(c_w), c_v, 1, 8);
    let (l2, l2v, c_w, c_v) = carry_add(b, wide_w[2], wide_v[2], Some(c_w), c_v, 1, 8);
    let (l3, l3v, c_w, c_v) = carry_add(b, wide_w[3], wide_v[3], Some(c_w), c_v, 1, 8);
    let (l4, l4v, extra_w, extra_v) = carry_add(b, wide_w[4], wide_v[4], Some(c_w), c_v, 1, 8);
    // Adding q*19 and dropping one 2^255 carry subtracts q*p.
    b.zero(vec![
        (extra_w, Scalar::ONE),
        (q_w, Scalar::ZERO - Scalar::ONE),
    ]);
    assert_eq!(extra_v, q_v, "reduce carry out must equal q");
    ([l0, l1, l2, l3, l4], [l0v, l1v, l2v, l3v, l4v])
}

fn limb_wire(b: &mut Builder, limb: u64, public: bool) -> Wire {
    let w = b.range(limb as u128, 51);
    if public {
        b.const_eq(w, Scalar::from(limb));
    }
    w
}

/// Constraints and witness that `c` is the field product `a * b`.
/// `a`, `b` and `c` are public limb constants. A false `c` still builds a transcript.
pub fn fe_mul_synth(a: Fe, b: Fe, c_claim: Fe) -> (Vec<Scalar>, Vec<Scalar>, Vec<Scalar>, Vec<Vec<(Wire, Scalar)>>) {
    let a = a.carry_full();
    let b = b.carry_full();
    let real = a.mul(b).carry_full();
    let mut bd = Builder::new();
    let mut aw = [Wire::One; 5];
    let mut bw = [Wire::One; 5];
    for i in 0..5 {
        aw[i] = limb_wire(&mut bd, a.0[i], true);
        bw[i] = limb_wire(&mut bd, b.0[i], true);
    }
    let mut t_v = [0u128; 5];
    let mut prods: Vec<(usize, Wire, u128)> = Vec::new();
    for i in 0..5 {
        for j in 0..5 {
            let k = i + j;
            let limb = k % 5;
            let factor: u128 = if k >= 5 { 19 } else { 1 };
            let av = a.0[i] as u128;
            let bv = b.0[j] as u128;
            let (pw, pv) = {
                // Multiply the public limb wires.
                let lv = Scalar::from(a.0[i]);
                let rv = Scalar::from(b.0[j]);
                let gi = bd.mul(lv, rv);
                bd.zero(vec![(Wire::L(gi), Scalar::ONE), (aw[i], Scalar::ZERO - Scalar::ONE)]);
                bd.zero(vec![(Wire::R(gi), Scalar::ONE), (bw[j], Scalar::ZERO - Scalar::ONE)]);
                (Wire::O(gi), av * bv)
            };
            t_v[limb] += pv * factor;
            prods.push((limb, pw, factor));
        }
    }
    let mut tw = [Wire::One; 5];
    for limb in 0..5 {
        let w = bd.range(t_v[limb], 120);
        let mut terms = vec![(w, Scalar::ONE)];
        for (k, pw, factor) in &prods {
            if *k == limb {
                terms.push((*pw, Scalar::ZERO - sc_u128(*factor)));
            }
        }
        bd.zero(terms);
        tw[limb] = w;
    }
    let (out, _out_v) = reduce_wide(&mut bd, tw, t_v);
    let claim = c_claim.carry_full();
    for i in 0..5 {
        bd.const_eq(out[i], Scalar::from(claim.0[i]));
    }
    let _ = real;
    (bd.l, bd.r, bd.o, bd.cons)
}

pub fn fe_mul_prove(a: Fe, b: Fe, c_claim: Fe) -> Option<R1csProof> {
    let (l, r, o, cons) = fe_mul_synth(a, b, c_claim);
    r1cs_prove(&l, &r, &o, &cons, &[])
}

pub fn fe_mul_verify(proof: &R1csProof, a: Fe, b: Fe, c_claim: Fe) -> bool {
    let (l, _, _, cons) = fe_mul_synth(a, b, c_claim);
    r1cs_verify(proof, l.len(), &cons)
}

pub fn fe_mul_witness_ok(a: Fe, b: Fe) -> bool {
    let c = a.mul(b);
    let (l, r, o, cons) = fe_mul_synth(a, b, c);
    r1cs_witness_holds(&l, &r, &o, &cons).is_ok()
}

fn r1cs_witness_holds(
    l: &[Scalar],
    r: &[Scalar],
    o: &[Scalar],
    cons: &[Vec<(Wire, Scalar)>],
) -> Result<(), String> {
    if l.len() != r.len() || l.len() != o.len() {
        return Err(format!("width l {} r {} o {}", l.len(), r.len(), o.len()));
    }
    for i in 0..l.len() {
        if l[i] * r[i] != o[i] {
            return Err(format!("gate {i}"));
        }
    }
    for (ci, cns) in cons.iter().enumerate() {
        let mut s = Scalar::ZERO;
        for (w, coeff) in cns {
            let v = match *w {
                Wire::L(i) => *l.get(i).ok_or_else(|| format!("constraint {ci} L {i}"))?,
                Wire::R(i) => *r.get(i).ok_or_else(|| format!("constraint {ci} R {i}"))?,
                Wire::O(i) => *o.get(i).ok_or_else(|| format!("constraint {ci} O {i}"))?,
                Wire::One => Scalar::ONE,
                Wire::V(i) => return Err(format!("constraint {ci} uses committed wire {i}")),
            };
            s += *coeff * v;
        }
        if s != Scalar::ZERO {
            return Err(format!("constraint {ci}"));
        }
    }
    Ok(())
}

/// Same as `r1cs_witness_holds`, with `Wire::V(i)` substituted from `committed`.
fn r1cs_witness_holds_v(
    l: &[Scalar],
    r: &[Scalar],
    o: &[Scalar],
    cons: &[Vec<(Wire, Scalar)>],
    committed: &[Scalar],
) -> Result<(), String> {
    if l.len() != r.len() || l.len() != o.len() {
        return Err(format!("width l {} r {} o {}", l.len(), r.len(), o.len()));
    }
    for i in 0..l.len() {
        if l[i] * r[i] != o[i] {
            return Err(format!("gate {i}"));
        }
    }
    for (ci, cns) in cons.iter().enumerate() {
        let mut s = Scalar::ZERO;
        for (w, coeff) in cns {
            let v = match *w {
                Wire::L(i) => *l.get(i).ok_or_else(|| format!("constraint {ci} L {i}"))?,
                Wire::R(i) => *r.get(i).ok_or_else(|| format!("constraint {ci} R {i}"))?,
                Wire::O(i) => *o.get(i).ok_or_else(|| format!("constraint {ci} O {i}"))?,
                Wire::One => Scalar::ONE,
                Wire::V(i) => *committed.get(i).ok_or_else(|| format!("constraint {ci} V {i}"))?,
            };
            s += *coeff * v;
        }
        if s != Scalar::ZERO {
            return Err(format!("constraint {ci} residual"));
        }
    }
    Ok(())
}

/// A canonical field element as five 51-bit wires, plus the limb values.
#[derive(Clone, Copy)]
struct FeW {
    w: [Wire; 5],
    v: [u128; 5],
}

fn fe_from_limbs(v: &[u128; 5]) -> Fe {
    Fe([v[0] as u64, v[1] as u64, v[2] as u64, v[3] as u64, v[4] as u64])
}

fn fe_priv(b: &mut Builder, f: Fe) -> FeW {
    let f = f.carry_full();
    let mut w = [Wire::One; 5];
    let mut v = [0u128; 5];
    for i in 0..5 {
        v[i] = f.0[i] as u128;
        w[i] = b.range(v[i], 51);
    }
    FeW { w, v }
}

fn fe_const(b: &mut Builder, f: Fe) -> FeW {
    let f = f.carry_full();
    let out = fe_priv(b, f);
    for i in 0..5 {
        b.const_eq(out.w[i], Scalar::from(f.0[i]));
    }
    out
}

/// `low + cout·2^51 + sum(neg) = constant + sum(pos)`.
/// `value` is that integer. Widths are fixed, so coefficients do not depend on it.
fn split_linear(
    b: &mut Builder,
    pos: &[(Wire, u128)],
    neg: &[(Wire, u128)],
    constant: u128,
    value: u128,
    cout_bits: usize,
) -> (Wire, u128, Wire, u128) {
    let low = value & MASK51;
    let cout = value >> 51;
    assert!(
        cout < (1u128 << cout_bits),
        "split carry {cout} exceeds {cout_bits} bits"
    );
    let low_w = b.range(low, 51);
    let cout_w = b.range(cout, cout_bits);
    let mut terms = vec![(low_w, Scalar::ONE), (cout_w, two51())];
    for (w, c) in neg {
        terms.push((*w, sc_u128(*c)));
    }
    for (w, c) in pos {
        terms.push((*w, Scalar::ZERO - sc_u128(*c)));
    }
    if constant != 0 {
        terms.push((Wire::One, Scalar::ZERO - sc_u128(constant)));
    }
    b.zero(terms);
    (low_w, low, cout_w, cout)
}

/// One 51-bit ripple. `values[i]` already includes `constants[i]` and not the carry-in.
fn ripple_rows(
    b: &mut Builder,
    rows: &[Vec<(Wire, u128)>; 5],
    neg_rows: &[Vec<(Wire, u128)>; 5],
    constants: &[u128; 5],
    values: &[u128; 5],
    cout_bits: usize,
) -> ([Wire; 5], [u128; 5], Wire, u128) {
    let mut c_w: Option<Wire> = None;
    let mut c_v = 0u128;
    let mut low_w = [Wire::One; 5];
    let mut low_v = [0u128; 5];
    for i in 0..5 {
        let mut pos = rows[i].clone();
        if let Some(w) = c_w {
            pos.push((w, 1));
        }
        let (lw, lv, cw, cv) = split_linear(
            b,
            &pos,
            &neg_rows[i],
            constants[i],
            values[i] + c_v,
            cout_bits,
        );
        low_w[i] = lw;
        low_v[i] = lv;
        c_w = Some(cw);
        c_v = cv;
    }
    (low_w, low_v, c_w.expect("ripple carry"), c_v)
}

/// Subtract `q·p` when the 51-bit limb vector is at least `p`.
fn q_finish(b: &mut Builder, w: [Wire; 5], v: [u128; 5]) -> FeW {
    for limb in &v {
        assert!(*limb < TWO51_U, "q_finish input is not 51 bits");
    }
    let expect = fe_from_limbs(&v).carry_full();
    let qv = (0..5).any(|i| expect.0[i] as u128 != v[i]);
    let q_w = b.range(if qv { 1 } else { 0 }, 1);
    let mut c_w: Option<Wire> = None;
    let mut c_v = 0u128;
    let mut out_w = [Wire::One; 5];
    let mut out_v = [0u128; 5];
    for i in 0..5 {
        let mut pos = vec![(w[i], 1u128)];
        let mut rhs = v[i] + c_v;
        if i == 0 {
            pos.push((q_w, 19));
            rhs += 19 * u128::from(qv);
        }
        if let Some(cw) = c_w {
            pos.push((cw, 1));
        }
        let (lw, lv, cw, cv) = split_linear(b, &pos, &[], 0, rhs, 1);
        out_w[i] = lw;
        out_v[i] = lv;
        c_w = Some(cw);
        c_v = cv;
    }
    let final_c = c_w.expect("q carry");
    b.zero(vec![
        (final_c, Scalar::ONE),
        (q_w, Scalar::ZERO - Scalar::ONE),
    ]);
    assert_eq!(c_v, u128::from(qv), "q carry did not match q");
    for i in 0..5 {
        assert_eq!(out_v[i], expect.0[i] as u128, "q_finish limb {i}");
    }
    FeW { w: out_w, v: out_v }
}

fn empty_rows() -> [Vec<(Wire, u128)>; 5] {
    std::array::from_fn(|_| Vec::new())
}

fn fe_add(b: &mut Builder, a: FeW, c: FeW) -> FeW {
    let mut rows = empty_rows();
    let mut values = [0u128; 5];
    for i in 0..5 {
        rows[i].push((a.w[i], 1));
        rows[i].push((c.w[i], 1));
        values[i] = a.v[i] + c.v[i];
    }
    let zeros = [0u128; 5];
    let (low_w, low_v, c_w, c_v) = ripple_rows(b, &rows, &empty_rows(), &zeros, &values, 2);
    let mut fold_rows = empty_rows();
    let mut fold_vals = low_v;
    fold_vals[0] = low_v[0] + 19 * c_v;
    for i in 0..5 {
        fold_rows[i].push((low_w[i], 1));
    }
    fold_rows[0].push((c_w, 19));
    let (out_w, out_v, _c2, c2_v) = ripple_rows(b, &fold_rows, &empty_rows(), &zeros, &fold_vals, 2);
    assert_eq!(c2_v, 0, "field add produced a second 2^255 carry");
    q_finish(b, out_w, out_v)
}

fn p2_limbs() -> [u128; 5] {
    let m = (1u128 << 51) - 1;
    [(m - 18) * 2, m * 2, m * 2, m * 2, m * 2]
}

fn fe_sub(b: &mut Builder, a: FeW, c: FeW) -> FeW {
    let p2 = p2_limbs();
    let mut rows = empty_rows();
    let mut neg = empty_rows();
    let mut values = [0u128; 5];
    for i in 0..5 {
        rows[i].push((a.w[i], 1));
        neg[i].push((c.w[i], 1));
        values[i] = a.v[i] + p2[i] - c.v[i];
    }
    let (low_w, low_v, c_w, c_v) = ripple_rows(b, &rows, &neg, &p2, &values, 4);
    let mut fold_rows = empty_rows();
    let mut fold_vals = low_v;
    fold_vals[0] = low_v[0] + 19 * c_v;
    for i in 0..5 {
        fold_rows[i].push((low_w[i], 1));
    }
    fold_rows[0].push((c_w, 19));
    let zeros = [0u128; 5];
    let (out_w, out_v, c2_w, c2_v) = ripple_rows(b, &fold_rows, &empty_rows(), &zeros, &fold_vals, 4);
    let mut fold2 = empty_rows();
    let mut fold2_vals = out_v;
    fold2_vals[0] = out_v[0] + 19 * c2_v;
    for i in 0..5 {
        fold2[i].push((out_w[i], 1));
    }
    fold2[0].push((c2_w, 19));
    let (done_w, done_v, _c3, c3_v) = ripple_rows(b, &fold2, &empty_rows(), &zeros, &fold2_vals, 2);
    assert_eq!(c3_v, 0, "field sub produced a third 2^255 carry");
    q_finish(b, done_w, done_v)
}

fn fe_neg(b: &mut Builder, a: FeW) -> FeW {
    let z = fe_const(b, Fe::ZERO);
    fe_sub(b, z, a)
}

/// Schoolbook product of two canonical field wires. Same residue as `Fe::mul`.
/// Products stay under 2^102, inside the Vesta scalar field, so they are not ranged.
/// Carries are ranged once. Already-reduced limbs are not decomposed again.
fn fe_mul(b: &mut Builder, a: FeW, c: FeW) -> FeW {
    for i in 0..5 {
        assert!(a.v[i] < TWO51_U && c.v[i] < TWO51_U, "mul input is not 51 bits");
    }
    let real = fe_from_limbs(&a.v).mul(fe_from_limbs(&c.v)).carry_full();
    let mut prod_w = [[Wire::One; 5]; 5];
    let mut prod_v = [[0u128; 5]; 5];
    for i in 0..5 {
        for j in 0..5 {
            let av = a.v[i];
            let bv = c.v[j];
            let gi = b.mul(sc_u128(av), sc_u128(bv));
            b.zero(vec![(Wire::L(gi), Scalar::ONE), (a.w[i], Scalar::ZERO - Scalar::ONE)]);
            b.zero(vec![(Wire::R(gi), Scalar::ONE), (c.w[j], Scalar::ZERO - Scalar::ONE)]);
            prod_w[i][j] = Wire::O(gi);
            prod_v[i][j] = av * bv;
        }
    }
    let mut rows = empty_rows();
    let mut t_v = [0u128; 5];
    for i in 0..5 {
        for j in 0..5 {
            let k = i + j;
            let limb = k % 5;
            let factor: u128 = if k >= 5 { 19 } else { 1 };
            rows[limb].push((prod_w[i][j], factor));
            t_v[limb] += prod_v[i][j] * factor;
        }
    }
    let zeros = [0u128; 5];
    let (low_w, low_v, c_w, c_v) = ripple_rows(b, &rows, &empty_rows(), &zeros, &t_v, 60);
    let mut fold_rows = empty_rows();
    let mut fold_vals = low_v;
    fold_vals[0] = low_v[0] + 19 * c_v;
    for i in 0..5 {
        fold_rows[i].push((low_w[i], 1));
    }
    fold_rows[0].push((c_w, 19));
    let (mid_w, mid_v, c2_w, c2_v) = ripple_rows(b, &fold_rows, &empty_rows(), &zeros, &fold_vals, 16);
    // `c2` is 0 or 1. Folding it subtracts another `p` when the 19·c4 add crosses 2^255.
    let mut fold2 = empty_rows();
    let mut fold2_vals = mid_v;
    fold2_vals[0] = mid_v[0] + 19 * c2_v;
    for i in 0..5 {
        fold2[i].push((mid_w[i], 1));
    }
    fold2[0].push((c2_w, 19));
    let (out_w, out_v, _c3, c3_v) = ripple_rows(b, &fold2, &empty_rows(), &zeros, &fold2_vals, 2);
    assert_eq!(c3_v, 0, "field mul produced a third 2^255 carry");
    let out = q_finish(b, out_w, out_v);
    let exp = [
        real.0[0] as u128,
        real.0[1] as u128,
        real.0[2] as u128,
        real.0[3] as u128,
        real.0[4] as u128,
    ];
    assert_eq!(out.v, exp, "fe_mul diverges from Fe::mul");
    out
}

fn fe_select(b: &mut Builder, bit: Wire, bit_v: bool, a: FeW, c: FeW) -> FeW {
    let bit_s = if bit_v { Scalar::ONE } else { Scalar::ZERO };
    let mut w = [Wire::One; 5];
    let mut v = [0u128; 5];
    for i in 0..5 {
        let diff = sc_u128(a.v[i]) - sc_u128(c.v[i]);
        let gi = b.mul(bit_s, diff);
        b.zero(vec![(Wire::L(gi), Scalar::ONE), (bit, Scalar::ZERO - Scalar::ONE)]);
        b.zero(vec![
            (Wire::R(gi), Scalar::ONE),
            (a.w[i], Scalar::ZERO - Scalar::ONE),
            (c.w[i], Scalar::ONE),
        ]);
        v[i] = if bit_v { a.v[i] } else { c.v[i] };
        w[i] = b.range(v[i], 51);
        b.zero(vec![
            (w[i], Scalar::ONE),
            (c.w[i], Scalar::ZERO - Scalar::ONE),
            (Wire::O(gi), Scalar::ZERO - Scalar::ONE),
        ]);
    }
    FeW { w, v }
}

fn low_bit(b: &mut Builder, f: &FeW) -> (Wire, bool) {
    assert!(f.v[0] < TWO51_U, "sign of a non-canonical limb");
    let neg = (f.v[0] & 1) == 1;
    let bit_w = b.bit(neg);
    let rest_w = b.range(f.v[0] >> 1, 50);
    b.zero(vec![
        (f.w[0], Scalar::ONE),
        (bit_w, Scalar::ZERO - Scalar::ONE),
        (rest_w, Scalar::ZERO - Scalar::from(2u64)),
    ]);
    (bit_w, neg)
}

fn fe_is_zero(b: &mut Builder, f: &FeW) -> (Wire, bool) {
    let sum_v: u128 = f.v.iter().copied().sum();
    let sum_w = b.range(sum_v, 56);
    let mut terms = vec![(sum_w, Scalar::ONE)];
    for i in 0..5 {
        terms.push((f.w[i], Scalar::ZERO - Scalar::ONE));
    }
    b.zero(terms);
    let z = sum_v == 0;
    let z_s = if z { Scalar::ONE } else { Scalar::ZERO };
    let gi = b.mul(z_s, sc_u128(sum_v));
    let zw = b.bit(z);
    b.zero(vec![(Wire::L(gi), Scalar::ONE), (zw, Scalar::ZERO - Scalar::ONE)]);
    b.zero(vec![(Wire::R(gi), Scalar::ONE), (sum_w, Scalar::ZERO - Scalar::ONE)]);
    b.zero(vec![(Wire::O(gi), Scalar::ONE)]);
    (zw, z)
}

/// Nonnegative inverse square root: `s^2 * v = 1` when `v != 0`, and `s = 0` when `v = 0`.
fn force_invsqrt(b: &mut Builder, s: &FeW, v: &FeW) {
    let vv = fe_from_limbs(&v.v);
    let ss = fe_from_limbs(&s.v);
    if vv.to_bytes() == [0u8; 32] {
        assert_eq!(ss.to_bytes(), [0u8; 32], "invsqrt(0) is not zero");
    } else {
        let prod = ss.mul(ss).mul(vv);
        assert_eq!(prod.to_bytes(), Fe::ONE.to_bytes(), "invsqrt witness is not an inverse square root");
    }
    let (sign, neg) = low_bit(b, s);
    assert!(!neg, "invsqrt witness is negative");
    b.const_eq(sign, Scalar::ZERO);
    let ss = fe_mul(b, *s, *s);
    let prod = fe_mul(b, ss, *v);
    let (z_w, z_v) = fe_is_zero(b, v);
    let not_v = !z_v;
    let not_w = b.bit(not_v);
    b.zero(vec![
        (not_w, Scalar::ONE),
        (z_w, Scalar::ONE),
        (Wire::One, Scalar::ZERO - Scalar::ONE),
    ]);
    let not_s = if not_v { Scalar::ONE } else { Scalar::ZERO };
    let one = [1u64, 0, 0, 0, 0];
    for i in 0..5 {
        let delta = sc_u128(prod.v[i]) - Scalar::from(one[i]);
        let gi = b.mul(not_s, delta);
        b.zero(vec![(Wire::L(gi), Scalar::ONE), (not_w, Scalar::ZERO - Scalar::ONE)]);
        b.zero(vec![
            (Wire::R(gi), Scalar::ONE),
            (prod.w[i], Scalar::ZERO - Scalar::ONE),
            (Wire::One, Scalar::from(one[i])),
        ]);
        b.zero(vec![(Wire::O(gi), Scalar::ONE)]);
    }
    let z_s = if z_v { Scalar::ONE } else { Scalar::ZERO };
    for i in 0..5 {
        let gi = b.mul(z_s, sc_u128(s.v[i]));
        b.zero(vec![(Wire::L(gi), Scalar::ONE), (z_w, Scalar::ZERO - Scalar::ONE)]);
        b.zero(vec![(Wire::R(gi), Scalar::ONE), (s.w[i], Scalar::ZERO - Scalar::ONE)]);
        b.zero(vec![(Wire::O(gi), Scalar::ONE)]);
    }
}

fn magic_fe() -> Fe {
    let a_minus_d = Fe::ONE.neg().sub(edwards_d());
    let (ok, s) = a_minus_d.invsqrt();
    assert!(ok);
    s
}

fn fe_cond_neg(b: &mut Builder, bit: Wire, bit_v: bool, a: FeW) -> FeW {
    let n = fe_neg(b, a);
    fe_select(b, bit, bit_v, n, a)
}

/// `s` is the ristretto encoding as a canonical field element.
/// The caller compares `s` with the claimed bytes. No inner product proof here.
fn compress_fe(b: &mut Builder, x: FeW, y: FeW, z: FeW, t: FeW) -> FeW {
    let z_plus_y = fe_add(b, z, y);
    let z_sub_y = fe_sub(b, z, y);
    let u1 = fe_mul(b, z_plus_y, z_sub_y);
    let u2 = fe_mul(b, x, y);
    let u2sq = fe_mul(b, u2, u2);
    let v = fe_mul(b, u1, u2sq);
    let inv_fe = v_invsqrt_witness(&v);
    let inv = fe_priv(b, inv_fe);
    force_invsqrt(b, &inv, &v);
    let i1 = fe_mul(b, inv, u1);
    let i2 = fe_mul(b, inv, u2);
    let i2t = fe_mul(b, i2, t);
    let z_inv = fe_mul(b, i1, i2t);
    let sqrt_m = fe_const(b, sqrt_m1());
    let magic = fe_const(b, magic_fe());
    let i_x = fe_mul(b, x, sqrt_m);
    let i_y = fe_mul(b, y, sqrt_m);
    let enchanted = fe_mul(b, i1, magic);
    let rot_in = fe_mul(b, t, z_inv);
    let (rot_w, rot_v) = low_bit(b, &rot_in);
    let x = fe_select(b, rot_w, rot_v, i_y, x);
    let y = fe_select(b, rot_w, rot_v, i_x, y);
    let den = fe_select(b, rot_w, rot_v, enchanted, i2);
    let y_chk = fe_mul(b, x, z_inv);
    let (ybit_w, ybit_v) = low_bit(b, &y_chk);
    let y = fe_cond_neg(b, ybit_w, ybit_v, y);
    let z_sub = fe_sub(b, z, y);
    let s = fe_mul(b, den, z_sub);
    let (sbit_w, sbit_v) = low_bit(b, &s);
    fe_cond_neg(b, sbit_w, sbit_v, s)
}

/// Witness that `claim` is `Ed::ristretto_compress` of `ed`.
/// Inverse square root is a witness, checked by `s^2 * v = 1`, not by exponentiation.
/// This builds constraints only. It does not run the inner product proof.
pub(crate) fn ristretto_compress_synth(
    ed: Ed,
    claim: &[u8; 32],
) -> (Vec<Scalar>, Vec<Scalar>, Vec<Scalar>, Vec<Vec<(Wire, Scalar)>>) {
    let expect_enc = ed.ristretto_compress();
    let ed = Ed {
        x: ed.x.carry_full(),
        y: ed.y.carry_full(),
        z: ed.z.carry_full(),
        t: ed.t.carry_full(),
    };
    assert_eq!(ed.ristretto_compress(), expect_enc, "canonical coords changed the encoding");
    let mut b = Builder::new();
    let x = fe_priv(&mut b, ed.x);
    let y = fe_priv(&mut b, ed.y);
    let z = fe_priv(&mut b, ed.z);
    let t = fe_priv(&mut b, ed.t);
    let s = compress_fe(&mut b, x, y, z, t);
    let claim_fe = Fe::from_bytes(claim).carry_full();
    for i in 0..5 {
        b.const_eq(s.w[i], Scalar::from(claim_fe.0[i]));
    }
    (b.l, b.r, b.o, b.cons)
}

fn v_invsqrt_witness(v: &FeW) -> Fe {
    let (_ok, s) = fe_from_limbs(&v.v).invsqrt();
    s.carry_full()
}

const BASE52: u128 = 1u128 << 52;
/// Ristretto group order in 52-bit limbs: 2^252 + 27742317777372353535851937790883648493.
const L52: [u128; 5] = [
    0x0002_631a_5cf5_d3ed,
    0x000d_ea2f_79cd_6581,
    0x0000_0000_0014_def9,
    0,
    0x0000_1000_0000_0000,
];

#[derive(Clone, Copy)]
struct Limb {
    w: Wire,
    v: u128,
}

#[derive(Clone, Copy)]
struct Bw {
    w: Wire,
    v: u128,
}

fn unpack52(bytes: &[u8; 32]) -> [u128; 5] {
    let mut words = [0u128; 4];
    for i in 0..4 {
        for j in 0..8 {
            words[i] |= (bytes[i * 8 + j] as u128) << (j * 8);
        }
    }
    let mask = BASE52 - 1;
    let top = (1u128 << 48) - 1;
    [
        words[0] & mask,
        ((words[0] >> 52) | (words[1] << 12)) & mask,
        ((words[1] >> 40) | (words[2] << 24)) & mask,
        ((words[2] >> 28) | (words[3] << 36)) & mask,
        (words[3] >> 16) & top,
    ]
}

fn pack52(s: &[u128; 5]) -> [u8; 32] {
    let z = [s[0] as u64, s[1] as u64, s[2] as u64, s[3] as u64, s[4] as u64];
    let mut o = [0u8; 32];
    o[0] = (z[0] >> 0) as u8;
    o[1] = (z[0] >> 8) as u8;
    o[2] = (z[0] >> 16) as u8;
    o[3] = (z[0] >> 24) as u8;
    o[4] = (z[0] >> 32) as u8;
    o[5] = (z[0] >> 40) as u8;
    o[6] = ((z[0] >> 48) | (z[1] << 4)) as u8;
    o[7] = (z[1] >> 4) as u8;
    o[8] = (z[1] >> 12) as u8;
    o[9] = (z[1] >> 20) as u8;
    o[10] = (z[1] >> 28) as u8;
    o[11] = (z[1] >> 36) as u8;
    o[12] = (z[1] >> 44) as u8;
    o[13] = (z[2] >> 0) as u8;
    o[14] = (z[2] >> 8) as u8;
    o[15] = (z[2] >> 16) as u8;
    o[16] = (z[2] >> 24) as u8;
    o[17] = (z[2] >> 32) as u8;
    o[18] = (z[2] >> 40) as u8;
    o[19] = ((z[2] >> 48) | (z[3] << 4)) as u8;
    o[20] = (z[3] >> 4) as u8;
    o[21] = (z[3] >> 12) as u8;
    o[22] = (z[3] >> 20) as u8;
    o[23] = (z[3] >> 28) as u8;
    o[24] = (z[3] >> 36) as u8;
    o[25] = (z[3] >> 44) as u8;
    o[26] = (z[4] >> 0) as u8;
    o[27] = (z[4] >> 8) as u8;
    o[28] = (z[4] >> 16) as u8;
    o[29] = (z[4] >> 24) as u8;
    o[30] = (z[4] >> 32) as u8;
    o[31] = (z[4] >> 40) as u8;
    o
}

/// `n mod L` for a 256-bit little-endian integer, as five 52-bit limbs.
/// `q < 16` because `n < 2^256` and `L > 2^252`.
fn order_limbs(bytes: &[u8; 32]) -> [u128; 5] {
    let s = unpack52(bytes);
    let n_hi = s[4] >> 44;
    let mut n_lo = s;
    n_lo[4] &= (1u128 << 44) - 1;
    let mut prod = [0u128; 5];
    let mut carry = 0u128;
    for i in 0..3 {
        let raw = n_hi * L52[i] + carry;
        prod[i] = raw & (BASE52 - 1);
        carry = raw >> 52;
    }
    prod[3] = carry;
    assert!(prod[3] < BASE52, "order product spilled a limb");
    let mut t = [0u128; 5];
    let mut c_enc: i128 = 1;
    for i in 0..5 {
        let raw = n_lo[i] as i128 + L52[i] as i128 - prod[i] as i128 + (c_enc - 1);
        let cout = raw.div_euclid(BASE52 as i128);
        t[i] = raw.rem_euclid(BASE52 as i128) as u128;
        c_enc = cout + 1;
        assert!(c_enc >= 0 && c_enc < 4, "order carry left the expected range");
    }
    assert_eq!(c_enc, 1, "order sum spilled past 260 bits");
    let mut borrow: i128 = 0;
    let mut diff = [0u128; 5];
    for i in 0..5 {
        let raw = t[i] as i128 - L52[i] as i128 - borrow;
        if raw < 0 {
            diff[i] = (raw + BASE52 as i128) as u128;
            borrow = 1;
        } else {
            diff[i] = raw as u128;
            borrow = 0;
        }
    }
    if borrow == 0 { diff } else { t }
}

fn split4(b: &mut Builder, byte: Bw) -> (Bw, Bw) {
    let lo = byte.v & 0xf;
    let hi = byte.v >> 4;
    let lo_w = b.range(lo, 4);
    let hi_w = b.range(hi, 4);
    b.zero(vec![
        (byte.w, Scalar::ONE),
        (lo_w, Scalar::ZERO - Scalar::ONE),
        (hi_w, Scalar::ZERO - sc_u128(16)),
    ]);
    (Bw { w: lo_w, v: lo }, Bw { w: hi_w, v: hi })
}

fn lin_limb(b: &mut Builder, terms: &[(Wire, u128)], v: u128, nbits: usize) -> Limb {
    assert!(v < (1u128 << nbits), "linear limb exceeds its width");
    let w = b.range(v, nbits);
    let mut acc = vec![(w, Scalar::ZERO - Scalar::ONE)];
    for (tw, coeff) in terms {
        acc.push((*tw, sc_u128(*coeff)));
    }
    b.zero(acc);
    Limb { w, v }
}

fn split52(b: &mut Builder, raw: Limb) -> (Limb, Limb) {
    let low = raw.v & (BASE52 - 1);
    let hi = raw.v >> 52;
    let low_w = b.range(low, 52);
    // Fixed width so the constraint list does not depend on the witness.
    let hi_bits = 16usize;
    assert!(hi < (1u128 << hi_bits), "split52 high limb exceeds 16 bits");
    let hi_w = b.range(hi, hi_bits);
    b.zero(vec![
        (raw.w, Scalar::ONE),
        (low_w, Scalar::ZERO - Scalar::ONE),
        (hi_w, Scalar::ZERO - sc_u128(BASE52)),
    ]);
    (Limb { w: low_w, v: low }, Limb { w: hi_w, v: hi })
}

fn mul_const(b: &mut Builder, limb: Limb, k: u128) -> Limb {
    let prod = limb.v * k;
    let gi = b.mul(sc_u128(limb.v), sc_u128(k));
    b.zero(vec![(Wire::L(gi), Scalar::ONE), (limb.w, Scalar::ZERO - Scalar::ONE)]);
    b.zero(vec![(Wire::R(gi), Scalar::ONE), (Wire::One, Scalar::ZERO - sc_u128(k))]);
    Limb { w: Wire::O(gi), v: prod }
}

fn limb_sum(b: &mut Builder, parts: &[Limb]) -> Limb {
    let v: u128 = parts.iter().map(|p| p.v).sum();
    // Fixed width so the constraint list does not depend on the witness.
    let bits = 60usize;
    assert!(v < (1u128 << bits), "limb sum exceeds 60 bits");
    let w = b.range(v, bits);
    let mut terms = vec![(w, Scalar::ZERO - Scalar::ONE)];
    for p in parts {
        terms.push((p.w, Scalar::ONE));
    }
    b.zero(terms);
    Limb { w, v }
}

fn t_limb(b: &mut Builder, nlo: Limb, lconst: u128, prod: Limb, c_in: Limb) -> (Limb, Limb) {
    let raw = nlo.v as i128 + lconst as i128 - prod.v as i128 + (c_in.v as i128 - 1);
    let cout = raw.div_euclid(BASE52 as i128);
    let out = raw.rem_euclid(BASE52 as i128) as u128;
    let c_out = (cout + 1) as u128;
    assert!(c_out < 4, "circuit order carry left the expected range");
    let out_w = b.range(out, 52);
    let c_w = b.range(c_out, 2);
    b.zero(vec![
        (nlo.w, Scalar::ONE),
        (Wire::One, sc_u128(lconst) + sc_u128(BASE52 - 1)),
        (c_in.w, Scalar::ONE),
        (out_w, Scalar::ZERO - Scalar::ONE),
        (prod.w, Scalar::ZERO - Scalar::ONE),
        (c_w, Scalar::ZERO - sc_u128(BASE52)),
    ]);
    (Limb { w: out_w, v: out }, Limb { w: c_w, v: c_out })
}

fn sub_l_limb(b: &mut Builder, t: Limb, lconst: u128, bin: Limb) -> (Limb, Limb) {
    let raw = t.v as i128 - lconst as i128 - bin.v as i128;
    let (diff, bout) = if raw >= 0 {
        (raw as u128, 0u128)
    } else {
        ((raw + BASE52 as i128) as u128, 1u128)
    };
    let diff_w = b.range(diff, 52);
    let bout_w = b.bit(bout == 1);
    b.zero(vec![
        (t.w, Scalar::ONE),
        (bout_w, sc_u128(BASE52)),
        (Wire::One, Scalar::ZERO - sc_u128(lconst)),
        (diff_w, Scalar::ZERO - Scalar::ONE),
        (bin.w, Scalar::ZERO - Scalar::ONE),
    ]);
    (Limb { w: diff_w, v: diff }, Limb { w: bout_w, v: bout })
}

fn select_limb(b: &mut Builder, bit: Limb, a: Limb, c: Limb) -> Limb {
    let v = if bit.v == 1 { a.v } else { c.v };
    let delta = sc_u128(a.v) - sc_u128(c.v);
    let bs = if bit.v == 1 { Scalar::ONE } else { Scalar::ZERO };
    let gi = b.mul(bs, delta);
    b.zero(vec![(Wire::L(gi), Scalar::ONE), (bit.w, Scalar::ZERO - Scalar::ONE)]);
    b.zero(vec![
        (Wire::R(gi), Scalar::ONE),
        (a.w, Scalar::ZERO - Scalar::ONE),
        (c.w, Scalar::ONE),
    ]);
    let w = b.range(v, 52);
    b.zero(vec![
        (w, Scalar::ONE),
        (c.w, Scalar::ZERO - Scalar::ONE),
        (Wire::O(gi), Scalar::ZERO - Scalar::ONE),
    ]);
    Limb { w, v }
}

/// Reduced 52-bit limbs of `bytes` mod the ristretto order.
/// Widths are fixed, so the constraint coefficients do not depend on `bytes`.
/// The third value is the 8-bit wire for each input byte.
fn order_reduce_into(mut b: Builder, bytes: &[u8; 32]) -> (Builder, [Limb; 5], [Bw; 32]) {
    let raw = unpack52(bytes);
    let mut bts = [Bw { w: Wire::One, v: 0 }; 32];
    for i in 0..32 {
        let v = bytes[i] as u128;
        bts[i] = Bw { w: b.range(v, 8), v };
    }
    let (lo6, hi6) = split4(&mut b, bts[6]);
    let (lo19, hi19) = split4(&mut b, bts[19]);
    let s0 = lin_limb(
        &mut b,
        &[
            (bts[0].w, 1),
            (bts[1].w, 1 << 8),
            (bts[2].w, 1 << 16),
            (bts[3].w, 1 << 24),
            (bts[4].w, 1 << 32),
            (bts[5].w, 1 << 40),
            (lo6.w, 1 << 48),
        ],
        bts[0].v
            + (bts[1].v << 8)
            + (bts[2].v << 16)
            + (bts[3].v << 24)
            + (bts[4].v << 32)
            + (bts[5].v << 40)
            + (lo6.v << 48),
        52,
    );
    let s1 = lin_limb(
        &mut b,
        &[
            (hi6.w, 1),
            (bts[7].w, 1 << 4),
            (bts[8].w, 1 << 12),
            (bts[9].w, 1 << 20),
            (bts[10].w, 1 << 28),
            (bts[11].w, 1 << 36),
            (bts[12].w, 1 << 44),
        ],
        hi6.v
            + (bts[7].v << 4)
            + (bts[8].v << 12)
            + (bts[9].v << 20)
            + (bts[10].v << 28)
            + (bts[11].v << 36)
            + (bts[12].v << 44),
        52,
    );
    let s2 = lin_limb(
        &mut b,
        &[
            (bts[13].w, 1),
            (bts[14].w, 1 << 8),
            (bts[15].w, 1 << 16),
            (bts[16].w, 1 << 24),
            (bts[17].w, 1 << 32),
            (bts[18].w, 1 << 40),
            (lo19.w, 1 << 48),
        ],
        bts[13].v
            + (bts[14].v << 8)
            + (bts[15].v << 16)
            + (bts[16].v << 24)
            + (bts[17].v << 32)
            + (bts[18].v << 40)
            + (lo19.v << 48),
        52,
    );
    let s3 = lin_limb(
        &mut b,
        &[
            (hi19.w, 1),
            (bts[20].w, 1 << 4),
            (bts[21].w, 1 << 12),
            (bts[22].w, 1 << 20),
            (bts[23].w, 1 << 28),
            (bts[24].w, 1 << 36),
            (bts[25].w, 1 << 44),
        ],
        hi19.v
            + (bts[20].v << 4)
            + (bts[21].v << 12)
            + (bts[22].v << 20)
            + (bts[23].v << 28)
            + (bts[24].v << 36)
            + (bts[25].v << 44),
        52,
    );
    let s4 = lin_limb(
        &mut b,
        &[
            (bts[26].w, 1),
            (bts[27].w, 1 << 8),
            (bts[28].w, 1 << 16),
            (bts[29].w, 1 << 24),
            (bts[30].w, 1 << 32),
            (bts[31].w, 1 << 40),
        ],
        bts[26].v
            + (bts[27].v << 8)
            + (bts[28].v << 16)
            + (bts[29].v << 24)
            + (bts[30].v << 32)
            + (bts[31].v << 40),
        48,
    );
    assert_eq!([s0.v, s1.v, s2.v, s3.v, s4.v], raw, "52-bit unpack diverges");
    let n_hi_v = s4.v >> 44;
    let n_lo4_v = s4.v & ((1u128 << 44) - 1);
    let n_hi = Limb { w: b.range(n_hi_v, 4), v: n_hi_v };
    let n_lo4 = Limb { w: b.range(n_lo4_v, 44), v: n_lo4_v };
    b.zero(vec![
        (s4.w, Scalar::ONE),
        (n_lo4.w, Scalar::ZERO - Scalar::ONE),
        (n_hi.w, Scalar::ZERO - sc_u128(1u128 << 44)),
    ]);
    let m0 = mul_const(&mut b, n_hi, L52[0]);
    let (p0, c0) = split52(&mut b, m0);
    let m1 = mul_const(&mut b, n_hi, L52[1]);
    let sum1 = limb_sum(&mut b, &[m1, c0]);
    let (p1, c1) = split52(&mut b, sum1);
    let m2 = mul_const(&mut b, n_hi, L52[2]);
    let sum2 = limb_sum(&mut b, &[m2, c1]);
    let (p2, c2) = split52(&mut b, sum2);
    let p3 = c2;
    let p4 = Limb { w: b.range(0, 1), v: 0 };
    let nlo = [s0, s1, s2, s3, n_lo4];
    let prod = [p0, p1, p2, p3, p4];
    let mut c_in = Limb { w: b.range(1, 2), v: 1 };
    let mut t = [Limb { w: Wire::One, v: 0 }; 5];
    for i in 0..5 {
        let (out, c_out) = t_limb(&mut b, nlo[i], L52[i], prod[i], c_in);
        t[i] = out;
        c_in = c_out;
    }
    assert_eq!(c_in.v, 1, "circuit order sum spilled past 260 bits");
    b.const_eq(c_in.w, Scalar::ONE);
    let mut bin = Limb { w: b.bit(false), v: 0 };
    let mut diff = [Limb { w: Wire::One, v: 0 }; 5];
    for i in 0..5 {
        let (d, bout) = sub_l_limb(&mut b, t[i], L52[i], bin);
        diff[i] = d;
        bin = bout;
    }
    let mut got = [Limb { w: Wire::One, v: 0 }; 5];
    for i in 0..5 {
        got[i] = select_limb(&mut b, bin, t[i], diff[i]);
    }
    let vals = [got[0].v, got[1].v, got[2].v, got[3].v, got[4].v];
    assert_eq!(vals, order_limbs(bytes), "order circuit diverges from order_limbs");
    (b, got, bts)
}

/// Witness that `expect` is `bytes` reduced mod the ristretto order.
/// Builds constraints only. It does not run the inner product proof.
pub(crate) fn order_reduce_synth(
    bytes: &[u8; 32],
    expect: &[u128; 5],
) -> (Vec<Scalar>, Vec<Scalar>, Vec<Scalar>, Vec<Vec<(Wire, Scalar)>>) {
    let (mut b, limbs, _bts) = order_reduce_into(Builder::new(), bytes);
    for i in 0..5 {
        b.const_eq(limbs[i].w, sc_u128(expect[i]));
    }
    (b.l, b.r, b.o, b.cons)
}

fn sc_pow2(shift: u32) -> Scalar {
    let mut raw = [0u8; 32];
    raw[(shift / 8) as usize] = 1u8 << (shift % 8);
    Option::<Scalar>::from(Scalar::from_repr(raw.into())).expect("power of two")
}

fn bind_packed_to_v(b: &mut Builder, limbs: &[Limb; 5]) {
    // s0 + s1·2^52 + s2·2^104 + s3·2^156 + s4·2^208 = V[0].
    // A canonical ristretto scalar is below 2^253, which is below the Vesta order.
    // Powers past 2^127 are built as field elements, not as a u128 shift.
    let mut terms = vec![(Wire::V(0), Scalar::ZERO - Scalar::ONE)];
    let mut shift = 0u32;
    for limb in limbs {
        terms.push((limb.w, sc_pow2(shift)));
        shift += 52;
    }
    b.zero(terms);
}

/// Hidden order reduction. `V[0]` commits to the reduced scalar.
/// The constraint coefficients are the same for every `bytes`.
pub(crate) fn order_reduce_committed(
    bytes: &[u8; 32],
) -> (Vec<Scalar>, Vec<Scalar>, Vec<Scalar>, Vec<Vec<(Wire, Scalar)>>, [u8; 32]) {
    let (mut b, limbs, _bts) = order_reduce_into(Builder::new(), bytes);
    bind_packed_to_v(&mut b, &limbs);
    (b.l, b.r, b.o, b.cons, pack52(&order_limbs(bytes)))
}

#[derive(Clone, Copy)]
struct Bit {
    w: Wire,
    v: bool,
}

#[derive(Clone, Copy)]
struct Word {
    w: Wire,
    v: u64,
}

fn bit_xor(b: &mut Builder, a: Bit, c: Bit) -> Bit {
    let v = a.v ^ c.v;
    let w = b.bit(v);
    let gi = b.mul(if a.v { Scalar::ONE } else { Scalar::ZERO }, if c.v { Scalar::ONE } else { Scalar::ZERO });
    b.zero(vec![(Wire::L(gi), Scalar::ONE), (a.w, Scalar::ZERO - Scalar::ONE)]);
    b.zero(vec![(Wire::R(gi), Scalar::ONE), (c.w, Scalar::ZERO - Scalar::ONE)]);
    b.zero(vec![
        (w, Scalar::ONE),
        (a.w, Scalar::ZERO - Scalar::ONE),
        (c.w, Scalar::ZERO - Scalar::ONE),
        (Wire::O(gi), Scalar::from(2u64)),
    ]);
    Bit { w, v }
}

fn bit_and(b: &mut Builder, a: Bit, c: Bit) -> Bit {
    let v = a.v && c.v;
    let gi = b.mul(if a.v { Scalar::ONE } else { Scalar::ZERO }, if c.v { Scalar::ONE } else { Scalar::ZERO });
    b.zero(vec![(Wire::L(gi), Scalar::ONE), (a.w, Scalar::ZERO - Scalar::ONE)]);
    b.zero(vec![(Wire::R(gi), Scalar::ONE), (c.w, Scalar::ZERO - Scalar::ONE)]);
    Bit { w: Wire::O(gi), v }
}

fn bit_not(b: &mut Builder, a: Bit) -> Bit {
    let v = !a.v;
    let gi = b.mul(if v { Scalar::ONE } else { Scalar::ZERO }, Scalar::ONE);
    b.zero(vec![(Wire::R(gi), Scalar::ONE), (Wire::One, Scalar::ZERO - Scalar::ONE)]);
    b.zero(vec![
        (Wire::L(gi), Scalar::ONE),
        (a.w, Scalar::ONE),
        (Wire::One, Scalar::ZERO - Scalar::ONE),
    ]);
    Bit { w: Wire::L(gi), v }
}

fn unpack64(b: &mut Builder, word: Word) -> [Bit; 64] {
    let mut bits = [Bit { w: Wire::One, v: false }; 64];
    let mut terms = vec![(word.w, Scalar::ZERO - Scalar::ONE)];
    let mut pow = Scalar::ONE;
    let two = Scalar::from(2u64);
    for i in 0..64 {
        let bit = ((word.v >> i) & 1) == 1;
        let w = b.bit(bit);
        bits[i] = Bit { w, v: bit };
        terms.push((w, pow));
        pow *= two;
    }
    b.zero(terms);
    bits
}

fn pack_bits(b: &mut Builder, bits: &[Bit; 64]) -> Word {
    let mut v = 0u64;
    for i in 0..64 {
        if bits[i].v {
            v |= 1u64 << i;
        }
    }
    let gi = b.mul(sc_u128(v as u128), Scalar::ONE);
    b.zero(vec![(Wire::R(gi), Scalar::ONE), (Wire::One, Scalar::ZERO - Scalar::ONE)]);
    let mut terms = vec![(Wire::L(gi), Scalar::ZERO - Scalar::ONE)];
    let mut pow = Scalar::ONE;
    let two = Scalar::from(2u64);
    for i in 0..64 {
        terms.push((bits[i].w, pow));
        pow *= two;
    }
    b.zero(terms);
    Word { w: Wire::L(gi), v }
}

fn rotr(bits: &[Bit; 64], n: usize) -> [Bit; 64] {
    let mut o = [bits[0]; 64];
    for i in 0..64 {
        o[i] = bits[(i + n) % 64];
    }
    o
}

fn shr(bits: &[Bit; 64], n: usize, zero: Bit) -> [Bit; 64] {
    let mut o = [zero; 64];
    for i in 0..(64 - n) {
        o[i] = bits[i + n];
    }
    o
}

fn xor_bits(b: &mut Builder, x: &[Bit; 64], y: &[Bit; 64]) -> [Bit; 64] {
    let mut o = [x[0]; 64];
    for i in 0..64 {
        o[i] = bit_xor(b, x[i], y[i]);
    }
    o
}

fn xor3(b: &mut Builder, x: [Bit; 64], y: [Bit; 64], z: [Bit; 64]) -> Word {
    let xy = xor_bits(b, &x, &y);
    let xyz = xor_bits(b, &xy, &z);
    pack_bits(b, &xyz)
}

fn add_wrap(b: &mut Builder, words: &[Word], extra: u64) -> Word {
    let mut sum = extra as u128;
    for w in words {
        sum += w.v as u128;
    }
    assert!(sum < (1u128 << 67), "sha add exceeded 3 carry bits");
    let low = sum as u64;
    let hi = sum >> 64;
    let low_w = b.range(low as u128, 64);
    let hi_w = b.range(hi, 3);
    let mut terms = vec![
        (low_w, Scalar::ZERO - Scalar::ONE),
        (hi_w, Scalar::ZERO - sc_u128(1u128 << 64)),
    ];
    for w in words {
        terms.push((w.w, Scalar::ONE));
    }
    if extra != 0 {
        terms.push((Wire::One, sc_u128(extra as u128)));
    }
    b.zero(terms);
    Word { w: low_w, v: low }
}

fn sigma0(b: &mut Builder, x: Word, zero: Bit) -> Word {
    let bits = unpack64(b, x);
    xor3(b, rotr(&bits, 1), rotr(&bits, 8), shr(&bits, 7, zero))
}

fn sigma1(b: &mut Builder, x: Word, zero: Bit) -> Word {
    let bits = unpack64(b, x);
    xor3(b, rotr(&bits, 19), rotr(&bits, 61), shr(&bits, 6, zero))
}

fn big_sigma0(b: &mut Builder, x: Word) -> Word {
    let bits = unpack64(b, x);
    xor3(b, rotr(&bits, 28), rotr(&bits, 34), rotr(&bits, 39))
}

fn big_sigma1(b: &mut Builder, x: Word) -> Word {
    let bits = unpack64(b, x);
    xor3(b, rotr(&bits, 14), rotr(&bits, 18), rotr(&bits, 41))
}

fn ch(b: &mut Builder, e: Word, f: Word, g: Word) -> Word {
    let eb = unpack64(b, e);
    let fb = unpack64(b, f);
    let gb = unpack64(b, g);
    let mut o = [eb[0]; 64];
    for i in 0..64 {
        let ef = bit_and(b, eb[i], fb[i]);
        let not_e = bit_not(b, eb[i]);
        let neg = bit_and(b, not_e, gb[i]);
        o[i] = bit_xor(b, ef, neg);
    }
    pack_bits(b, &o)
}

fn maj(b: &mut Builder, a: Word, c: Word, d: Word) -> Word {
    let ab = unpack64(b, a);
    let cb = unpack64(b, c);
    let db = unpack64(b, d);
    let mut o = [ab[0]; 64];
    for i in 0..64 {
        let x = bit_and(b, ab[i], cb[i]);
        let y = bit_and(b, ab[i], db[i]);
        let z = bit_and(b, cb[i], db[i]);
        let xy = bit_xor(b, x, y);
        o[i] = bit_xor(b, xy, z);
    }
    pack_bits(b, &o)
}

const SHA512_IV: [u64; 8] = [
    0x6a09e667f3bcc908,
    0xbb67ae8584caa73b,
    0x3c6ef372fe94f82b,
    0xa54ff53a5f1d36f1,
    0x510e527fade682d1,
    0x9b05688c2b3e6c1f,
    0x1f83d9abfb41bd6b,
    0x5be0cd19137e2179,
];

const SHA512_K: [u64; 80] = [
    0x428a2f98d728ae22, 0x7137449123ef65cd, 0xb5c0fbcfec4d3b2f, 0xe9b5dba58189dbbc,
    0x3956c25bf348b538, 0x59f111f1b605d019, 0x923f82a4af194f9b, 0xab1c5ed5da6d8118,
    0xd807aa98a3030242, 0x12835b0145706fbe, 0x243185be4ee4b28c, 0x550c7dc3d5ffb4e2,
    0x72be5d74f27b896f, 0x80deb1fe3b1696b1, 0x9bdc06a725c71235, 0xc19bf174cf692694,
    0xe49b69c19ef14ad2, 0xefbe4786384f25e3, 0x0fc19dc68b8cd5b5, 0x240ca1cc77ac9c65,
    0x2de92c6f592b0275, 0x4a7484aa6ea6e483, 0x5cb0a9dcbd41fbd4, 0x76f988da831153b5,
    0x983e5152ee66dfab, 0xa831c66d2db43210, 0xb00327c898fb213f, 0xbf597fc7beef0ee4,
    0xc6e00bf33da88fc2, 0xd5a79147930aa725, 0x06ca6351e003826f, 0x142929670a0e6e70,
    0x27b70a8546d22ffc, 0x2e1b21385c26c926, 0x4d2c6dfc5ac42aed, 0x53380d139d95b3df,
    0x650a73548baf63de, 0x766a0abb3c77b2a8, 0x81c2c92e47edaee6, 0x92722c851482353b,
    0xa2bfe8a14cf10364, 0xa81a664bbc423001, 0xc24b8b70d0f89791, 0xc76c51a30654be30,
    0xd192e819d6ef5218, 0xd69906245565a910, 0xf40e35855771202a, 0x106aa07032bbd1b8,
    0x19a4c116b8d2d0c8, 0x1e376c085141ab53, 0x2748774cdf8eeb99, 0x34b0bcb5e19b48a8,
    0x391c0cb3c5c95a63, 0x4ed8aa4ae3418acb, 0x5b9cca4f7763e373, 0x682e6ff3d6b2b8a3,
    0x748f82ee5defb2fc, 0x78a5636f43172f60, 0x84c87814a1f0ab72, 0x8cc702081a6439ec,
    0x90befffa23631e28, 0xa4506cebde82bde9, 0xbef9a3f7b2c67915, 0xc67178f2e372532b,
    0xca273eceea26619c, 0xd186b8c721c0c207, 0xeada7dd6cde0eb1e, 0xf57d4f7fee6ed178,
    0x06f067aa72176fba, 0x0a637dc5a2c898a6, 0x113f9804bef90dae, 0x1b710b35131c471b,
    0x28db77f523047d84, 0x32caab7b40c72493, 0x3c9ebe0a15c9bebc, 0x431d67c49c100d4c,
    0x4cc5d4becb3e42b6, 0x597f299cfc657e2a, 0x5fcb6fab3ad6faec, 0x6c44198c4a475817,
];

fn bind_be_word(b: &mut Builder, word: Word, expect: &[u8], at: usize) {
    let be = word.v.to_be_bytes();
    let mut terms = vec![(word.w, Scalar::ZERO - Scalar::ONE)];
    for j in 0..8 {
        let got = be[j] as u128;
        let bw = b.range(got, 8);
        b.const_eq(bw, Scalar::from(expect[at + j] as u64));
        terms.push((bw, sc_u128(1u128 << (56 - 8 * j))));
    }
    b.zero(terms);
}

/// One compression of 16 already-packed big-endian words.
/// The IV wires are pinned to the SHA-512 constants. A free IV would let a
/// prover open a different function to the same digest wires.
fn sha512_compress(b: &mut Builder, words16: [Word; 16]) -> [Word; 8] {
    let mut words = [Word { w: Wire::One, v: 0 }; 80];
    words[..16].copy_from_slice(&words16);
    let zero = Bit { w: b.bit(false), v: false };
    for t in 16..80 {
        let s1 = sigma1(b, words[t - 2], zero);
        let s0 = sigma0(b, words[t - 15], zero);
        words[t] = add_wrap(b, &[s1, words[t - 7], s0, words[t - 16]], 0);
    }
    let mut st = [Word { w: Wire::One, v: 0 }; 8];
    for i in 0..8 {
        st[i] = Word { w: b.range(SHA512_IV[i] as u128, 64), v: SHA512_IV[i] };
        b.const_eq(st[i].w, sc_u128(SHA512_IV[i] as u128));
    }
    let iv = st;
    for t in 0..80 {
        let s1 = big_sigma1(b, st[4]);
        let chv = ch(b, st[4], st[5], st[6]);
        let t1 = add_wrap(b, &[st[7], s1, chv, words[t]], SHA512_K[t]);
        let s0 = big_sigma0(b, st[0]);
        let majv = maj(b, st[0], st[1], st[2]);
        let t2 = add_wrap(b, &[s0, majv], 0);
        let new_e = add_wrap(b, &[st[3], t1], 0);
        let new_a = add_wrap(b, &[t1, t2], 0);
        st[7] = st[6];
        st[6] = st[5];
        st[5] = st[4];
        st[4] = new_e;
        st[3] = st[2];
        st[2] = st[1];
        st[1] = st[0];
        st[0] = new_a;
    }
    for i in 0..8 {
        st[i] = add_wrap(b, &[st[i], iv[i]], 0);
    }
    st
}

/// One SHA-512 block of `msg` (`msg.len() <= 111`), pinned to `expect`.
/// The trace must match `sha2`. A wrong `expect` fails the witness.
/// Builds constraints only. It does not run the inner product proof.
pub(crate) fn sha512_one_block_synth(
    msg: &[u8],
    expect: &[u8; 64],
) -> (Vec<Scalar>, Vec<Scalar>, Vec<Scalar>, Vec<Vec<(Wire, Scalar)>>) {
    assert!(msg.len() <= 111, "sha512 gadget is one block");
    let mut block = [0u8; 128];
    block[..msg.len()].copy_from_slice(msg);
    block[msg.len()] = 0x80;
    let bits = (msg.len() as u128) * 8;
    block[112..128].copy_from_slice(&bits.to_be_bytes());
    let mut b = Builder::new();
    let mut words = [Word { w: Wire::One, v: 0 }; 16];
    for t in 0..16 {
        let mut acc = 0u64;
        let mut terms_b = [Bw { w: Wire::One, v: 0 }; 8];
        for j in 0..8 {
            let v = block[t * 8 + j] as u128;
            let w = b.range(v, 8);
            terms_b[j] = Bw { w, v };
            acc |= (v as u64) << (56 - 8 * j);
        }
        let gi = b.mul(sc_u128(acc as u128), Scalar::ONE);
        b.zero(vec![(Wire::R(gi), Scalar::ONE), (Wire::One, Scalar::ZERO - Scalar::ONE)]);
        let mut terms = vec![(Wire::L(gi), Scalar::ZERO - Scalar::ONE)];
        for j in 0..8 {
            terms.push((terms_b[j].w, sc_u128(1u128 << (56 - 8 * j))));
        }
        b.zero(terms);
        words[t] = Word { w: Wire::L(gi), v: acc };
    }
    let st = sha512_compress(&mut b, words);
    let mut got = [0u8; 64];
    for i in 0..8 {
        got[i * 8..i * 8 + 8].copy_from_slice(&st[i].v.to_be_bytes());
    }
    let real = Sha512::digest(msg);
    assert_eq!(got.as_slice(), real.as_slice(), "sha512 trace diverges from sha2");
    for i in 0..8 {
        bind_be_word(&mut b, st[i], expect, i * 8);
    }
    (b.l, b.r, b.o, b.cons)
}

/// `zy·G + zr·H = A + e·Y`. One response opens one committed scalar.
/// `leaf_verify_v3` does not call this: the encode circuit is not in the transcript,
/// so the equation alone does not reject a point outside the set.
pub(crate) fn challenge_open_holds(
    g: &RistrettoPoint,
    h: &RistrettoPoint,
    e: &RScalar,
    zy: &RScalar,
    zr: &RScalar,
    a_com: &RistrettoPoint,
    y_com: &RistrettoPoint,
) -> bool {
    if *e == RScalar::ZERO {
        return false;
    }
    (g * zy + h * zr) == (a_com + y_com * e)
}

#[derive(Clone, Copy)]
struct FeEd {
    x: FeW,
    y: FeW,
    z: FeW,
    t: FeW,
}

fn canon_ed(ed: Ed) -> Ed {
    Ed {
        x: ed.x.carry_full(),
        y: ed.y.carry_full(),
        z: ed.z.carry_full(),
        t: ed.t.carry_full(),
    }
}

fn ed_from_ristretto(p: &RistrettoPoint) -> Ed {
    let enc = p.compress().to_bytes();
    canon_ed(ristretto_decompress(&enc).expect("ristretto point decompresses"))
}

/// 8-bit windows of `H`. Digit 0 of every window is the identity.
/// Points are the ristretto representative, so an Edwards sum compresses
/// to the same encoding as the ristretto sum.
fn h_windows() -> &'static [Vec<Ed>; 32] {
    static TABLE: OnceLock<[Vec<Ed>; 32]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut step = ristretto_h_note();
        let mut out: [Vec<Ed>; 32] = std::array::from_fn(|_| Vec::with_capacity(256));
        for window in &mut out {
            let mut acc = RistrettoPoint::identity();
            for _digit in 0..256 {
                window.push(ed_from_ristretto(&acc));
                acc += step;
            }
            for _ in 0..8 {
                step += step;
            }
        }
        out
    })
}

/// 8-bit windows of the note generator `U`. Digit 0 of every window is the identity.
fn u_windows() -> &'static [Vec<Ed>; 32] {
    static TABLE: OnceLock<[Vec<Ed>; 32]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut step = note_u();
        let mut out: [Vec<Ed>; 32] = std::array::from_fn(|_| Vec::with_capacity(256));
        for window in &mut out {
            let mut acc = RistrettoPoint::identity();
            for _digit in 0..256 {
                window.push(ed_from_ristretto(&acc));
                acc += step;
            }
            for _ in 0..8 {
                step += step;
            }
        }
        out
    })
}

/// `(limb, first bit, count)` for one encoding byte. A zero count is unused.
/// This is `Fe::to_bytes`. Byte 31 is 7 bits, so its high bit stays clear.
fn byte_parts(byte: usize) -> [(u8, u8, u8); 2] {
    match byte {
        0..=5 => [(0, (byte * 8) as u8, 8), (0, 0, 0)],
        6 => [(0, 48, 3), (1, 0, 5)],
        7..=11 => {
            let lo = (5 + (byte - 7) * 8) as u8;
            [(1, lo, 8), (0, 0, 0)]
        }
        12 => [(1, 45, 6), (2, 0, 2)],
        13..=18 => {
            let lo = (2 + (byte - 13) * 8) as u8;
            [(2, lo, 8), (0, 0, 0)]
        }
        19 => [(2, 50, 1), (3, 0, 7)],
        20..=24 => {
            let lo = (7 + (byte - 20) * 8) as u8;
            [(3, lo, 8), (0, 0, 0)]
        }
        25 => [(3, 47, 4), (4, 0, 4)],
        26..=30 => {
            let lo = (4 + (byte - 26) * 8) as u8;
            [(4, lo, 8), (0, 0, 0)]
        }
        31 => [(4, 44, 7), (0, 0, 0)],
        _ => [(0, 0, 0), (0, 0, 0)],
    }
}

fn encoding_bytes_from_limbs(limbs: &[u128; 5]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for byte in 0..32 {
        let mut acc = 0u8;
        let mut shift = 0u8;
        for (limb, lo, n) in byte_parts(byte) {
            if n == 0 {
                continue;
            }
            let bits = ((limbs[limb as usize] >> lo) & ((1u128 << n) - 1)) as u8;
            acc |= bits << shift;
            shift += n;
        }
        out[byte] = acc;
    }
    out
}

fn limb_bits(b: &mut Builder, w: Wire, v: u128) -> [Wire; 51] {
    assert!(v < TWO51_U, "limb is wider than 51 bits");
    let mut bits = [Wire::One; 51];
    let mut terms = vec![(w, Scalar::ONE)];
    let mut rest = v;
    let mut pow = Scalar::ONE;
    let two = Scalar::from(2u64);
    for i in 0..51 {
        let on = (rest & 1) == 1;
        rest >>= 1;
        bits[i] = b.bit(on);
        terms.push((bits[i], Scalar::ZERO - pow));
        pow *= two;
    }
    assert_eq!(rest, 0, "limb bits leftover");
    b.zero(terms);
    bits
}

fn sum_bits(b: &mut Builder, parts: &[(Wire, bool)]) -> Wire {
    let n = parts.len();
    assert!(n > 0 && n <= 8, "byte width");
    let mut v = 0u128;
    for (i, (_, on)) in parts.iter().enumerate() {
        if *on {
            v |= 1u128 << i;
        }
    }
    let w = b.range(v, n);
    let mut terms = vec![(w, Scalar::ONE)];
    let mut pow = Scalar::ONE;
    let two = Scalar::from(2u64);
    for (bw, _) in parts {
        terms.push((*bw, Scalar::ZERO - pow));
        pow *= two;
    }
    b.zero(terms);
    w
}

fn pack_encoding(b: &mut Builder, s: &FeW) -> [Wire; 32] {
    let mut bit_w = [[Wire::One; 51]; 5];
    for i in 0..5 {
        bit_w[i] = limb_bits(b, s.w[i], s.v[i]);
    }
    let mut out = [Wire::One; 32];
    for byte in 0..32 {
        let mut parts = Vec::with_capacity(8);
        for (limb, lo, n) in byte_parts(byte) {
            if n == 0 {
                continue;
            }
            let limb = limb as usize;
            let lo = lo as usize;
            for k in 0..n as usize {
                let on = ((s.v[limb] >> (lo + k)) & 1) == 1;
                parts.push((bit_w[limb][lo + k], on));
            }
        }
        out[byte] = sum_bits(b, &parts);
    }
    out
}

fn one_hot_8(b: &mut Builder, digit: u8) -> [Wire; 256] {
    let mut ws = [Wire::One; 256];
    let mut terms = Vec::with_capacity(257);
    terms.push((Wire::One, Scalar::ZERO - Scalar::ONE));
    for k in 0..256 {
        ws[k] = b.bit(k == digit as usize);
        terms.push((ws[k], Scalar::ONE));
    }
    b.zero(terms);
    ws
}

/// `w = sum_k s_k * pubs[k]`. Zero public coefficients are omitted.
/// The table is public, so both witnesses omit the same terms.
fn select_pub_limb(b: &mut Builder, sel: &[Wire; 256], pubs: &[u64; 256], digit: u8) -> (Wire, u128) {
    let v = pubs[digit as usize] as u128;
    let w = b.range(v, 51);
    let mut terms = Vec::with_capacity(257);
    terms.push((w, Scalar::ONE));
    for k in 0..256 {
        if pubs[k] != 0 {
            terms.push((sel[k], Scalar::ZERO - Scalar::from(pubs[k])));
        }
    }
    b.zero(terms);
    (w, v)
}

fn coord_limbs(ed: &Ed, coord: usize) -> [u64; 5] {
    let fe = match coord {
        0 => ed.x,
        1 => ed.y,
        2 => ed.z,
        _ => ed.t,
    };
    fe.carry_full().0
}

fn select_window(b: &mut Builder, sel: &[Wire; 256], pts: &[Ed], digit: u8) -> FeEd {
    let mut coords = [FeW { w: [Wire::One; 5], v: [0; 5] }; 4];
    for ci in 0..4 {
        let mut pubs = [[0u64; 256]; 5];
        for k in 0..256 {
            let limbs = coord_limbs(&pts[k], ci);
            for limb in 0..5 {
                pubs[limb][k] = limbs[limb];
            }
        }
        let mut w = [Wire::One; 5];
        let mut v = [0u128; 5];
        for limb in 0..5 {
            let (ww, vv) = select_pub_limb(b, sel, &pubs[limb], digit);
            w[limb] = ww;
            v[limb] = vv;
        }
        coords[ci] = FeW { w, v };
    }
    FeEd { x: coords[0], y: coords[1], z: coords[2], t: coords[3] }
}

fn fe_ed_priv(b: &mut Builder, ed: Ed) -> FeEd {
    let ed = canon_ed(ed);
    FeEd {
        x: fe_priv(b, ed.x),
        y: fe_priv(b, ed.y),
        z: fe_priv(b, ed.z),
        t: fe_priv(b, ed.t),
    }
}

fn ed_add(b: &mut Builder, d: FeW, p: FeEd, q: FeEd) -> FeEd {
    let a = fe_mul(b, p.x, q.x);
    let bb = fe_mul(b, p.y, q.y);
    let td = fe_mul(b, p.t, d);
    let c = fe_mul(b, td, q.t);
    let zz = fe_mul(b, p.z, q.z);
    let pxy = fe_add(b, p.x, p.y);
    let qxy = fe_add(b, q.x, q.y);
    let xy = fe_mul(b, pxy, qxy);
    let xy_a = fe_sub(b, xy, a);
    let e = fe_sub(b, xy_a, bb);
    let f = fe_sub(b, zz, c);
    let g = fe_add(b, zz, c);
    let h = fe_add(b, bb, a);
    FeEd {
        x: fe_mul(b, e, f),
        y: fe_mul(b, g, h),
        t: fe_mul(b, e, h),
        z: fe_mul(b, f, g),
    }
}

fn enforce_twisted(b: &mut Builder, d: FeW, p: &FeEd) {
    let xx = fe_mul(b, p.x, p.x);
    let yy = fe_mul(b, p.y, p.y);
    let xxyy = fe_mul(b, xx, yy);
    let dxxyy = fe_mul(b, d, xxyy);
    let y_sub_x = fe_sub(b, yy, xx);
    let one = fe_const(b, Fe::ONE);
    let rhs = fe_add(b, one, dxxyy);
    let diff = fe_sub(b, y_sub_x, rhs);
    for i in 0..5 {
        b.const_eq(diff.w[i], Scalar::ZERO);
    }
    let xy = fe_mul(b, p.x, p.y);
    let tz = fe_mul(b, p.t, p.z);
    let diff2 = fe_sub(b, xy, tz);
    for i in 0..5 {
        b.const_eq(diff2.w[i], Scalar::ZERO);
    }
}

fn fe_w_matches(w: FeW, f: Fe) -> bool {
    let f = f.carry_full();
    (0..5).all(|i| w.v[i] == f.0[i] as u128)
}

/// Proves `kc = ci + rho·H` and `V[0] = from_bytes(compress(ci))`.
/// Constraint coefficients do not depend on `ci` or `rho`. A verifier rebuilds
/// the same list from the identity and `rho = 1`, with the same public `kc`.
pub(crate) fn c_bind_build(
    real: Option<(Ed, RScalar)>,
    kc: &[u8; 32],
) -> (Vec<Scalar>, Vec<Scalar>, Vec<Scalar>, Vec<Vec<(Wire, Scalar)>>) {
    let (ci, rho) = match real {
        Some((ed, rho)) => (canon_ed(ed), rho),
        None => {
            let id = ristretto_decompress(&[0u8; 32]).expect("identity encoding");
            (canon_ed(id), RScalar::from(1u64))
        }
    };
    let enc = ci.ristretto_compress();
    let mut b = Builder::new();
    let d = fe_const(&mut b, edwards_d());
    let start = fe_ed_priv(&mut b, ci);
    enforce_twisted(&mut b, d, &start);
    let s = compress_fe(&mut b, start.x, start.y, start.z, start.t);
    assert_eq!(
        encoding_bytes_from_limbs(&s.v),
        enc,
        "encode gadget bytes diverged from compress(ci)"
    );
    let packed = pack_encoding(&mut b, &s);
    let (mut b, limbs, bts) = order_reduce_into(b, &enc);
    for i in 0..32 {
        b.zero(vec![
            (bts[i].w, Scalar::ONE),
            (packed[i], Scalar::ZERO - Scalar::ONE),
        ]);
    }
    bind_packed_to_v(&mut b, &limbs);
    let windows = h_windows();
    let rho_bytes = rho.to_bytes();
    let mut acc = start;
    let mut clear = ci;
    for i in 0..32 {
        let digit = rho_bytes[i];
        let sel = one_hot_8(&mut b, digit);
        let q = select_window(&mut b, &sel, &windows[i], digit);
        acc = ed_add(&mut b, d, acc, q);
        clear = clear.add(windows[i][digit as usize]);
        assert!(fe_w_matches(acc.x, clear.x), "x diverged at window {i}");
        assert!(fe_w_matches(acc.y, clear.y), "y diverged at window {i}");
        assert!(fe_w_matches(acc.z, clear.z), "z diverged at window {i}");
        assert!(fe_w_matches(acc.t, clear.t), "t diverged at window {i}");
    }
    let sum = compress_fe(&mut b, acc.x, acc.y, acc.z, acc.t);
    let claim = Fe::from_bytes(kc).carry_full();
    for i in 0..5 {
        b.const_eq(sum.w[i], Scalar::from(claim.0[i]));
    }
    (b.l, b.r, b.o, b.cons)
}

const LIMB32: u128 = 1u128 << 32;
/// Ristretto L as 32-bit little-endian limbs.
const L32: [u128; 8] = [
    0x5cf5d3ed,
    0x5812631a,
    0xa2f79cd6,
    0x14def9de,
    0,
    0,
    0,
    0x10000000,
];

/// Vesta scalar modulus as 32-bit little-endian limbs.
/// p = 0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001
const P32: [u128; 8] = [
    0x0000_0001,
    0x992d_30ed,
    0x094c_f91b,
    0x2246_98fc,
    0,
    0,
    0,
    0x4000_0000,
];

#[derive(Clone, Copy)]
struct W32 {
    w: Wire,
    v: u128,
}

fn u32_limbs(bytes: &[u8]) -> Vec<u128> {
    let mut o = Vec::with_capacity(bytes.len() / 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let mut limb = [0u8; 4];
        limb.copy_from_slice(&bytes[i..i + 4]);
        o.push(u32::from_le_bytes(limb) as u128);
        i += 4;
    }
    o
}

fn w32(b: &mut Builder, v: u128, bits: usize) -> W32 {
    W32 { w: b.range(v, bits), v }
}

/// `limbs` is strictly below the ristretto order. The final borrow is 1.
fn enforce_lt_l(b: &mut Builder, limbs: &[W32; 8]) {
    let mut borrow_w: Option<Wire> = None;
    let mut borrow_v = 0u128;
    let mut last = None;
    for i in 0..8 {
        let tmp = limbs[i].v as i128 - L32[i] as i128 - borrow_v as i128;
        let (diff, bout) = if tmp < 0 {
            ((tmp + (1i128 << 32)) as u128, 1u128)
        } else {
            (tmp as u128, 0u128)
        };
        let diff_w = b.range(diff, 32);
        let bw = b.bit(bout == 1);
        let mut terms = vec![
            (limbs[i].w, Scalar::ONE),
            (bw, sc_u128(LIMB32)),
            (diff_w, Scalar::ZERO - Scalar::ONE),
            (Wire::One, Scalar::ZERO - sc_u128(L32[i])),
        ];
        if let Some(prev) = borrow_w {
            terms.push((prev, Scalar::ZERO - Scalar::ONE));
        }
        b.zero(terms);
        borrow_w = Some(bw);
        borrow_v = bout;
        last = Some(bw);
    }
    b.const_eq(last.expect("borrow"), Scalar::ONE);
    assert_eq!(borrow_v, 1, "scalar is not below L");
}

fn enforce_lt_p(b: &mut Builder, limbs: &[W32; 8]) {
    let mut borrow_w: Option<Wire> = None;
    let mut borrow_v = 0u128;
    let mut last = None;
    for i in 0..8 {
        let tmp = limbs[i].v as i128 - P32[i] as i128 - borrow_v as i128;
        let (diff, bout) = if tmp < 0 {
            ((tmp + (1i128 << 32)) as u128, 1u128)
        } else {
            (tmp as u128, 0u128)
        };
        let diff_w = b.range(diff, 32);
        let bw = b.bit(bout == 1);
        let mut terms = vec![
            (limbs[i].w, Scalar::ONE),
            (bw, sc_u128(LIMB32)),
            (diff_w, Scalar::ZERO - Scalar::ONE),
            (Wire::One, Scalar::ZERO - sc_u128(P32[i])),
        ];
        if let Some(prev) = borrow_w {
            terms.push((prev, Scalar::ZERO - Scalar::ONE));
        }
        b.zero(terms);
        borrow_w = Some(bw);
        borrow_v = bout;
        last = Some(bw);
    }
    b.const_eq(last.expect("borrow"), Scalar::ONE);
    assert_eq!(borrow_v, 1, "remainder is not below the field modulus");
}

/// `n mod p` for a 64-byte little-endian integer. `q` is 9 limbs, `r` is 8.
/// The remainder matches `vesta::Scalar::from_uniform_bytes`.
fn fp_quot_rem(digest: &[u8; 64]) -> ([u128; 9], [u128; 8]) {
    let mut n = [0u64; 16];
    for i in 0..16 {
        let mut raw = [0u8; 4];
        raw.copy_from_slice(&digest[i * 4..i * 4 + 4]);
        n[i] = u32::from_le_bytes(raw) as u64;
    }
    let p: [u64; 8] = [
        P32[0] as u64,
        P32[1] as u64,
        P32[2] as u64,
        P32[3] as u64,
        P32[4] as u64,
        P32[5] as u64,
        P32[6] as u64,
        P32[7] as u64,
    ];
    let mut rem = [0u64; 8];
    let mut q = [0u128; 9];
    for bit in (0..512).rev() {
        let mut carry = 0u64;
        for i in 0..8 {
            let v = (rem[i] << 1) | carry;
            rem[i] = v & 0xffff_ffff;
            carry = v >> 32;
        }
        assert_eq!(carry, 0, "remainder shift overflowed 256 bits");
        rem[0] |= (n[bit / 32] >> (bit % 32)) & 1;
        let mut ge = true;
        for i in (0..8).rev() {
            if rem[i] != p[i] {
                ge = rem[i] > p[i];
                break;
            }
        }
        if !ge {
            continue;
        }
        let mut borrow = 0i128;
        for i in 0..8 {
            let diff = rem[i] as i128 - p[i] as i128 - borrow;
            if diff < 0 {
                rem[i] = (diff + (1i128 << 32)) as u64;
                borrow = 1;
            } else {
                rem[i] = diff as u64;
                borrow = 0;
            }
        }
        assert_eq!(borrow, 0, "field subtraction borrowed out");
        assert!(bit < 288, "fp quotient does not fit in 9 limbs at bit {bit}");
        q[bit / 32] |= 1u128 << (bit % 32);
    }
    let r = [
        rem[0] as u128,
        rem[1] as u128,
        rem[2] as u128,
        rem[3] as u128,
        rem[4] as u128,
        rem[5] as u128,
        rem[6] as u128,
        rem[7] as u128,
    ];
    let mut acc = [0u128; 18];
    for j in 0..9 {
        let mut carry = 0u128;
        for k in 0..8 {
            let idx = j + k;
            let sum = acc[idx] + q[j] * P32[k] + carry;
            acc[idx] = sum & 0xffff_ffff;
            carry = sum >> 32;
        }
        acc[j + 8] += carry;
    }
    let mut carry = 0u128;
    for i in 0..17 {
        let add = if i < 8 { r[i] } else { 0 };
        let sum = acc[i] + add + carry;
        acc[i] = sum & 0xffff_ffff;
        carry = sum >> 32;
    }
    assert_eq!(carry, 0, "q*p + r overflowed");
    for i in 0..16 {
        assert_eq!(acc[i] as u64, n[i], "q*p + r diverged at limb {i}");
    }
    assert_eq!(acc[16], 0, "q*p + r spilled past 512 bits");
    let x = vesta::Scalar::from_uniform_bytes(digest);
    let mut got = [0u8; 32];
    for i in 0..8 {
        got[i * 4..i * 4 + 4].copy_from_slice(&(r[i] as u32).to_le_bytes());
    }
    assert_eq!(got.as_slice(), x.to_repr().as_ref(), "remainder is not from_uniform_bytes");
    (q, r)
}

fn const_byte(b: &mut Builder, v: u8) -> Wire {
    let sv = Scalar::from(v as u64);
    let gi = b.mul(sv, Scalar::ONE);
    b.zero(vec![
        (Wire::R(gi), Scalar::ONE),
        (Wire::One, Scalar::ZERO - Scalar::ONE),
    ]);
    b.const_eq(Wire::L(gi), sv);
    Wire::L(gi)
}

fn pack_be_word(b: &mut Builder, bytes: &[(Wire, u128); 8]) -> Word {
    let mut acc = 0u64;
    for j in 0..8 {
        acc |= (bytes[j].1 as u64) << (56 - 8 * j);
    }
    let gi = b.mul(sc_u128(acc as u128), Scalar::ONE);
    b.zero(vec![(Wire::R(gi), Scalar::ONE), (Wire::One, Scalar::ZERO - Scalar::ONE)]);
    let mut terms = vec![(Wire::L(gi), Scalar::ZERO - Scalar::ONE)];
    for j in 0..8 {
        terms.push((bytes[j].0, sc_u128(1u128 << (56 - 8 * j))));
    }
    b.zero(terms);
    Word { w: Wire::L(gi), v: acc }
}

fn split_be_word(b: &mut Builder, word: Word) -> [(Wire, u128); 8] {
    let be = word.v.to_be_bytes();
    let mut out = [(Wire::One, 0u128); 8];
    let mut terms = vec![(word.w, Scalar::ZERO - Scalar::ONE)];
    for j in 0..8 {
        let got = be[j] as u128;
        let bw = b.range(got, 8);
        out[j] = (bw, got);
        terms.push((bw, sc_u128(1u128 << (56 - 8 * j))));
    }
    b.zero(terms);
    out
}

/// `V[0]` is `digest` reduced modulo the Vesta scalar field.
/// Digest bytes stay witness wires. The modulus limbs are the only public coefficients.
fn bind_fp_digest(b: &mut Builder, dig_w: &[Wire; 64], dig: &[u8; 64]) {
    let (q, r) = fp_quot_rem(dig);
    let mut qw = [W32 { w: Wire::One, v: 0 }; 9];
    for i in 0..9 {
        qw[i] = w32(b, q[i], 32);
    }
    let mut rw = [W32 { w: Wire::One, v: 0 }; 8];
    for i in 0..8 {
        rw[i] = w32(b, r[i], 32);
    }
    enforce_lt_p(b, &rw);
    let mut nw = [W32 { w: Wire::One, v: 0 }; 16];
    for i in 0..16 {
        let mut v = 0u128;
        let mut bytes = [(Wire::One, 0u128); 4];
        for j in 0..4 {
            let bv = dig[i * 4 + j] as u128;
            v |= bv << (8 * j);
            bytes[j] = (dig_w[i * 4 + j], bv);
        }
        let w = b.range(v, 32);
        let mut terms = vec![(w, Scalar::ONE)];
        let mut pow = Scalar::ONE;
        let p256 = Scalar::from(256u64);
        for j in 0..4 {
            terms.push((bytes[j].0, Scalar::ZERO - pow));
            pow *= p256;
        }
        b.zero(terms);
        nw[i] = W32 { w, v };
    }
    let mut carry_w: Option<Wire> = None;
    let mut carry_v = 0u128;
    for t in 0..16 {
        let mut terms = Vec::new();
        let mut sum = carry_v;
        if let Some(cw) = carry_w {
            terms.push((cw, Scalar::ONE));
        }
        if t < 8 {
            sum += rw[t].v;
            terms.push((rw[t].w, Scalar::ONE));
        }
        for j in 0..9 {
            if j > t {
                continue;
            }
            let k = t - j;
            if k >= 8 {
                continue;
            }
            let pk = P32[k];
            sum += pk * qw[j].v;
            if pk != 0 {
                terms.push((qw[j].w, sc_u128(pk)));
            }
        }
        let low = sum & (LIMB32 - 1);
        let cout = sum >> 32;
        assert!(cout < (1u128 << 40), "fp carry {cout} at column {t}");
        assert_eq!(low, nw[t].v, "fp limb {t} diverged from the digest");
        terms.push((nw[t].w, Scalar::ZERO - Scalar::ONE));
        if t + 1 == 16 {
            assert_eq!(cout, 0, "fp product spilled past 512 bits");
        } else {
            let cw = b.range(cout, 40);
            terms.push((cw, Scalar::ZERO - sc_u128(LIMB32)));
            carry_w = Some(cw);
            carry_v = cout;
        }
        b.zero(terms);
    }
    let mut y_terms = vec![(Wire::V(0), Scalar::ZERO - Scalar::ONE)];
    for i in 0..8 {
        y_terms.push((rw[i].w, sc_pow2((32 * i) as u32)));
    }
    b.zero(y_terms);
}

/// Proves `kp = pi + rho·U` and `V[0] = from_uniform_bytes(SHA512(DST_LEAF || compress(pi)))`.
/// The digest is a witness. Public coefficients are `kp` and the fixed SHA prefix.
/// A verifier rebuilds the same list from the identity and `rho = 1`, with the same `kp`.
pub(crate) fn p_bind_build(
    real: Option<(Ed, RScalar)>,
    kp: &[u8; 32],
) -> (Vec<Scalar>, Vec<Scalar>, Vec<Scalar>, Vec<Vec<(Wire, Scalar)>>) {
    let (pi, rho) = match real {
        Some((ed, rho)) => (canon_ed(ed), rho),
        None => {
            let id = ristretto_decompress(&[0u8; 32]).expect("identity encoding");
            (canon_ed(id), RScalar::from(1u64))
        }
    };
    let enc = pi.ristretto_compress();
    let mut b = Builder::new();
    let d = fe_const(&mut b, edwards_d());
    let start = fe_ed_priv(&mut b, pi);
    enforce_twisted(&mut b, d, &start);
    let s = compress_fe(&mut b, start.x, start.y, start.z, start.t);
    assert_eq!(
        encoding_bytes_from_limbs(&s.v),
        enc,
        "encode gadget bytes diverged from compress(pi)"
    );
    let packed = pack_encoding(&mut b, &s);
    let dst = crate::leaf::DST_LEAF;
    assert_eq!(dst.len(), 19, "dest leaf domain is one SHA block");
    let mut block_w = [Wire::One; 128];
    let mut block_v = [0u8; 128];
    for i in 0..19 {
        block_v[i] = dst[i];
        block_w[i] = const_byte(&mut b, dst[i]);
    }
    for i in 0..32 {
        block_v[19 + i] = enc[i];
        block_w[19 + i] = packed[i];
    }
    block_v[51] = 0x80;
    block_w[51] = const_byte(&mut b, 0x80);
    for i in 52..112 {
        block_w[i] = const_byte(&mut b, 0);
    }
    let bits: u128 = 51 * 8;
    let len_be = bits.to_be_bytes();
    for i in 0..16 {
        block_v[112 + i] = len_be[i];
        block_w[112 + i] = const_byte(&mut b, len_be[i]);
    }
    let mut words = [Word { w: Wire::One, v: 0 }; 16];
    for t in 0..16 {
        let mut bytes = [(Wire::One, 0u128); 8];
        for j in 0..8 {
            bytes[j] = (block_w[t * 8 + j], block_v[t * 8 + j] as u128);
        }
        words[t] = pack_be_word(&mut b, &bytes);
    }
    let st = sha512_compress(&mut b, words);
    let mut dig = [0u8; 64];
    let mut dig_w = [Wire::One; 64];
    for i in 0..8 {
        let parts = split_be_word(&mut b, st[i]);
        for j in 0..8 {
            dig[i * 8 + j] = parts[j].1 as u8;
            dig_w[i * 8 + j] = parts[j].0;
        }
    }
    let mut msg = Vec::with_capacity(51);
    msg.extend_from_slice(dst);
    msg.extend_from_slice(&enc);
    let real_dig = Sha512::digest(&msg);
    assert_eq!(dig.as_slice(), real_dig.as_slice(), "dest sha512 diverged from sha2");
    bind_fp_digest(&mut b, &dig_w, &dig);
    let windows = u_windows();
    let rho_bytes = rho.to_bytes();
    let mut acc = start;
    let mut clear = pi;
    for i in 0..32 {
        let digit = rho_bytes[i];
        let sel = one_hot_8(&mut b, digit);
        let q = select_window(&mut b, &sel, &windows[i], digit);
        acc = ed_add(&mut b, d, acc, q);
        clear = clear.add(windows[i][digit as usize]);
        assert!(fe_w_matches(acc.x, clear.x), "x diverged at window {i}");
        assert!(fe_w_matches(acc.y, clear.y), "y diverged at window {i}");
        assert!(fe_w_matches(acc.z, clear.z), "z diverged at window {i}");
        assert!(fe_w_matches(acc.t, clear.t), "t diverged at window {i}");
    }
    let sum = compress_fe(&mut b, acc.x, acc.y, acc.z, acc.t);
    let claim = Fe::from_bytes(kp).carry_full();
    for i in 0..5 {
        b.const_eq(sum.w[i], Scalar::from(claim.0[i]));
    }
    (b.l, b.r, b.o, b.cons)
}

fn product_32(b: &mut Builder, y: &[W32; 8], e: &[u128; 8]) -> [W32; 16] {
    let mut carry_w: Option<Wire> = None;
    let mut carry_v = 0u128;
    let mut out = Vec::with_capacity(16);
    for t in 0..16 {
        let mut terms = Vec::new();
        let mut sum = carry_v;
        if let Some(cw) = carry_w {
            terms.push((cw, Scalar::ONE));
        }
        for i in 0..8 {
            if t < i || t - i >= 8 {
                continue;
            }
            let ej = e[i];
            let yj = &y[t - i];
            sum += ej * yj.v;
            if ej != 0 {
                terms.push((yj.w, sc_u128(ej)));
            }
        }
        let low = sum & (LIMB32 - 1);
        let cout = sum >> 32;
        assert!(cout < (1u128 << 40), "product carry {cout}");
        let low_w = b.range(low, 32);
        terms.push((low_w, Scalar::ZERO - Scalar::ONE));
        if t + 1 == 16 {
            assert_eq!(cout, 0, "product does not fit in 512 bits");
        } else {
            let cw = b.range(cout, 40);
            terms.push((cw, Scalar::ZERO - sc_u128(LIMB32)));
            carry_w = Some(cw);
            carry_v = cout;
        }
        b.zero(terms);
        out.push(W32 { w: low_w, v: low });
    }
    out.try_into().ok().expect("16 product limbs")
}

fn place_scalar(b: &mut Builder, s: &RScalar) -> [W32; 8] {
    let raw = u32_limbs(&s.to_bytes());
    let mut o = [W32 { w: Wire::One, v: 0 }; 8];
    for i in 0..8 {
        o[i] = w32(b, raw[i], 32);
    }
    enforce_lt_l(b, &o);
    o
}

/// One committed `y` opens `S_j = k + e_j·y` for exactly one slot.
/// Public coefficients are the slot challenges `e_j` and the published integers `S_j`.
/// `k` is the nonce of `index`. Every other slot's nonce is zero, and its bit is zero.
/// The leaf binds this opening to the encode circuit by one published Y.
pub(crate) fn slot_link_synth(
    y: &RScalar,
    k: &RScalar,
    e_bytes: &[[u8; 32]; crate::tree::ARITY],
    s_bytes: &[[u8; 64]; crate::tree::ARITY],
    index: usize,
) -> (Vec<Scalar>, Vec<Scalar>, Vec<Scalar>, Vec<Vec<(Wire, Scalar)>>) {
    assert!(index < crate::tree::ARITY, "slot");
    let mut b = Builder::new();
    let y_l = place_scalar(&mut b, y);
    let mut y_terms = vec![(Wire::V(0), Scalar::ZERO - Scalar::ONE)];
    for i in 0..8 {
        y_terms.push((y_l[i].w, sc_pow2((32 * i) as u32)));
    }
    b.zero(y_terms);
    let mut bits = Vec::with_capacity(crate::tree::ARITY);
    for j in 0..crate::tree::ARITY {
        let bit = b.bit(j == index);
        let kj = if j == index { *k } else { RScalar::ZERO };
        let k_l = place_scalar(&mut b, &kj);
        let e = {
            let raw = u32_limbs(&e_bytes[j]);
            let mut o = [0u128; 8];
            o.copy_from_slice(&raw[..8]);
            o
        };
        let s = {
            let raw = u32_limbs(&s_bytes[j]);
            let mut o = [0u128; 16];
            o.copy_from_slice(&raw[..16]);
            o
        };
        let p = product_32(&mut b, &y_l, &e);
        let mut cin_w: Option<Wire> = None;
        let mut cin_v = 0u128;
        let mut last_cout: Option<W32> = None;
        for t in 0..16 {
            let k_v = if t < 8 { k_l[t].v } else { 0 };
            let mut sum = p[t].v + k_v + cin_v;
            let cout_v = sum >> 32;
            sum &= LIMB32 - 1;
            let _ = sum;
            let cout = w32(&mut b, cout_v, 8);
            let inner = {
                let mut acc = sc_u128(p[t].v);
                acc += sc_u128(k_v);
                acc += sc_u128(cin_v);
                acc -= sc_u128(s[t]);
                acc -= sc_u128(cout_v) * sc_u128(LIMB32);
                acc
            };
            let gi = b.mul(inner, Scalar::ONE);
            b.zero(vec![
                (Wire::R(gi), Scalar::ONE),
                (Wire::One, Scalar::ZERO - Scalar::ONE),
            ]);
            let mut terms = vec![
                (Wire::L(gi), Scalar::ONE),
                (p[t].w, Scalar::ZERO - Scalar::ONE),
                (cout.w, sc_u128(LIMB32)),
                (Wire::One, sc_u128(s[t])),
            ];
            if t < 8 {
                terms.push((k_l[t].w, Scalar::ZERO - Scalar::ONE));
            }
            if let Some(cw) = cin_w {
                terms.push((cw, Scalar::ZERO - Scalar::ONE));
            }
            b.zero(terms);
            let bv = if j == index { Scalar::ONE } else { Scalar::ZERO };
            let bi = b.mul(bv, inner);
            b.zero(vec![(Wire::L(bi), Scalar::ONE), (bit, Scalar::ZERO - Scalar::ONE)]);
            b.zero(vec![(Wire::R(bi), Scalar::ONE), (Wire::L(gi), Scalar::ZERO - Scalar::ONE)]);
            b.zero(vec![(Wire::O(bi), Scalar::ONE)]);
            cin_w = Some(cout.w);
            cin_v = cout_v;
            last_cout = Some(cout);
        }
        let tail = last_cout.expect("tail");
        let tb = b.mul(if j == index { Scalar::ONE } else { Scalar::ZERO }, sc_u128(tail.v));
        b.zero(vec![(Wire::L(tb), Scalar::ONE), (bit, Scalar::ZERO - Scalar::ONE)]);
        b.zero(vec![(Wire::R(tb), Scalar::ONE), (tail.w, Scalar::ZERO - Scalar::ONE)]);
        b.zero(vec![(Wire::O(tb), Scalar::ONE)]);
        bits.push(bit);
    }
    let mut one = vec![(Wire::One, Scalar::ZERO - Scalar::ONE)];
    for bit in bits {
        one.push((bit, Scalar::ONE));
    }
    b.zero(one);
    (b.l, b.r, b.o, b.cons)
}

fn embed_scalar(y: &RScalar) -> Option<Scalar> {
    Option::<Scalar>::from(Scalar::from_repr(y.to_bytes().into()))
}

fn point_bytes(p: &vesta::Point) -> [u8; 32] {
    let e = p.to_bytes();
    let mut o = [0u8; 32];
    o.copy_from_slice(e.as_ref());
    o
}

fn commit_opening(y: &RScalar, r: &vesta::Scalar) -> Option<[u8; 32]> {
    let yv = embed_scalar(y)?;
    let b = crate::ipa::hash_to_vesta(0, b"shear-admit-v3-r1cs-B");
    let blind = crate::ipa::hash_to_vesta(0, b"shear-admit-v3-r1cs-Bblind");
    Some(point_bytes(&(b * yv + blind * r)))
}

fn prove_one(
    l: &[Scalar],
    r: &[Scalar],
    o: &[Scalar],
    cons: &[Vec<(Wire, Scalar)>],
    y: &RScalar,
    blind: &vesta::Scalar,
    rounds: usize,
    pad: usize,
) -> Option<Vec<u8>> {
    if l.len().next_power_of_two() != pad {
        eprintln!("PHASE pad-mismatch gates {} want {}", l.len(), pad);
        return None;
    }
    let yv = embed_scalar(y)?;
    let proof = r1cs_prove(l, r, o, cons, &[(yv, *blind)])?;
    let want = commit_opening(y, blind)?;
    if proof.v.len() != 1 || proof.v[0] != want {
        return None;
    }
    r1cs_write(&proof, rounds)
}

/// Slot proof whose committed wire is `Y = Commit(y, r_y)`.
pub(crate) fn prove_slot_opening(
    y: &RScalar,
    r_y: &vesta::Scalar,
    y_bytes: &[u8; 32],
    ky: &RScalar,
    e_bytes: &[[u8; 32]; crate::tree::ARITY],
    s_bytes: &[[u8; 64]; crate::tree::ARITY],
    index: usize,
) -> Option<Vec<u8>> {
    #[cfg(test)]
    eprintln!("PHASE slot-prove-start");
    let (l, r, o, cons) = slot_link_synth(y, ky, e_bytes, s_bytes, index);
    let blob = prove_one(&l, &r, &o, &cons, y, r_y, SLOT_IPA_ROUNDS, 1 << SLOT_IPA_ROUNDS)?;
    let got = commit_opening(y, r_y)?;
    if got != *y_bytes {
        return None;
    }
    #[cfg(test)]
    eprintln!("PHASE slot-prove-done");
    Some(blob)
}

/// Encode proof whose committed wire is `Commit(y, r_y)` for `kc = ci + rho·H`.
pub(crate) fn prove_encode_opening(
    ci: &RistrettoPoint,
    rho: &RScalar,
    kc: &[u8; 32],
    y: &RScalar,
    r_y: &vesta::Scalar,
) -> Option<Vec<u8>> {
    #[cfg(test)]
    eprintln!("PHASE encode-prove-start");
    let ed = ed_from_ristretto(ci);
    let (l, r, o, cons) = c_bind_build(Some((ed, *rho)), kc);
    let blob = prove_one(&l, &r, &o, &cons, y, r_y, ENCODE_IPA_ROUNDS, 1 << ENCODE_IPA_ROUNDS)?;
    #[cfg(test)]
    eprintln!("PHASE encode-prove-done");
    Some(blob)
}

fn commit_native(x: &Scalar, r: &vesta::Scalar) -> [u8; 32] {
    let b = crate::ipa::hash_to_vesta(0, b"shear-admit-v3-r1cs-B");
    let blind = crate::ipa::hash_to_vesta(0, b"shear-admit-v3-r1cs-Bblind");
    point_bytes(&(b * x + blind * r))
}

/// Dest-bind proof whose committed wire is `Yx = Commit(x, r_x)`.
/// `x` is the native dest fingerprint, not a ristretto scalar.
pub(crate) fn prove_kp_opening(
    pi: &RistrettoPoint,
    rho: &RScalar,
    kp: &[u8; 32],
    x: &vesta::Scalar,
    r_x: &vesta::Scalar,
) -> Option<Vec<u8>> {
    #[cfg(test)]
    eprintln!("PHASE kp-prove-start");
    let ed = ed_from_ristretto(pi);
    let (l, r, o, cons) = p_bind_build(Some((ed, *rho)), kp);
    if l.len().next_power_of_two() != 1 << ENCODE_IPA_ROUNDS {
        eprintln!("PHASE pad-mismatch gates {} want {}", l.len(), 1 << ENCODE_IPA_ROUNDS);
        return None;
    }
    let proof = r1cs_prove(&l, &r, &o, &cons, &[(*x, *r_x)])?;
    let want = commit_native(x, r_x);
    if proof.v.len() != 1 || proof.v[0] != want {
        return None;
    }
    let blob = r1cs_write(&proof, ENCODE_IPA_ROUNDS)?;
    #[cfg(test)]
    eprintln!("PHASE kp-prove-done");
    Some(blob)
}

/// The dest-bind circuit accepts this blob for this `kp`, and its committed wire is `Yx`.
#[cfg(test)]
pub(crate) fn kp_opening_verifies(blob: &[u8], kp: &[u8; 32], yx: &[u8; 32]) -> bool {
    let proof = match r1cs_read(blob, ENCODE_IPA_ROUNDS) {
        Some(p) => p,
        None => return false,
    };
    if proof.v.len() != 1 || proof.v[0] != *yx {
        return false;
    }
    let (l, _, _, cons) = p_bind_build(None, kp);
    l.len().next_power_of_two() == 1 << ENCODE_IPA_ROUNDS && r1cs_verify(&proof, l.len(), &cons)
}

pub(crate) fn verify_kp_opening(yx: &[u8; 32], kp: &[u8; 32], blob: &[u8]) -> bool {
    let proof = match r1cs_read(blob, ENCODE_IPA_ROUNDS) {
        Some(p) => p,
        None => return false,
    };
    if proof.v.len() != 1 || proof.v[0] != *yx {
        return false;
    }
    #[cfg(test)]
    eprintln!("PHASE kp-verify-start");
    let (l, _, _, cons) = p_bind_build(None, kp);
    if l.len().next_power_of_two() != 1 << ENCODE_IPA_ROUNDS {
        return false;
    }
    r1cs_verify(&proof, l.len(), &cons)
}

/// Both openings must be the published Y. Constraint lists are rebuilt from
/// public challenges, published S, and public `kc`. A witness of `y = 1` is
/// only a shape key: the constraints do not depend on it.
pub(crate) fn verify_shared_y_links(
    y_bytes: &[u8; 32],
    e_bytes: &[[u8; 32]; crate::tree::ARITY],
    s_bytes: &[[u8; 64]; crate::tree::ARITY],
    kc: &[u8; 32],
    slot_blob: &[u8],
    enc_blob: &[u8],
) -> bool {
    let slot = match r1cs_read(slot_blob, SLOT_IPA_ROUNDS) {
        Some(p) => p,
        None => return false,
    };
    let enc = match r1cs_read(enc_blob, ENCODE_IPA_ROUNDS) {
        Some(p) => p,
        None => return false,
    };
    if slot.v.len() != 1 || enc.v.len() != 1 {
        return false;
    }
    if slot.v[0] != *y_bytes || enc.v[0] != *y_bytes {
        return false;
    }
    let one = RScalar::from(1u64);
    #[cfg(test)]
    eprintln!("PHASE slot-verify-start");
    let (sl, _, _, scons) = slot_link_synth(&one, &one, e_bytes, s_bytes, 0);
    if sl.len().next_power_of_two() != 1 << SLOT_IPA_ROUNDS {
        return false;
    }
    if !r1cs_verify(&slot, sl.len(), &scons) {
        return false;
    }
    #[cfg(test)]
    eprintln!("PHASE encode-verify-start");
    let (el, _, _, econs) = c_bind_build(None, kc);
    if el.len().next_power_of_two() != 1 << ENCODE_IPA_ROUNDS {
        return false;
    }
    r1cs_verify(&enc, el.len(), &econs)
}

/// The encode circuit accepts this blob for this `kc`, whatever Y the leaf published.
#[cfg(test)]
pub(crate) fn encode_opening_verifies(blob: &[u8], kc: &[u8; 32]) -> bool {
    let proof = match r1cs_read(blob, ENCODE_IPA_ROUNDS) {
        Some(p) => p,
        None => return false,
    };
    let (l, _, _, cons) = c_bind_build(None, kc);
    l.len().next_power_of_two() == 1 << ENCODE_IPA_ROUNDS && r1cs_verify(&proof, l.len(), &cons)
}

/// The slot circuit accepts this blob for these public challenges and integers.
#[cfg(test)]
pub(crate) fn slot_opening_verifies(
    blob: &[u8],
    e_bytes: &[[u8; 32]; crate::tree::ARITY],
    s_bytes: &[[u8; 64]; crate::tree::ARITY],
) -> bool {
    let proof = match r1cs_read(blob, SLOT_IPA_ROUNDS) {
        Some(p) => p,
        None => return false,
    };
    let one = RScalar::from(1u64);
    let (l, _, _, cons) = slot_link_synth(&one, &one, e_bytes, s_bytes, 0);
    l.len().next_power_of_two() == 1 << SLOT_IPA_ROUNDS && r1cs_verify(&proof, l.len(), &cons)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fe_bytes(n: u8) -> Fe {
        let mut b = [0u8; 32];
        for i in 0..32 {
            b[i] = n.wrapping_mul(3).wrapping_add(i as u8).wrapping_mul(n | 1);
        }
        b[31] &= 0x7f;
        Fe::from_bytes(&b).carry_full()
    }

    #[test]
    fn fe_mul_gate_count_and_scalar_mul_cost() {
        use crate::ipa::hash_to_vesta;
        use group::Group;
        use std::time::Instant;
        let a = fe_bytes(4);
        let b = fe_bytes(9);
        let (l, _, _, _) = fe_mul_synth(a, b, a.mul(b));
        let g = hash_to_vesta(1, b"bench-g");
        let s = Scalar::from(0x1234_5678_9abcu64);
        let t0 = Instant::now();
        let mut acc = g;
        for _ in 0..200 {
            acc += g * s;
        }
        let ms = t0.elapsed().as_millis();
        assert!(!bool::from(acc.is_identity()));
        eprintln!("gates {} padded {} scalar200_ms {}", l.len(), l.len().next_power_of_two(), ms);
    }

    fn priv_op_witness(kind: u8, a: Fe, c: Fe) -> usize {
        let mut b = Builder::new();
        let aw = fe_priv(&mut b, a);
        let cw = fe_priv(&mut b, c);
        let _out = match kind {
            0 => fe_mul(&mut b, aw, cw),
            1 => fe_add(&mut b, aw, cw),
            _ => fe_sub(&mut b, aw, cw),
        };
        r1cs_witness_holds(&b.l, &b.r, &b.o, &b.cons).unwrap_or_else(|e| panic!("op {kind}: {e}"));
        b.l.len()
    }

    #[test]
    fn fe_mul_tight_matches_field_ops() {
        let a = fe_bytes(4);
        let c = fe_bytes(9);
        let pairs = [
            (Fe::ZERO, Fe::ZERO),
            (Fe::ZERO, Fe::ONE),
            (Fe::ONE, fe_bytes(2)),
            (a, c),
            (a, a),
            (fe_bytes(1), fe_bytes(255)),
        ];
        let mut mul_g = 0usize;
        let mut add_g = 0usize;
        let mut sub_g = 0usize;
        for (x, y) in pairs {
            mul_g = priv_op_witness(0, x, y);
            add_g = priv_op_witness(1, x, y);
            sub_g = priv_op_witness(2, x, y);
        }
        for i in 0..40u8 {
            mul_g = priv_op_witness(0, fe_bytes(i), fe_bytes(i.wrapping_mul(3).wrapping_add(1)));
            add_g = priv_op_witness(1, fe_bytes(i), fe_bytes(i.wrapping_add(9)));
            sub_g = priv_op_witness(2, fe_bytes(i.wrapping_add(4)), fe_bytes(i.wrapping_add(11)));
        }
        eprintln!(
            "tight mul gates {} add {} sub {} padded_mul {}",
            mul_g,
            add_g,
            sub_g,
            mul_g.next_power_of_two()
        );
    }

    #[test]
    fn fe_mul_witness_satisfies_the_r1cs() {
        let a = fe_bytes(4);
        let b = fe_bytes(9);
        assert!(fe_mul_witness_ok(a, b), "honest field product is not an R1CS witness");
        assert!(fe_mul_witness_ok(Fe::ZERO, fe_bytes(2)));
        assert!(fe_mul_witness_ok(Fe::ONE, fe_bytes(2)));
    }

    #[test]
    fn fe_mul_proof_accepts_the_product_and_rejects_another() {
        let a = fe_bytes(4);
        let b = fe_bytes(9);
        let c = a.mul(b);
        assert!(fe_mul_witness_ok(a, b));
        let proof = fe_mul_prove(a, b, c).expect("prove");
        assert!(fe_mul_verify(&proof, a, b, c), "honest product");
        let mut wrong = c;
        wrong.0[0] ^= 1;
        let wrong = wrong.carry_full();
        assert!(wrong.to_bytes() != c.carry_full().to_bytes());
        assert!(!fe_mul_verify(&proof, a, b, wrong), "a different product must fail");
    }

    fn check_compress(ed: Ed, dalek_enc: Option<[u8; 32]>) {
        let enc = ed.ristretto_compress();
        if let Some(d) = dalek_enc {
            assert_eq!(enc, d, "encode disagrees with dalek");
        }
        let (l, r, o, c) = ristretto_compress_synth(ed, &enc);
        r1cs_witness_holds(&l, &r, &o, &c).unwrap_or_else(|e| {
            panic!("{e} (gates {})", l.len());
        });
        eprintln!("compress gates {} padded {}", l.len(), l.len().next_power_of_two());
    }

    /// Cleartext branch flags of `Ed::ristretto_compress`, used only to pick samples.
    fn compress_flags(ed: Ed) -> (bool, bool, bool) {
        let u1 = ed.z.add(ed.y).mul(ed.z.sub(ed.y));
        let u2 = ed.x.mul(ed.y);
        let (_, inv) = u1.mul(u2.square()).invsqrt();
        let i1 = inv.mul(u1);
        let i2 = inv.mul(u2);
        let z_inv = i1.mul(i2.mul(ed.t));
        let rotate = ed.t.mul(z_inv).is_negative();
        let (x, y, den) = if rotate {
            (ed.y.mul(sqrt_m1()), ed.x.mul(sqrt_m1()), i1.mul(magic_fe()))
        } else {
            (ed.x, ed.y, i2)
        };
        let y_neg = x.mul(z_inv).is_negative();
        let y = if y_neg { y.neg() } else { y };
        let s_neg = den.mul(ed.z.sub(y)).is_negative();
        (rotate, y_neg, s_neg)
    }

    #[test]
    fn compress_witness_matches_ristretto_encode() {
        use crate::fe25519::ristretto_decompress;
        use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
        use curve25519_dalek::ristretto::RistrettoPoint;

        let id = ristretto_decompress(&[0u8; 32]).expect("identity encoding");
        check_compress(id, Some([0u8; 32]));

        let mut n_rotate = 0u32;
        let mut n_y = 0u32;
        let mut n_s = 0u32;
        let mut rotate_ed = None;
        let mut y_ed = None;
        let mut s_ed = None;
        let mut note = |ed: Ed| {
            let (r, y, s) = compress_flags(ed);
            if r {
                n_rotate += 1;
                rotate_ed = Some(ed);
            }
            if y {
                n_y += 1;
                y_ed = Some(ed);
            }
            if s {
                n_s += 1;
                s_ed = Some(ed);
            }
        };
        let mut p = RISTRETTO_BASEPOINT_POINT;
        for i in 1..32u64 {
            let enc = p.compress().to_bytes();
            let ed = ristretto_decompress(&enc).expect("dec");
            note(ed);
            if i == 1 || i == 5 {
                check_compress(ed, Some(enc));
            }
            p += RISTRETTO_BASEPOINT_POINT;
        }
        // Decompress picks a representative whose rotate and y-negate bits are clear.
        // Extended sums are what hit those branches.
        let base_ed = ristretto_decompress(&RISTRETTO_BASEPOINT_POINT.compress().to_bytes()).unwrap();
        let mut acc = base_ed;
        for i in 0..48u8 {
            let mut wide = [i; 64];
            wide[31] = i.wrapping_mul(9);
            wide[63] = i.wrapping_add(17);
            let h = RistrettoPoint::from_uniform_bytes(&wide);
            let ed = ristretto_decompress(&h.compress().to_bytes()).expect("uniform scan");
            note(ed);
            acc = acc.add(ed);
            note(acc);
            note(ed.add(ed));
        }
        eprintln!("branch samples rotate {n_rotate} y {n_y} s {n_s}");
        assert!(n_rotate > 0, "no sample took the rotate branch");
        assert!(n_y > 0, "no sample negated y");
        assert!(n_s > 0, "no sample negated s");
        check_compress(rotate_ed.expect("rotate"), None);
        check_compress(y_ed.expect("y"), None);
        check_compress(s_ed.expect("s"), None);

        let h = RistrettoPoint::from_uniform_bytes(&[9u8; 64]);
        let henc = h.compress().to_bytes();
        let hed = ristretto_decompress(&henc).expect("uniform");
        check_compress(hed, Some(henc));
        let a = ristretto_decompress(&RISTRETTO_BASEPOINT_POINT.compress().to_bytes()).unwrap();
        let sum = a.add(hed);
        let sum_enc = (RISTRETTO_BASEPOINT_POINT + h).compress().to_bytes();
        assert_eq!(sum.ristretto_compress(), sum_enc, "extended add disagrees with dalek");
        check_compress(sum, Some(sum_enc));

        let mut bad = RISTRETTO_BASEPOINT_POINT.compress().to_bytes();
        bad[0] ^= 1;
        let ed = ristretto_decompress(&RISTRETTO_BASEPOINT_POINT.compress().to_bytes()).unwrap();
        let (l, r, o, c) = ristretto_compress_synth(ed, &bad);
        assert!(
            r1cs_witness_holds(&l, &r, &o, &c).is_err(),
            "a different encoding must fail the witness"
        );
    }

    fn dalek_order_limbs(bytes: &[u8; 32]) -> [u128; 5] {
        use curve25519_dalek::scalar::Scalar as RScalar;
        unpack52(&RScalar::from_bytes_mod_order(*bytes).to_bytes())
    }

    #[test]
    fn bind_order_reduce_matches_dalek() {
        let mut samples = Vec::new();
        samples.push([0u8; 32]);
        let mut one = [0u8; 32];
        one[0] = 1;
        samples.push(one);
        samples.push([0xff; 32]);
        let mut bit252 = [0u8; 32];
        bit252[31] = 0x10;
        samples.push(bit252);
        let mut bit255 = [0u8; 32];
        bit255[31] = 0x80;
        samples.push(bit255);
        samples.push([0x5au8; 32]);
        let mut mixed = [0u8; 32];
        for i in 0..32 {
            mixed[i] = (i as u8).wrapping_mul(7).wrapping_add(3);
        }
        samples.push(mixed);
        let ell = pack52(&L52);
        samples.push(ell);
        let mut ell_plus = ell;
        ell_plus[0] = ell_plus[0].wrapping_add(1);
        samples.push(ell_plus);
        let mut below = ell;
        below[0] = below[0].wrapping_sub(1);
        samples.push(below);
        for (n, bytes) in samples.iter().enumerate() {
            let expect = dalek_order_limbs(bytes);
            assert_eq!(order_limbs(bytes), expect, "sample {n} cleartext");
            assert_eq!(pack52(&expect), curve25519_dalek::scalar::Scalar::from_bytes_mod_order(*bytes).to_bytes());
            let (l, r, o, c) = order_reduce_synth(bytes, &expect);
            r1cs_witness_holds(&l, &r, &o, &c).unwrap_or_else(|e| panic!("sample {n}: {e}"));
            if n == 0 {
                eprintln!("order gates {} padded {}", l.len(), l.len().next_power_of_two());
                let mut bad = expect;
                bad[0] = (bad[0] + 1) & (BASE52 - 1);
                let (l, r, o, c) = order_reduce_synth(bytes, &bad);
                assert!(
                    r1cs_witness_holds(&l, &r, &o, &c).is_err(),
                    "a different residue must fail the witness"
                );
            }
        }
    }

    fn cons_same(a: &[Vec<(Wire, Scalar)>], b: &[Vec<(Wire, Scalar)>]) -> bool {
        if a.len() != b.len() {
            return false;
        }
        for (x, y) in a.iter().zip(b.iter()) {
            if x.len() != y.len() {
                return false;
            }
            for (p, q) in x.iter().zip(y.iter()) {
                if p.0 != q.0 || p.1 != q.1 {
                    return false;
                }
            }
        }
        true
    }

    /// The verifier rebuilds constraints from a dummy witness. The secret bytes
    /// are not an input. `V[0]` is the reduced scalar.
    #[test]
    fn bind_order_reduce_commitment_hides_the_bytes() {
        let secret = [0x5au8; 32];
        let (l, r, o, cons, packed) = order_reduce_committed(&secret);
        let (_, _, _, zeros, _) = order_reduce_committed(&[0u8; 32]);
        let mut ff = [0xffu8; 32];
        ff[31] = 0x0f;
        let (_, _, _, other, _) = order_reduce_committed(&ff);
        assert!(cons_same(&cons, &zeros), "zero bytes changed the constraint shape");
        assert!(cons_same(&cons, &other), "another input changed the constraint shape");
        let committed = Scalar::from_repr(packed.into());
        let v = Option::<Scalar>::from(committed).expect("reduced scalar fits in Vesta");
        let blind = Scalar::from(3u64);
        let proof = r1cs_prove(&l, &r, &o, &cons, &[(v, blind)]).expect("committed order proof");
        assert!(
            r1cs_verify(&proof, l.len(), &zeros),
            "verifier must accept without the secret bytes"
        );
        let wrong = r1cs_prove(&l, &r, &o, &cons, &[(v + Scalar::ONE, blind)]).expect("wrong commit");
        assert!(!r1cs_verify(&wrong, l.len(), &zeros), "a different residue must fail");
    }

    /// The order gadget is an inner product proof, not only a witness trace.
    /// A different residue fails verification. The bytes and the residue are
    /// the public statement here; the leaf hides them behind the CDS link.
    #[test]
    fn bind_order_reduce_r1cs_accepts_and_rejects() {
        use std::time::Instant;
        let bytes = [0x5au8; 32];
        let expect = order_limbs(&bytes);
        let (l, r, o, cons) = order_reduce_synth(&bytes, &expect);
        let t0 = Instant::now();
        let proof = r1cs_prove(&l, &r, &o, &cons, &[]).expect("order proof");
        let prove_ms = t0.elapsed().as_millis();
        let t1 = Instant::now();
        assert!(r1cs_verify(&proof, l.len(), &cons), "honest order reduction");
        let verify_ms = t1.elapsed().as_millis();
        let t2 = Instant::now();
        let proof2 = r1cs_prove(&l, &r, &o, &cons, &[]).expect("second order proof");
        let prove2_ms = t2.elapsed().as_millis();
        assert!(r1cs_verify(&proof2, l.len(), &cons), "cached generators still verify");
        eprintln!(
            "order r1cs gates {} padded {} prove_ms {} verify_ms {} prove2_ms {}",
            l.len(),
            l.len().next_power_of_two(),
            prove_ms,
            verify_ms,
            prove2_ms
        );
        let mut bad = expect;
        bad[0] = (bad[0] + 1) & (BASE52 - 1);
        let (_, _, _, bad_cons) = order_reduce_synth(&bytes, &bad);
        assert!(
            !r1cs_verify(&proof, l.len(), &bad_cons),
            "a proof of one residue must not verify as another"
        );
    }

    #[test]
    fn bind_sha512_one_block_matches_sha2() {
        use crate::leaf::DST_LEAF;
        use sha2::{Digest, Sha512};
        let mut dest = Vec::new();
        dest.extend_from_slice(DST_LEAF);
        dest.extend_from_slice(&[0u8; 32]);
        let mut dest_ff = Vec::new();
        dest_ff.extend_from_slice(DST_LEAF);
        dest_ff.extend_from_slice(&[0xff; 32]);
        let long = vec![0x5au8; 111];
        let samples: [&[u8]; 5] = [b"", b"a", dest.as_slice(), dest_ff.as_slice(), long.as_slice()];
        for (n, msg) in samples.iter().enumerate() {
            let dig = Sha512::digest(msg);
            let mut expect = [0u8; 64];
            expect.copy_from_slice(&dig);
            let (l, r, o, c) = sha512_one_block_synth(msg, &expect);
            r1cs_witness_holds(&l, &r, &o, &c).unwrap_or_else(|e| panic!("sample {n}: {e}"));
            if n == 2 {
                eprintln!("sha512 gates {} padded {}", l.len(), l.len().next_power_of_two());
                let mut bad = expect;
                bad[0] ^= 1;
                let (l, r, o, c) = sha512_one_block_synth(msg, &bad);
                assert!(
                    r1cs_witness_holds(&l, &r, &o, &c).is_err(),
                    "a different digest must fail the witness"
                );
            }
        }
    }

    #[test]
    fn bind_challenge_open_rejects_a_different_scalar() {
        use crate::leaf::sha512_64;
        use curve25519_dalek::ristretto::RistrettoPoint;
        use curve25519_dalek::scalar::Scalar as RScalar;
        let g = RistrettoPoint::from_uniform_bytes(&sha512_64(&[b"shear-admit-v3-bind-G"]));
        let h = RistrettoPoint::from_uniform_bytes(&sha512_64(&[b"shear-admit-v3-bind-H"]));
        assert_ne!(g.compress().to_bytes(), h.compress().to_bytes());
        let y = RScalar::from(3u64);
        let blind = RScalar::from(5u64);
        let ky = RScalar::from(7u64);
        let kr = RScalar::from(9u64);
        let e = RScalar::from(11u64);
        let zy = ky + e * y;
        let zr = kr + e * blind;
        let a = g * ky + h * kr;
        let ycom = g * y + h * blind;
        assert!(challenge_open_holds(&g, &h, &e, &zy, &zr, &a, &ycom));
        let y2 = RScalar::from(4u64);
        let ycom2 = g * y2 + h * blind;
        assert!(
            !challenge_open_holds(&g, &h, &e, &zy, &zr, &a, &ycom2),
            "one response opened two scalars"
        );
        let zy2 = ky + e * y2;
        assert!(challenge_open_holds(&g, &h, &e, &zy2, &zr, &a, &ycom2));
        assert!(!challenge_open_holds(&g, &h, &RScalar::ZERO, &zy, &zr, &a, &ycom));
    }

    #[test]
    fn bind_c_window_matches_dalek() {
        use curve25519_dalek::ristretto::RistrettoPoint;
        use curve25519_dalek::scalar::Scalar as RScalar;
        use curve25519_dalek::traits::Identity;
        let table = h_windows();
        let h = ristretto_h_note();
        assert_eq!(table[0][1].ristretto_compress(), h.compress().to_bytes(), "window 0 digit 1 is H");
        let id = RistrettoPoint::identity().compress().to_bytes();
        for w in 0..32 {
            assert_eq!(table[w][0].ristretto_compress(), id, "window {w} digit 0");
        }
        let ci = RistrettoPoint::from_uniform_bytes(&[7u8; 64]);
        let mut wide_raw = [0u8; 32];
        for i in 0..32 {
            wide_raw[i] = (i as u8).wrapping_mul(9).wrapping_add(1);
        }
        let rhos = [RScalar::ZERO, RScalar::from(1u64), RScalar::from_bytes_mod_order(wide_raw)];
        for (n, rho) in rhos.iter().enumerate() {
            let mut acc = ed_from_ristretto(&ci);
            let bytes = rho.to_bytes();
            for i in 0..32 {
                acc = acc.add(table[i][bytes[i] as usize]);
            }
            let expect = (ci + h * *rho).compress().to_bytes();
            assert_eq!(acc.ristretto_compress(), expect, "rho sample {n}");
        }
    }

    #[test]
    fn bind_c_witness_ties_kc_and_the_encoding() {
        use curve25519_dalek::ristretto::RistrettoPoint;
        use curve25519_dalek::scalar::Scalar as RScalar;
        let mut samples = vec![Fe::ZERO, Fe::ONE, Fe::from_bytes(&[0x5au8; 32]).carry_full()];
        let mut edge = [0u8; 32];
        edge[6] = 0x07;
        edge[12] = 0x3f;
        edge[19] = 0x01;
        edge[25] = 0x0f;
        edge[31] = 0x7f;
        samples.push(Fe::from_bytes(&edge).carry_full());
        for (n, f) in samples.iter().enumerate() {
            let f = f.carry_full();
            let mut limbs = [0u128; 5];
            for i in 0..5 {
                limbs[i] = f.0[i] as u128;
            }
            assert_eq!(encoding_bytes_from_limbs(&limbs), f.to_bytes(), "layout {n}");
        }

        let h = ristretto_h_note();
        let ci_pt = RistrettoPoint::from_uniform_bytes(&[11u8; 64]);
        let mut rho_raw = [0u8; 32];
        for i in 0..32 {
            rho_raw[i] = (i as u8).wrapping_mul(3).wrapping_add(5);
        }
        let rho = RScalar::from_bytes_mod_order(rho_raw);
        let ci = ed_from_ristretto(&ci_pt);
        let enc = ci.ristretto_compress();
        let y_bytes = RScalar::from_bytes_mod_order(enc).to_bytes();
        assert_eq!(pack52(&order_limbs(&enc)), y_bytes, "order reduction left the ristretto scalar");
        let y = Option::<Scalar>::from(Scalar::from_repr(y_bytes.into())).expect("reduced scalar fits in Vesta");
        let kc = (ci_pt + h * rho).compress().to_bytes();

        let (dl, dr, d_o, dcons) = c_bind_build(None, &kc);
        drop(dl);
        drop(dr);
        drop(d_o);
        let (l, r, o, cons) = c_bind_build(Some((ci, rho)), &kc);
        assert!(cons_same(&cons, &dcons), "dummy rebuild changed the constraint shape");
        eprintln!("c bind gates {} padded {}", l.len(), l.len().next_power_of_two());
        r1cs_witness_holds_v(&l, &r, &o, &cons, &[y]).unwrap_or_else(|e| panic!("honest bind: {e}"));
        assert!(
            r1cs_witness_holds_v(&l, &r, &o, &cons, &[y + Scalar::ONE]).is_err(),
            "a different encoding was accepted"
        );
        drop(l);
        drop(r);
        drop(o);

        let other = (ci_pt + h * (rho + RScalar::ONE)).compress().to_bytes();
        assert_ne!(other, kc);
        let (fl, fr, fo, fcons) = c_bind_build(Some((ci, rho)), &other);
        assert!(
            r1cs_witness_holds_v(&fl, &fr, &fo, &fcons, &[y]).is_err(),
            "kc of a different point was accepted"
        );
    }

    #[test]
    fn slot_link_witness_accepts_one_slot_and_rejects_a_different_scalar() {
        use crate::select::{mul_add_wide, rs_rand};
        use crate::tree::ARITY;
        use curve25519_dalek::scalar::Scalar as RScalar;
        let mut lbytes = [0u8; 32];
        for i in 0..8 {
            let v = L32[i] as u32;
            lbytes[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        assert_eq!(RScalar::from_bytes_mod_order(lbytes), RScalar::ZERO, "L limbs");
        let y = rs_rand();
        let k = rs_rand();
        let index = 4usize;
        let mut e_bytes = [[0u8; 32]; ARITY];
        let mut s_bytes = [[0u8; 64]; ARITY];
        for j in 0..ARITY {
            e_bytes[j] = rs_rand().to_bytes();
            let mut raw = [0u8; 64];
            raw[0] = (j as u8).wrapping_add(3);
            s_bytes[j] = raw;
        }
        let e = RScalar::from_bytes_mod_order(e_bytes[index]);
        s_bytes[index] = mul_add_wide(&k, &e, &y).expect("wide");
        let (l, r, o, cons) = slot_link_synth(&y, &k, &e_bytes, &s_bytes, index);
        eprintln!("slot link gates {} padded {}", l.len(), l.len().next_power_of_two());
        assert!(
            l.len() <= 65536,
            "gates {} would pad past 2^16",
            l.len()
        );
        let yv = Option::<Scalar>::from(Scalar::from_repr(y.to_bytes().into())).expect("embed");
        r1cs_witness_holds_v(&l, &r, &o, &cons, &[yv]).unwrap_or_else(|err| panic!("honest slot: {err}"));
        assert!(
            r1cs_witness_holds_v(&l, &r, &o, &cons, &[yv + Scalar::ONE]).is_err(),
            "a different committed scalar was accepted"
        );
        let y2 = y + RScalar::ONE;
        let (l2, r2, o2, cons2) = slot_link_synth(&y2, &k, &e_bytes, &s_bytes, index);
        assert!(cons_same(&cons, &cons2), "secret y changed the constraint shape");
        let y2v = Option::<Scalar>::from(Scalar::from_repr(y2.to_bytes().into())).expect("embed 2");
        assert!(
            r1cs_witness_holds_v(&l2, &r2, &o2, &cons2, &[y2v]).is_err(),
            "y + 1 must not open the published S"
        );
        let (_, _, _, cons3) = slot_link_synth(&y, &k, &e_bytes, &s_bytes, 11);
        assert!(cons_same(&cons, &cons3), "the slot index changed the constraint shape");
    }

    #[test]
    fn slot_link_r1cs_accepts_honest_commitment() {
        use crate::select::{mul_add_wide, rs_rand, vs_rand};
        use crate::tree::ARITY;
        use curve25519_dalek::scalar::Scalar as RScalar;
        let y = rs_rand();
        let k = rs_rand();
        let index = 9usize;
        let mut e_bytes = [[0u8; 32]; ARITY];
        let mut s_bytes = [[0u8; 64]; ARITY];
        for j in 0..ARITY {
            e_bytes[j] = rs_rand().to_bytes();
            s_bytes[j][0] = j as u8;
        }
        let e = RScalar::from_bytes_mod_order(e_bytes[index]);
        s_bytes[index] = mul_add_wide(&k, &e, &y).expect("wide");
        let (l, r, o, cons) = slot_link_synth(&y, &k, &e_bytes, &s_bytes, index);
        let yv = Option::<Scalar>::from(Scalar::from_repr(y.to_bytes().into())).expect("embed");
        let blind = vs_rand();
        let proof = r1cs_prove(&l, &r, &o, &cons, &[(yv, blind)]).expect("slot proof");
        assert!(r1cs_verify(&proof, l.len(), &cons), "honest commitment rejected");
        let wrong = r1cs_prove(&l, &r, &o, &cons, &[(yv + Scalar::ONE, blind)]).expect("wrong commit");
        assert!(!r1cs_verify(&wrong, l.len(), &cons), "a different opening was accepted");
    }

    #[test]
    fn p_bind_witness_matches_dest_fingerprint() {
        use crate::leaf::{dest_leaf_fp, DST_LEAF};
        use crate::tree::note_u;
        use curve25519_dalek::ristretto::RistrettoPoint;
        use curve25519_dalek::scalar::Scalar as RScalar;
        use ff::FromUniformBytes;
        use sha2::{Digest, Sha512};

        let mut pbytes = [0u8; 32];
        for i in 0..8 {
            pbytes[i * 4..i * 4 + 4].copy_from_slice(&(P32[i] as u32).to_le_bytes());
        }
        assert!(
            Option::<Scalar>::from(Scalar::from_repr(pbytes.into())).is_none(),
            "the modulus must not be a canonical scalar"
        );
        let mut one = [0u8; 64];
        one[0] = 1;
        let mut mixed = [0u8; 64];
        for i in 0..64 {
            mixed[i] = (i as u8).wrapping_mul(9).wrapping_add(3);
        }
        for dig in [&[0u8; 64], &one, &[0xff; 64], &mixed] {
            fp_quot_rem(dig);
        }

        let pi_pt = RistrettoPoint::from_uniform_bytes(&[13u8; 64]);
        let mut rho_raw = [0u8; 32];
        for i in 0..32 {
            rho_raw[i] = (i as u8).wrapping_mul(5).wrapping_add(1);
        }
        let rho = RScalar::from_bytes_mod_order(rho_raw);
        let u = note_u();
        let pi = ed_from_ristretto(&pi_pt);
        let enc = pi.ristretto_compress();
        assert_eq!(enc, pi_pt.compress().to_bytes(), "edwards compress left the ristretto encoding");
        let mut msg = Vec::new();
        msg.extend_from_slice(DST_LEAF);
        msg.extend_from_slice(&enc);
        let digest = Sha512::digest(&msg);
        let mut dig = [0u8; 64];
        dig.copy_from_slice(&digest);
        let x = Scalar::from_uniform_bytes(&dig);
        let fp = dest_leaf_fp(&enc);
        let x_fp = Option::<Scalar>::from(Scalar::from_repr(fp.into())).expect("dest fp canonical");
        assert_eq!(x, x_fp, "integer reduction left dest_leaf_fp");
        let kp = (pi_pt + u * rho).compress().to_bytes();

        let (dl, dr, d_o, dcons) = p_bind_build(None, &kp);
        drop((dl, dr, d_o));
        let (l, r, o, cons) = p_bind_build(Some((pi, rho)), &kp);
        assert!(cons_same(&cons, &dcons), "dummy rebuild changed the constraint shape");
        eprintln!("p bind gates {} padded {}", l.len(), l.len().next_power_of_two());
        r1cs_witness_holds_v(&l, &r, &o, &cons, &[x]).unwrap_or_else(|e| panic!("honest bind: {e}"));
        assert!(
            r1cs_witness_holds_v(&l, &r, &o, &cons, &[x + Scalar::ONE]).is_err(),
            "a different fingerprint was accepted"
        );
        let other = (pi_pt + u * (rho + RScalar::ONE)).compress().to_bytes();
        let (fl, fr, fo, fcons) = p_bind_build(Some((pi, rho)), &other);
        assert!(
            r1cs_witness_holds_v(&fl, &fr, &fo, &fcons, &[x]).is_err(),
            "kp of a different point was accepted"
        );
        let pi2 = RistrettoPoint::from_uniform_bytes(&[17u8; 64]);
        let (_, _, _, cons2) = p_bind_build(Some((ed_from_ristretto(&pi2), RScalar::from(3u64))), &kp);
        assert!(cons_same(&cons, &cons2), "the secret point changed the constraint shape");
    }
}
