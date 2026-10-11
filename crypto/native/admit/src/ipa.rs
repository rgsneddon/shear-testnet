//! Unblinded inner-product argument on Vesta.
//! Statement: `P = <a, G> + <b, H>` and `<a, b> = c`.
//! `Q` binds `c`. No extra crate. Generators are caller-supplied.

use crate::leaf::sha512_64;
use ff::{Field, FromUniformBytes, PrimeField};
use group::{Group, GroupEncoding};
use pasta_curves::vesta;

type Scalar = vesta::Scalar;
type Point = vesta::Point;

#[derive(Clone, Debug)]
pub struct IpaProof {
    pub l: Vec<[u8; 32]>,
    pub r: Vec<[u8; 32]>,
    pub a: [u8; 32],
    pub b: [u8; 32],
}

fn enc(p: &Point) -> [u8; 32] {
    let e = p.to_bytes();
    let mut o = [0u8; 32];
    o.copy_from_slice(e.as_ref());
    o
}

fn dec(b: &[u8; 32]) -> Option<Point> {
    Option::<Point>::from(Point::from_bytes(&(*b).into()))
}

fn sc_bytes(s: &Scalar) -> [u8; 32] {
    s.to_repr().into()
}

fn sc_in(b: &[u8; 32]) -> Option<Scalar> {
    Option::<Scalar>::from(Scalar::from_repr((*b).into()))
}

struct Fs {
    st: Vec<u8>,
}

impl Fs {
    fn new(label: &[u8]) -> Self {
        Self { st: label.to_vec() }
    }
    fn point(&mut self, p: &[u8; 32]) {
        self.st.extend_from_slice(p);
    }
    fn scalar(&mut self, s: &Scalar) {
        self.st.extend_from_slice(&sc_bytes(s));
    }
    fn chal(&mut self) -> Option<Scalar> {
        let d = sha512_64(&[b"shear-admit-v3-ipa", &self.st]);
        self.st.extend_from_slice(&d);
        let s = Scalar::from_uniform_bytes(&d);
        if bool::from(s.is_zero()) {
            None
        } else {
            Some(s)
        }
    }
}

pub(crate) fn hash_to_vesta(i: u64, dst: &[u8]) -> Point {
    let mut w = sha512_64(&[dst, &i.to_le_bytes()]);
    for ctr in 0u8..=255 {
        w[63] = ctr;
        let mut repr = [0u8; 32];
        repr.copy_from_slice(&w[..32]);
        if let Some(p) = Option::<Point>::from(Point::from_bytes(&repr.into())) {
            if !bool::from(p.is_identity()) {
                return p;
            }
        }
    }
    Point::generator() * Scalar::from(i + 1)
}

fn msm_naive(scalars: &[Scalar], points: &[Point]) -> Point {
    let mut acc = Point::identity();
    for (s, p) in scalars.iter().zip(points.iter()) {
        if !bool::from(s.is_zero()) {
            acc += *p * s;
        }
    }
    acc
}

fn scalar_digit(s: &Scalar, shift: usize, width: usize) -> usize {
    let bytes: [u8; 32] = s.to_repr().into();
    let mut digit = 0usize;
    for bit in 0..width {
        let at = shift + bit;
        let byte = bytes[at / 8];
        let one = ((byte >> (at % 8)) & 1) as usize;
        digit |= one << bit;
    }
    digit
}

fn bucket_running_sum(buckets: &[Point]) -> Point {
    let mut run = Point::identity();
    let mut win = Point::identity();
    for digit in (1..buckets.len()).rev() {
        run += buckets[digit];
        win += run;
    }
    win
}

fn fill_buckets(scalars: &[Scalar], points: &[Point], shift: usize, window: usize, buckets: &mut [Point]) {
    for b in buckets.iter_mut() {
        *b = Point::identity();
    }
    let n = scalars.len().min(points.len());
    for i in 0..n {
        let digit = scalar_digit(&scalars[i], shift, window);
        if digit != 0 {
            buckets[digit] += points[i];
        }
    }
}

/// Bucket multiscalar multiply. Same result as one scalar multiplication per point.
/// Bucket fills for large inputs run on four threads. Each thread owns its buckets,
/// and the window sum adds those buckets, so the product is unchanged.
fn msm_pippenger(scalars: &[Scalar], points: &[Point], window: usize) -> Point {
    let n = scalars.len().min(points.len());
    if n == 0 {
        return Point::identity();
    }
    let buckets_n = 1usize << window;
    let windows = (256 + window - 1) / window;
    let threads = if n >= 64 { 4.min(n) } else { 1 };
    let mut acc = Point::identity();
    for w in (0..windows).rev() {
        if w + 1 != windows {
            for _ in 0..window {
                acc = acc.double();
            }
        }
        let shift = w * window;
        let win = if threads == 1 {
            let mut buckets = vec![Point::identity(); buckets_n];
            fill_buckets(&scalars[..n], &points[..n], shift, window, &mut buckets);
            bucket_running_sum(&buckets)
        } else {
            let chunk = (n + threads - 1) / threads;
            let mut partials = vec![vec![Point::identity(); buckets_n]; threads];
            std::thread::scope(|scope| {
                for (t, buckets) in partials.iter_mut().enumerate() {
                    let lo = t * chunk;
                    if lo >= n {
                        continue;
                    }
                    let hi = (lo + chunk).min(n);
                    let sc = &scalars[lo..hi];
                    let pt = &points[lo..hi];
                    scope.spawn(move || {
                        fill_buckets(sc, pt, shift, window, buckets);
                    });
                }
            });
            let mut buckets = vec![Point::identity(); buckets_n];
            for part in &partials {
                for digit in 1..buckets_n {
                    buckets[digit] += part[digit];
                }
            }
            bucket_running_sum(&buckets)
        };
        acc += win;
    }
    acc
}

pub(crate) fn msm(scalars: &[Scalar], points: &[Point]) -> Point {
    let n = scalars.len().min(points.len());
    if n < 32 {
        msm_naive(&scalars[..n], &points[..n])
    } else if n < 512 {
        msm_pippenger(scalars, points, 4)
    } else {
        msm_pippenger(scalars, points, 8)
    }
}

/// Coefficient of original generator `i` after the IPA fold.
/// `h_side` swaps `u` and `u^{-1}`, matching the H fold.
fn ipa_coef(index: usize, us: &[Scalar], uis: &[Scalar], h_side: bool) -> Scalar {
    let rounds = us.len();
    let mut s = Scalar::ONE;
    for r in 0..rounds {
        let hi = ((index >> (rounds - 1 - r)) & 1) == 1;
        let use_u = if h_side { !hi } else { hi };
        s *= if use_u { us[r] } else { uis[r] };
    }
    s
}

/// Coefficient of original generator `index` after `us.len()` folds of an `n`-long vector.
fn coef_so_far(index: usize, n: usize, us: &[Scalar], uis: &[Scalar], h_side: bool) -> Scalar {
    let total = n.trailing_zeros() as usize;
    let mut s = Scalar::ONE;
    for r in 0..us.len() {
        let hi = ((index >> (total - 1 - r)) & 1) == 1;
        let use_u = if h_side { !hi } else { hi };
        s *= if use_u { us[r] } else { uis[r] };
    }
    s
}

/// Scalars on the original generators for one half of a folded inner product.
/// `pair[i]` multiplies logical slot `slot_base + i`.
fn expand_half(
    n: usize,
    round: usize,
    us: &[Scalar],
    uis: &[Scalar],
    h_side: bool,
    hi_half: bool,
    pair: &[Scalar],
) -> Vec<Scalar> {
    let len = n >> round;
    let m = len / 2;
    let slot_base = if hi_half { m } else { 0 };
    let mut sc = vec![Scalar::ZERO; n];
    for j in 0..n {
        let slot = j & (len - 1);
        let in_hi = slot >= m;
        if in_hi != hi_half {
            continue;
        }
        sc[j] = pair[slot - slot_base] * coef_so_far(j, n, us, uis, h_side);
    }
    sc
}

/// `P = <a, G> + <b, H>`, `c = <a, b>`. `n` is a power of two.
pub fn ipa_prove(
    a0: &[Scalar],
    b0: &[Scalar],
    g0: &[Point],
    h0: &[Point],
    q: &Point,
    c: &Scalar,
    p: &Point,
) -> Option<IpaProof> {
    let n = a0.len();
    if n == 0 || !n.is_power_of_two() || b0.len() != n || g0.len() != n || h0.len() != n {
        return None;
    }
    let mut a = a0.to_vec();
    let mut b = b0.to_vec();
    let mut fs = Fs::new(b"ipa-v1");
    fs.point(&enc(p));
    fs.scalar(c);
    fs.point(&enc(q));
    let rounds = n.trailing_zeros() as usize;
    let mut l_b = Vec::with_capacity(rounds);
    let mut r_b = Vec::with_capacity(rounds);
    let mut us = Vec::with_capacity(rounds);
    let mut uis = Vec::with_capacity(rounds);
    for round in 0..rounds {
        let m = a.len() / 2;
        let mut c_l = Scalar::ZERO;
        let mut c_r = Scalar::ZERO;
        for i in 0..m {
            c_l += a[i] * b[m + i];
            c_r += a[m + i] * b[i];
        }
        let a_lo = a[..m].to_vec();
        let a_hi = a[m..].to_vec();
        let b_lo = b[..m].to_vec();
        let b_hi = b[m..].to_vec();
        // Logical generators stay linear combinations of the original points.
        // L and R are multiscalar products, so the fold does not scalar-multiply
        // each generator on its own.
        let g_l = expand_half(n, round, &us, &uis, false, true, &a_lo);
        let h_l = expand_half(n, round, &us, &uis, true, false, &b_hi);
        let g_r = expand_half(n, round, &us, &uis, false, false, &a_hi);
        let h_r = expand_half(n, round, &us, &uis, true, true, &b_lo);
        let l_pt = msm(&g_l, g0) + msm(&h_l, h0) + *q * c_l;
        let r_pt = msm(&g_r, g0) + msm(&h_r, h0) + *q * c_r;
        let lb = enc(&l_pt);
        let rb = enc(&r_pt);
        fs.point(&lb);
        fs.point(&rb);
        let u = fs.chal()?;
        let ui = Option::<Scalar>::from(u.invert())?;
        let mut a2 = Vec::with_capacity(m);
        let mut b2 = Vec::with_capacity(m);
        for i in 0..m {
            a2.push(a_lo[i] * u + a_hi[i] * ui);
            b2.push(b_lo[i] * ui + b_hi[i] * u);
        }
        a = a2;
        b = b2;
        us.push(u);
        uis.push(ui);
        l_b.push(lb);
        r_b.push(rb);
    }
    Some(IpaProof {
        l: l_b,
        r: r_b,
        a: sc_bytes(&a[0]),
        b: sc_bytes(&b[0]),
    })
}

pub fn ipa_verify(
    proof: &IpaProof,
    p: &Point,
    c: &Scalar,
    g0: &[Point],
    h0: &[Point],
    q: &Point,
) -> bool {
    let n = g0.len();
    if n == 0 || !n.is_power_of_two() || h0.len() != n {
        return false;
    }
    let rounds = n.trailing_zeros() as usize;
    if proof.l.len() != rounds || proof.r.len() != rounds {
        return false;
    }
    let a_f = match sc_in(&proof.a) {
        Some(s) => s,
        None => return false,
    };
    let b_f = match sc_in(&proof.b) {
        Some(s) => s,
        None => return false,
    };
    let mut fs = Fs::new(b"ipa-v1");
    fs.point(&enc(p));
    fs.scalar(c);
    fs.point(&enc(q));
    let mut acc = *p + *q * c;
    let mut us = Vec::with_capacity(rounds);
    let mut uis = Vec::with_capacity(rounds);
    for i in 0..rounds {
        let l_pt = match dec(&proof.l[i]) {
            Some(p) => p,
            None => return false,
        };
        let r_pt = match dec(&proof.r[i]) {
            Some(p) => p,
            None => return false,
        };
        fs.point(&proof.l[i]);
        fs.point(&proof.r[i]);
        let u = match fs.chal() {
            Some(s) => s,
            None => return false,
        };
        let ui = match Option::<Scalar>::from(u.invert()) {
            Some(s) => s,
            None => return false,
        };
        let u2 = u * u;
        let ui2 = ui * ui;
        acc = l_pt * u2 + acc + r_pt * ui2;
        us.push(u);
        uis.push(ui);
    }
    let mut cg = Vec::with_capacity(n);
    let mut ch = Vec::with_capacity(n);
    for i in 0..n {
        cg.push(ipa_coef(i, &us, &uis, false) * a_f);
        ch.push(ipa_coef(i, &us, &uis, true) * b_f);
    }
    let folded = msm(&cg, g0) + msm(&ch, h0) + *q * (a_f * b_f);
    acc == folded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gens(n: usize) -> (Vec<Point>, Vec<Point>, Point) {
        let g = (0..n as u64).map(|i| hash_to_vesta(i, b"ipa-test-G")).collect();
        let h = (0..n as u64).map(|i| hash_to_vesta(i, b"ipa-test-H")).collect();
        let q = hash_to_vesta(0, b"ipa-test-Q");
        (g, h, q)
    }

    #[test]
    fn ipa_n4_accepts_honest_and_rejects_a_wrong_product() {
        let n = 4usize;
        let a: Vec<Scalar> = (1..=4).map(|k| Scalar::from(k as u64)).collect();
        let b: Vec<Scalar> = (1..=4).map(|k| Scalar::from((5 - k) as u64)).collect();
        let mut c = Scalar::ZERO;
        for i in 0..n {
            c += a[i] * b[i];
        }
        let (g, h, q) = gens(n);
        let p = msm(&a, &g) + msm(&b, &h);
        let proof = ipa_prove(&a, &b, &g, &h, &q, &c, &p).expect("ipa");
        assert!(ipa_verify(&proof, &p, &c, &g, &h, &q), "honest n=4");
        let wrong = c + Scalar::ONE;
        assert!(!ipa_verify(&proof, &p, &wrong, &g, &h, &q), "c+1 must fail");
        let mut forged = proof.clone();
        let bump = enc(&(dec(&forged.l[0]).unwrap() + g[0]));
        forged.l[0] = bump;
        assert!(!ipa_verify(&forged, &p, &c, &g, &h, &q), "moved L must fail");
    }

    #[test]
    fn msm_pippenger_matches_one_scalar_at_a_time() {
        let n = 64usize;
        let mut scalars = Vec::with_capacity(n);
        let mut points = Vec::with_capacity(n);
        for i in 0..n as u64 {
            scalars.push(Scalar::from(i.wrapping_mul(0x9e37) + 3));
            points.push(hash_to_vesta(i, b"ipa-msm-p"));
        }
        let naive = msm_naive(&scalars, &points);
        assert_eq!(msm_pippenger(&scalars, &points, 4), naive);
        assert_eq!(msm_pippenger(&scalars, &points, 8), naive);
        assert_eq!(msm(&scalars, &points), naive);
        let (g, h, q) = gens(n);
        let a = scalars.clone();
        let b: Vec<Scalar> = (0..n as u64).map(|i| Scalar::from(i + 11)).collect();
        let mut c = Scalar::ZERO;
        for i in 0..n {
            c += a[i] * b[i];
        }
        let p = msm(&a, &g) + msm(&b, &h);
        let proof = ipa_prove(&a, &b, &g, &h, &q, &c, &p).expect("ipa64");
        assert!(ipa_verify(&proof, &p, &c, &g, &h, &q), "honest n=64");
        assert!(!ipa_verify(&proof, &p, &(c + Scalar::ONE), &g, &h, &q));
    }
}
