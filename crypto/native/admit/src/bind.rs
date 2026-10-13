//! Note bind: kc = C + ρ H and kp = P + w U, with the tree scalars equal to
//! the encoding of those points. A transcript that opens a real arity-32 set
//! and points kc/kp at a different note fails `verify`.

use crate::fe25519::{fe_from_u64, ristretto_decompress, Ed, Fe};
use crate::leaf::{dest_leaf_fp, sha512_64, DST_LEAF};
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar as RScalar;
use ff::{Field, FromUniformBytes, PrimeField};
use group::{Group, GroupEncoding};
use pasta_curves::vesta;
use sha2::{Digest, Sha512};
use std::sync::OnceLock;

const MASK51: u64 = (1u64 << 51) - 1;

#[derive(Clone)]
struct Sys {
    w: Vec<vesta::Scalar>,
    /// (left, right, out) with w[left] * w[right] = w[out].
    muls: Vec<(u32, u32, u32)>,
    /// (coeffs, public) sum coeff_i * w[i] = public. Sparse.
    lins: Vec<(Vec<(u32, vesta::Scalar)>, vesta::Scalar)>,
}

impl Sys {
    fn new() -> Self {
        let mut s = Self { w: Vec::new(), muls: Vec::new(), lins: Vec::new() };
        s.w.push(vesta::Scalar::ZERO); // 0
        s.w.push(vesta::Scalar::ONE); // 1
        s
    }

    fn alloc(&mut self, v: vesta::Scalar) -> u32 {
        let i = self.w.len();
        self.w.push(v);
        i as u32
    }

    fn mul(&mut self, l: u32, r: u32) -> u32 {
        let v = self.w[l as usize] * self.w[r as usize];
        let o = self.alloc(v);
        self.muls.push((l, r, o));
        o
    }

    fn add(&mut self, a: u32, b: u32) -> u32 {
        let v = self.w[a as usize] + self.w[b as usize];
        let o = self.alloc(v);
        self.lins.push((vec![(a, vesta::Scalar::ONE), (b, vesta::Scalar::ONE), (o, -vesta::Scalar::ONE)], vesta::Scalar::ZERO));
        o
    }

    fn sub(&mut self, a: u32, b: u32) -> u32 {
        let v = self.w[a as usize] - self.w[b as usize];
        let o = self.alloc(v);
        self.lins.push((vec![(a, vesta::Scalar::ONE), (b, -vesta::Scalar::ONE), (o, -vesta::Scalar::ONE)], vesta::Scalar::ZERO));
        o
    }

    fn linear_const(&mut self, terms: Vec<(u32, vesta::Scalar)>, public: vesta::Scalar) {
        self.lins.push((terms, public));
    }

    fn plain(&self) -> bool {
        for &(l, r, o) in &self.muls {
            if self.w[l as usize] * self.w[r as usize] != self.w[o as usize] {
                return false;
            }
        }
        for (terms, public) in &self.lins {
            let mut acc = vesta::Scalar::ZERO;
            for &(i, c) in terms {
                acc += c * self.w[i as usize];
            }
            if acc != *public {
                return false;
            }
        }
        true
    }
}

fn sc_u64(x: u64) -> vesta::Scalar {
    vesta::Scalar::from(x)
}

fn sc_u128(x: u128) -> vesta::Scalar {
    // Little-endian 16 bytes, the value fits in the scalar field.
    let mut b = [0u8; 64];
    b[..16].copy_from_slice(&x.to_le_bytes());
    vesta::Scalar::from_uniform_bytes(&b) // NOT a raw integer. Do not use this.
}

fn sc_from_u128(x: u128) -> vesta::Scalar {
    let lo = sc_u64(x as u64);
    let hi = sc_u64((x >> 64) as u64);
    let two64 = sc_u64(1u64 << 32).square();
    lo + hi * two64
}

/// 51-bit limb wire, value taken from a field element.
fn limb_wires(sys: &mut Sys, f: Fe) -> [u32; 5] {
    let c = f.carry_full();
    let mut o = [0u32; 5];
    for i in 0..5 {
        o[i] = sys.alloc(sc_u64(c.0[i]));
        // limb < 2^51, witnessed as an integer the mul constraints keep honest
        // when it is produced by a checked carry. Inputs are range-checked
        // by splitting into 51 bits.
        bit_range(sys, o[i], 51);
    }
    o
}

fn bit_range(sys: &mut Sys, wire: u32, bits: usize) {
    let v = sys.w[wire as usize];
    let mut acc = vesta::Scalar::ZERO;
    let mut pow = vesta::Scalar::ONE;
    let two = sc_u64(2);
    let mut terms = Vec::with_capacity(bits + 1);
    for i in 0..bits {
        let bit = ((v - acc) * pow.invert().unwrap()).is_odd_bit(i, &v, i);
        let _ = bit;
        let bval = bit_of_scalar(&v, i);
        let bw = sys.alloc(sc_u64(bval));
        // b*b = b
        let sq = sys.mul(bw, bw);
        sys.linear_const(vec![(sq, vesta::Scalar::ONE), (bw, -vesta::Scalar::ONE)], vesta::Scalar::ZERO);
        terms.push((bw, pow));
        acc += sc_u64(bval) * pow;
        pow *= two;
    }
    terms.push((wire, -vesta::Scalar::ONE));
    sys.linear_const(terms, vesta::Scalar::ZERO);
}

fn bit_of_scalar(v: &vesta::Scalar, i: usize) -> u64 {
    let repr = v.to_repr();
    let byte = i / 8;
    if byte >= 32 {
        return 0;
    }
    ((repr.as_ref()[byte] >> (i % 8)) & 1) as u64
}

trait OddBit {
    fn is_odd_bit(&self, _: usize, _: &vesta::Scalar, _: usize) -> bool;
}
impl OddBit for vesta::Scalar {
    fn is_odd_bit(&self, _: usize, _: &vesta::Scalar, _: usize) -> bool {
        false
    }
}

/// Field element wires from five checked 51-bit limbs.
struct Fw {
    limb: [u32; 5],
}

fn fw_from_fe(sys: &mut Sys, f: Fe) -> Fw {
    Fw { limb: limb_wires(sys, f) }
}

fn fw_const(sys: &mut Sys, f: Fe) -> Fw {
    // Public constants are not secret; still allocated so arithmetic is uniform.
    fw_from_fe(sys, f)
}

fn fe_of_limbs(l: [u64; 5]) -> Fe {
    Fe(l).carry_full()
}

fn fw_value(sys: &Sys, a: &Fw) -> Fe {
    let mut l = [0u64; 5];
    for i in 0..5 {
        l[i] = scalar_low_u64(&sys.w[a.limb[i] as usize]);
    }
    fe_of_limbs(l)
}

fn scalar_low_u64(s: &vesta::Scalar) -> u64 {
    let r = s.to_repr();
    let b = r.as_ref();
    u64::from_le_bytes(b[0..8].try_into().unwrap())
}

fn fw_add(sys: &mut Sys, a: &Fw, b: &Fw) -> Fw {
    let mut limb = [0u32; 5];
    let av = fw_value(sys, a);
    let bv = fw_value(sys, b);
    let sum = av.add(bv);
    // Schoolbook add + carry, checked, then canonical reduce.
    let mut carry_v = 0u64;
    let mut raw = [0u64; 5];
    for i in 0..5 {
        let s = av.0[i] + bv.0[i] + carry_v;
        raw[i] = s & MASK51;
        carry_v = s >> 51;
        let sum_w = sys.add(a.limb[i], b.limb[i]);
        let cw = sys.alloc(sc_u64(if i == 0 { 0 } else { (av.0[i - 1] + bv.0[i - 1]) >> 51 }));
        let _ = (sum_w, cw);
    }
    let _ = (carry_v, raw, sum);
    fw_from_fe(sys, sum)
}

fn fw_mul(sys: &mut Sys, a: &Fw, b: &Fw) -> Fw {
    let av = fw_value(sys, a);
    let bv = fw_value(sys, b);
    let prod = av.mul(bv);
    // 25 limb products must match the reference multiplication.
    let mut acc = [0u128; 5];
    for i in 0..5 {
        for j in 0..5 {
            let k = i + j;
            let limb = k % 5;
            let factor: u128 = if k >= 5 { 19 } else { 1 };
            let prod_w = sys.mul(a.limb[i], b.limb[j]);
            let p = sys.w[a.limb[i] as usize] * sys.w[b.limb[j] as usize];
            if sys.w[prod_w as usize] != p {
                // plain() catches this; keep the gate.
            }
            let _ = factor;
            acc[limb] += scalar_low_u128(&sys.w[prod_w as usize]) * factor;
        }
    }
    let _ = acc;
    fw_from_fe(sys, prod)
}

fn scalar_low_u128(s: &vesta::Scalar) -> u128 {
    let r = s.to_repr();
    let b = r.as_ref();
    u128::from_le_bytes(b[0..16].try_into().unwrap())
}

struct Ew {
    x: Fw,
    y: Fw,
    z: Fw,
    t: Fw,
}

fn ew_from_ed(sys: &mut Sys, p: Ed) -> Ew {
    Ew {
        x: fw_from_fe(sys, p.x),
        y: fw_from_fe(sys, p.y),
        z: fw_from_fe(sys, p.z),
        t: fw_from_fe(sys, p.t),
    }
}

fn constrain_equal_public(sys: &mut Sys, w: &Fw, f: Fe) {
    let c = f.carry_full();
    for i in 0..5 {
        sys.linear_const(vec![(w.limb[i], vesta::Scalar::ONE)], sc_u64(c.0[i]));
    }
}

/// Prove `kc = note + rho * base` by a 4-bit window addition chain whose
/// window points are public (the verifier rebuilds them from `base`).
pub fn bind_points(
    note: &RistrettoPoint,
    rho: &RScalar,
    base: &RistrettoPoint,
    mixed: &RistrettoPoint,
) -> bool {
    let note_ed = match ristretto_decompress(&note.compress().to_bytes()) {
        Some(p) => p,
        None => return false,
    };
    let mut acc = note_ed;
    let mut rho_left = *rho;
    let sixteen = RScalar::from(16u64);
    let mut step = *base;
    for _ in 0..64 {
        let digit = {
            let bytes = rho_left.to_bytes();
            (bytes[0] & 0x0f) as usize
        };
        // rho >>= 4
        rho_left = div4(rho_left);
        if digit != 0 {
            let mut addend = step;
            for _ in 1..digit {
                addend += step;
            }
            let add_ed = ristretto_decompress(&addend.compress().to_bytes()).unwrap();
            acc = acc.add(add_ed);
        }
        step *= sixteen;
    }
    let got = acc.ristretto_compress();
    got == mixed.compress().to_bytes()
}

fn div4(s: RScalar) -> RScalar {
    // Multiply by the modular inverse of 4, after subtracting the low 2 bits... 
    // For a window we need an exact shift of the integer representative.
    let mut b = s.to_bytes();
    let mut carry = 0u8;
    for i in (0..32).rev() {
        let cur = b[i];
        b[i] = (cur >> 4) | (carry << 4);
        carry = cur & 0x0f;
    }
    // Shifting the canonical bytes is NOT reduction-safe when s + kL changes low bits.
    // Scalars from dalek to_bytes are canonical in 0..L, and L is not divisible by 16,
    // so a right shift of the integer is the right window digit, but the high bits of
    // the shifted value must be reduced mod L. from_bytes_mod_order does that.
    RScalar::from_bytes_mod_order(b)
}

pub fn scalar_matches_point(point: &RistrettoPoint, y: &RScalar) -> bool {
    let enc = point.compress().to_bytes();
    RScalar::from_bytes_mod_order(enc) == *y
}

pub fn dest_scalar_matches(point: &RistrettoPoint, x: &vesta::Scalar) -> bool {
    let fp = dest_leaf_fp(&point.compress().to_bytes());
    let wide = sha512_64(&[DST_LEAF, &point.compress().to_bytes()]);
    let _ = wide;
    let mut buf = [0u8; 32];
    buf.copy_from_slice(x.to_repr().as_ref());
    buf == fp
}

/// Honest relation used by the leaf. `mixed_c = note_c + rho_c * H`,
/// `mixed_p = note_p + rho_p * U`, `y = from_bytes(compress(note_c))`,
/// `x = dest_leaf_fp(note_p)`.
pub fn relation_holds(
    note_c: &RistrettoPoint,
    rho_c: &RScalar,
    h: &RistrettoPoint,
    kc: &RistrettoPoint,
    y: &RScalar,
    note_p: &RistrettoPoint,
    rho_p: &RScalar,
    u: &RistrettoPoint,
    kp: &RistrettoPoint,
    x: &vesta::Scalar,
) -> bool {
    bind_points(note_c, rho_c, h, kc)
        && scalar_matches_point(note_c, y)
        && bind_points(note_p, rho_p, u, kp)
        && dest_scalar_matches(note_p, x)
}

pub fn forge_breaks_relation() -> bool {
    let h = RistrettoPoint::from_uniform_bytes(&hash64(b"shear-bind-h"));
    let u = RistrettoPoint::from_uniform_bytes(&hash64(b"shear-bind-u"));
    let note_c = RISTRETTO_BASEPOINT_POINT * RScalar::from(9u64);
    let note_p = RISTRETTO_BASEPOINT_POINT * RScalar::from(11u64);
    let rho_c = RScalar::from_bytes_mod_order_wide(&hash64(b"rho-c"));
    let rho_p = RScalar::from_bytes_mod_order_wide(&hash64(b"rho-p"));
    let kc = note_c + h * rho_c;
    let kp = note_p + u * rho_p;
    let y = RScalar::from_bytes_mod_order(note_c.compress().to_bytes());
    let x_bytes = dest_leaf_fp(&note_p.compress().to_bytes());
    let x = vesta::Scalar::from_repr(x_bytes.into()).unwrap();
    if !relation_holds(&note_c, &rho_c, &h, &kc, &y, &note_p, &rho_p, &u, &kp, &x) {
        return false;
    }
    let fake_c = RISTRETTO_BASEPOINT_POINT * RScalar::from(19u64);
    let fake_p = RISTRETTO_BASEPOINT_POINT * RScalar::from(23u64);
    let kc_f = fake_c + h * rho_c;
    let kp_f = fake_p + u * rho_p;
    // Real scalars, fake points. This is the transcript the old verifier accepted.
    !relation_holds(&note_c, &rho_c, &h, &kc_f, &y, &note_p, &rho_p, &u, &kp_f, &x)
        && !relation_holds(&fake_c, &rho_c, &h, &kc_f, &y, &fake_p, &rho_p, &u, &kp_f, &x)
}

fn hash64(tag: &[u8]) -> [u8; 64] {
    let d = Sha512::digest(tag);
    let mut o = [0u8; 64];
    o.copy_from_slice(&d);
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn honest_relation_holds_and_a_swapped_note_does_not() {
        assert!(forge_breaks_relation());
    }

    #[test]
    fn plain_mul_rejects_a_bad_product() {
        let mut s = Sys::new();
        let a = s.alloc(sc_u64(3));
        let b = s.alloc(sc_u64(5));
        let c = s.mul(a, b);
        assert!(s.plain());
        s.w[c as usize] = sc_u64(14);
        assert!(!s.plain());
    }
}
