//! One-phase Bulletproofs R1CS on Vesta.
//! Multiplication gates are `aL[i] * aR[i] = aO[i]`.
//! A linear constraint sums to zero. `Wire::One` is the constant 1.
//! Committed wires are Pedersen `V = v B + r B~`. The prover sends `V`, not `v`.

use crate::ipa::{hash_to_vesta, ipa_prove, ipa_verify, msm, IpaProof};
use crate::leaf::sha512_64;
use ff::{Field, FromUniformBytes, PrimeField};
use group::{Group, GroupEncoding};
use pasta_curves::vesta;
use rand_core::{OsRng, RngCore};
use std::sync::Arc;

/// Slot-link IPA is 2^16. Encode IPA is 2^20. Both are one committed wire.
pub(crate) const SLOT_IPA_ROUNDS: usize = 16;
pub(crate) const ENCODE_IPA_ROUNDS: usize = 20;
pub(crate) const HIDE_IPA_ROUNDS: usize = 23;

pub(crate) const fn r1cs_blob_len(rounds: usize) -> usize {
    12 * 32 + rounds * 64 + 64
}

pub(crate) const SLOT_LINK_BLOB: usize = r1cs_blob_len(SLOT_IPA_ROUNDS);
pub(crate) const ENCODE_LINK_BLOB: usize = r1cs_blob_len(ENCODE_IPA_ROUNDS);
pub const HIDE_BLOB_LEN: usize = r1cs_blob_len(HIDE_IPA_ROUNDS);

const _: () = assert!(SLOT_LINK_BLOB == 1472);
const _: () = assert!(ENCODE_LINK_BLOB == 1728);

type Scalar = vesta::Scalar;
type Point = vesta::Point;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wire {
    L(usize),
    R(usize),
    O(usize),
    One,
    V(usize),
}

#[derive(Clone, Debug)]
pub struct R1csProof {
    pub a_i: [u8; 32],
    pub a_o: [u8; 32],
    pub s: [u8; 32],
    pub t1: [u8; 32],
    pub t3: [u8; 32],
    pub t4: [u8; 32],
    pub t5: [u8; 32],
    pub t6: [u8; 32],
    pub t_x: [u8; 32],
    pub t_x_blind: [u8; 32],
    pub e_blind: [u8; 32],
    pub v: Vec<[u8; 32]>,
    pub ipa: IpaProof,
}

#[derive(Clone)]
struct Bases {
    g: Vec<Point>,
    h: Vec<Point>,
    b: Point,
    blind: Point,
    q: Point,
}

fn par_hash_to_vesta(n: usize, dst: &'static [u8]) -> Vec<Point> {
    let mut out = vec![Point::identity(); n];
    if n == 0 {
        return out;
    }
    let threads = if n >= 64 { 4.min(n) } else { 1 };
    if threads == 1 {
        for i in 0..n {
            out[i] = hash_to_vesta(i as u64, dst);
        }
        return out;
    }
    let chunk = (n + threads - 1) / threads;
    std::thread::scope(|scope| {
        for (t, slot) in out.chunks_mut(chunk).enumerate() {
            let start = t * chunk;
            scope.spawn(move || {
                for (i, point) in slot.iter_mut().enumerate() {
                    *point = hash_to_vesta((start + i) as u64, dst);
                }
            });
        }
    });
    out
}

fn bases_fresh(n: usize) -> Bases {
    Bases {
        g: par_hash_to_vesta(n, b"shear-admit-v3-r1cs-G"),
        h: par_hash_to_vesta(n, b"shear-admit-v3-r1cs-H"),
        b: hash_to_vesta(0, b"shear-admit-v3-r1cs-B"),
        blind: hash_to_vesta(0, b"shear-admit-v3-r1cs-Bblind"),
        q: hash_to_vesta(0, b"shear-admit-v3-r1cs-Q"),
    }
}

fn bases(n: usize) -> Arc<Bases> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<usize, Arc<Bases>>>> = OnceLock::new();
    let map = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().expect("r1cs bases");
    if let Some(hit) = guard.get(&n) {
        return Arc::clone(hit);
    }
    let built = Arc::new(bases_fresh(n));
    guard.insert(n, Arc::clone(&built));
    built
}

fn scale_points(points: &[Point], scalars: &[Scalar]) -> Vec<Point> {
    let n = points.len().min(scalars.len());
    let mut out = vec![Point::identity(); n];
    if n == 0 {
        return out;
    }
    let threads = if n >= 64 { 4.min(n) } else { 1 };
    if threads == 1 {
        for i in 0..n {
            out[i] = points[i] * scalars[i];
        }
        return out;
    }
    let chunk = (n + threads - 1) / threads;
    std::thread::scope(|scope| {
        for (t, slot) in out.chunks_mut(chunk).enumerate() {
            let start = t * chunk;
            let pts = &points[start..start + slot.len()];
            let scs = &scalars[start..start + slot.len()];
            scope.spawn(move || {
                for i in 0..slot.len() {
                    slot[i] = pts[i] * scs[i];
                }
            });
        }
    });
    out
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

fn rand_sc() -> Scalar {
    let mut w = [0u8; 64];
    OsRng.fill_bytes(&mut w);
    Scalar::from_uniform_bytes(&w)
}

fn dot(a: &[Scalar], b: &[Scalar]) -> Scalar {
    let mut s = Scalar::ZERO;
    for i in 0..a.len() {
        s += a[i] * b[i];
    }
    s
}

struct Fs {
    st: Vec<u8>,
}

impl Fs {
    fn new() -> Self {
        Self { st: b"r1cs-v1".to_vec() }
    }
    fn bytes(&mut self, b: &[u8]) {
        self.st.extend_from_slice(b);
    }
    fn point(&mut self, p: &[u8; 32]) {
        self.st.extend_from_slice(p);
    }
    fn chal(&mut self) -> Option<Scalar> {
        let d = sha512_64(&[b"shear-admit-v3-r1cs", &self.st]);
        self.st.extend_from_slice(&d);
        let s = Scalar::from_uniform_bytes(&d);
        if bool::from(s.is_zero()) {
            None
        } else {
            Some(s)
        }
    }
}

fn absorb_constraints(fs: &mut Fs, n: usize, cons: &[Vec<(Wire, Scalar)>]) {
    fs.bytes(&(n as u32).to_le_bytes());
    fs.bytes(&(cons.len() as u32).to_le_bytes());
    for c in cons {
        fs.bytes(&(c.len() as u32).to_le_bytes());
        for (w, coeff) in c {
            let (tag, idx) = match *w {
                Wire::L(i) => (1u8, i as u32),
                Wire::R(i) => (2u8, i as u32),
                Wire::O(i) => (3u8, i as u32),
                Wire::One => (4u8, 0u32),
                Wire::V(i) => (5u8, i as u32),
            };
            fs.bytes(&[tag]);
            fs.bytes(&idx.to_le_bytes());
            fs.bytes(&sc_bytes(coeff));
        }
    }
}

struct Flat {
    w_l: Vec<Scalar>,
    w_r: Vec<Scalar>,
    w_o: Vec<Scalar>,
    w_v: Vec<Scalar>,
    wc: Scalar,
}

fn flatten(n: usize, n_v: usize, cons: &[Vec<(Wire, Scalar)>], z: &Scalar) -> Option<Flat> {
    let mut w_l = vec![Scalar::ZERO; n];
    let mut w_r = vec![Scalar::ZERO; n];
    let mut w_o = vec![Scalar::ZERO; n];
    let mut w_v = vec![Scalar::ZERO; n_v];
    let mut wc = Scalar::ZERO;
    let mut exp_z = *z;
    for c in cons {
        for (w, coeff) in c {
            match *w {
                Wire::L(i) => {
                    if i >= n {
                        return None;
                    }
                    w_l[i] += exp_z * coeff;
                }
                Wire::R(i) => {
                    if i >= n {
                        return None;
                    }
                    w_r[i] += exp_z * coeff;
                }
                Wire::O(i) => {
                    if i >= n {
                        return None;
                    }
                    w_o[i] += exp_z * coeff;
                }
                Wire::V(i) => {
                    if i >= n_v {
                        return None;
                    }
                    w_v[i] -= exp_z * coeff;
                }
                Wire::One => wc -= exp_z * coeff,
            }
        }
        exp_z *= z;
    }
    Some(Flat { w_l, w_r, w_o, w_v, wc })
}

fn powers(y: &Scalar, n: usize) -> (Vec<Scalar>, Vec<Scalar>) {
    let yinv = Option::<Scalar>::from(y.invert()).unwrap_or(Scalar::ZERO);
    let mut yp = Vec::with_capacity(n);
    let mut yi = Vec::with_capacity(n);
    let mut a = Scalar::ONE;
    let mut b = Scalar::ONE;
    for _ in 0..n {
        yp.push(a);
        yi.push(b);
        a *= y;
        b *= yinv;
    }
    (yp, yi)
}

/// Build `P = <l, G> + <r, H'>` from the public commitments.
fn opened_p(
    ai: &Point,
    ao: &Point,
    s: &Point,
    e_blind: &Scalar,
    x: &Scalar,
    flat: &Flat,
    yinv: &[Scalar],
    g: &[Point],
    h: &[Point],
    b_blind: &Point,
    n: usize,
    padded: usize,
) -> Point {
    let x2 = *x * x;
    let x3 = x2 * x;
    // Coefficient of g[i] is x * y^{-i} * w_r. Coefficient of h[i] is
    // y^{-i} * (x * w_l + w_o) - 1, and the pad slots are only -1.
    let mut g_sc = Vec::with_capacity(n);
    let mut h_sc = Vec::with_capacity(padded);
    for i in 0..n {
        g_sc.push(*x * yinv[i] * flat.w_r[i]);
        h_sc.push(yinv[i] * (*x * flat.w_l[i] + flat.w_o[i]) - Scalar::ONE);
    }
    for _ in n..padded {
        h_sc.push(Scalar::ZERO - Scalar::ONE);
    }
    let mut p = *ai * x + *ao * x2 + *s * x3 - *b_blind * e_blind;
    if n > 0 {
        p += msm(&g_sc, &g[..n]);
    }
    p + msm(&h_sc, &h[..padded])
}

pub fn r1cs_prove(
    a_l: &[Scalar],
    a_r: &[Scalar],
    a_o: &[Scalar],
    cons: &[Vec<(Wire, Scalar)>],
    committed: &[(Scalar, Scalar)],
) -> Option<R1csProof> {
    let n = a_l.len();
    if n == 0 || a_r.len() != n || a_o.len() != n {
        return None;
    }
    let padded = n.next_power_of_two();
    let gen = bases(padded);
    let mut v_pts = Vec::with_capacity(committed.len());
    let mut v_bytes = Vec::with_capacity(committed.len());
    for (v, r) in committed {
        let pt = gen.b * v + gen.blind * r;
        v_bytes.push(enc(&pt));
        v_pts.push(pt);
    }
    let i_b = rand_sc();
    let o_b = rand_sc();
    let s_b = rand_sc();
    let s_l: Vec<Scalar> = (0..n).map(|_| rand_sc()).collect();
    let s_r: Vec<Scalar> = (0..n).map(|_| rand_sc()).collect();
    let g = &gen.g[..n];
    let h = &gen.h[..n];
    let ai = gen.blind * i_b + msm(a_l, g) + msm(a_r, h);
    let ao = gen.blind * o_b + msm(a_o, g);
    let s_pt = gen.blind * s_b + msm(&s_l, g) + msm(&s_r, h);
    let ai_b = enc(&ai);
    let ao_b = enc(&ao);
    let s_b_pt = enc(&s_pt);
    let mut fs = Fs::new();
    absorb_constraints(&mut fs, n, cons);
    for vb in &v_bytes {
        fs.point(vb);
    }
    fs.point(&ai_b);
    fs.point(&ao_b);
    fs.point(&s_b_pt);
    let y = fs.chal()?;
    let z = fs.chal()?;
    let flat = flatten(n, committed.len(), cons, &z)?;
    let (yp, yi) = powers(&y, padded);
    if bool::from(yi[0].is_zero()) {
        return None;
    }
    let mut l1 = vec![Scalar::ZERO; n];
    let mut l2 = vec![Scalar::ZERO; n];
    let mut l3 = vec![Scalar::ZERO; n];
    let mut r0 = vec![Scalar::ZERO; n];
    let mut r1 = vec![Scalar::ZERO; n];
    let mut r3 = vec![Scalar::ZERO; n];
    for i in 0..n {
        l1[i] = a_l[i] + yi[i] * flat.w_r[i];
        l2[i] = a_o[i];
        l3[i] = s_l[i];
        r0[i] = flat.w_o[i] - yp[i];
        r1[i] = yp[i] * a_r[i] + flat.w_l[i];
        r3[i] = yp[i] * s_r[i];
    }
    let mut t = [Scalar::ZERO; 7];
    t[1] = dot(&l1, &r0);
    t[2] = dot(&l1, &r1) + dot(&l2, &r0);
    t[3] = dot(&l2, &r1) + dot(&l3, &r0);
    t[4] = dot(&l1, &r3) + dot(&l3, &r1);
    t[5] = dot(&l2, &r3);
    t[6] = dot(&l3, &r3);
    let tau = [rand_sc(), rand_sc(), rand_sc(), rand_sc(), rand_sc()];
    // tau order: t1, t3, t4, t5, t6
    let t_pts = [
        gen.b * t[1] + gen.blind * tau[0],
        gen.b * t[3] + gen.blind * tau[1],
        gen.b * t[4] + gen.blind * tau[2],
        gen.b * t[5] + gen.blind * tau[3],
        gen.b * t[6] + gen.blind * tau[4],
    ];
    let t_b = [enc(&t_pts[0]), enc(&t_pts[1]), enc(&t_pts[2]), enc(&t_pts[3]), enc(&t_pts[4])];
    for tb in &t_b {
        fs.point(tb);
    }
    let x = fs.chal()?;
    let mut t2_blind = Scalar::ZERO;
    for i in 0..committed.len() {
        t2_blind += flat.w_v[i] * committed[i].1;
    }
    let x2 = x * x;
    let x3 = x2 * x;
    let x4 = x2 * x2;
    let x5 = x4 * x;
    let x6 = x4 * x2;
    let t_x = t[1] * x + t[2] * x2 + t[3] * x3 + t[4] * x4 + t[5] * x5 + t[6] * x6;
    let t_x_blind = tau[0] * x + t2_blind * x2 + tau[1] * x3 + tau[2] * x4 + tau[3] * x5 + tau[4] * x6;
    let e_blind = i_b * x + o_b * x2 + s_b * x3;
    let mut l_vec = Vec::with_capacity(padded);
    let mut r_vec = Vec::with_capacity(padded);
    for i in 0..n {
        l_vec.push(l1[i] * x + l2[i] * x2 + l3[i] * x3);
        r_vec.push(r0[i] + r1[i] * x + r3[i] * x3);
    }
    // yp[n - 1] = y^{n-1}. The pad slots start at y^n.
    let mut y_i = yp[n - 1] * y;
    for _ in n..padded {
        l_vec.push(Scalar::ZERO);
        r_vec.push(Scalar::ZERO - y_i);
        y_i *= y;
    }
    let h_scaled = scale_points(&gen.h[..padded], &yi[..padded]);
    let p_open = opened_p(&ai, &ao, &s_pt, &e_blind, &x, &flat, &yi, &gen.g, &gen.h, &gen.blind, n, padded);
    let ipa = ipa_prove(&l_vec, &r_vec, &gen.g, &h_scaled, &gen.q, &t_x, &p_open)?;
    let _ = v_pts;
    Some(R1csProof {
        a_i: ai_b,
        a_o: ao_b,
        s: s_b_pt,
        t1: t_b[0],
        t3: t_b[1],
        t4: t_b[2],
        t5: t_b[3],
        t6: t_b[4],
        t_x: sc_bytes(&t_x),
        t_x_blind: sc_bytes(&t_x_blind),
        e_blind: sc_bytes(&e_blind),
        v: v_bytes,
        ipa,
    })
}

fn take_arr(bytes: &[u8], off: &mut usize) -> Option<[u8; 32]> {
    let end = off.checked_add(32)?;
    let s = bytes.get(*off..end)?;
    *off = end;
    let mut a = [0u8; 32];
    a.copy_from_slice(s);
    Some(a)
}

pub(crate) fn r1cs_write(proof: &R1csProof, rounds: usize) -> Option<Vec<u8>> {
    if proof.v.len() != 1 || proof.ipa.l.len() != rounds || proof.ipa.r.len() != rounds {
        return None;
    }
    let mut out = Vec::with_capacity(r1cs_blob_len(rounds));
    for part in [
        proof.a_i, proof.a_o, proof.s, proof.t1, proof.t3, proof.t4, proof.t5, proof.t6, proof.t_x,
        proof.t_x_blind, proof.e_blind, proof.v[0],
    ] {
        out.extend_from_slice(&part);
    }
    for part in proof.ipa.l.iter().chain(proof.ipa.r.iter()) {
        out.extend_from_slice(part);
    }
    out.extend_from_slice(&proof.ipa.a);
    out.extend_from_slice(&proof.ipa.b);
    if out.len() != r1cs_blob_len(rounds) {
        return None;
    }
    Some(out)
}

pub(crate) fn r1cs_read(bytes: &[u8], rounds: usize) -> Option<R1csProof> {
    if bytes.len() != r1cs_blob_len(rounds) {
        return None;
    }
    let mut off = 0usize;
    let a_i = take_arr(bytes, &mut off)?;
    let a_o = take_arr(bytes, &mut off)?;
    let s = take_arr(bytes, &mut off)?;
    let t1 = take_arr(bytes, &mut off)?;
    let t3 = take_arr(bytes, &mut off)?;
    let t4 = take_arr(bytes, &mut off)?;
    let t5 = take_arr(bytes, &mut off)?;
    let t6 = take_arr(bytes, &mut off)?;
    let t_x = take_arr(bytes, &mut off)?;
    let t_x_blind = take_arr(bytes, &mut off)?;
    let e_blind = take_arr(bytes, &mut off)?;
    let v0 = take_arr(bytes, &mut off)?;
    let mut l = Vec::with_capacity(rounds);
    let mut r = Vec::with_capacity(rounds);
    for _ in 0..rounds {
        l.push(take_arr(bytes, &mut off)?);
    }
    for _ in 0..rounds {
        r.push(take_arr(bytes, &mut off)?);
    }
    let a = take_arr(bytes, &mut off)?;
    let b = take_arr(bytes, &mut off)?;
    if off != bytes.len() {
        return None;
    }
    Some(R1csProof {
        a_i,
        a_o,
        s,
        t1,
        t3,
        t4,
        t5,
        t6,
        t_x,
        t_x_blind,
        e_blind,
        v: vec![v0],
        ipa: IpaProof { l, r, a, b },
    })
}

pub fn r1cs_verify(proof: &R1csProof, n: usize, cons: &[Vec<(Wire, Scalar)>]) -> bool {
    if n == 0 {
        return false;
    }
    let padded = n.next_power_of_two();
    let gen = bases(padded);
    let ai = match dec(&proof.a_i) {
        Some(p) => p,
        None => return false,
    };
    let ao = match dec(&proof.a_o) {
        Some(p) => p,
        None => return false,
    };
    let s_pt = match dec(&proof.s) {
        Some(p) => p,
        None => return false,
    };
    let t_pts_b = [proof.t1, proof.t3, proof.t4, proof.t5, proof.t6];
    let mut t_pts = [Point::identity(); 5];
    for i in 0..5 {
        t_pts[i] = match dec(&t_pts_b[i]) {
            Some(p) => p,
            None => return false,
        };
    }
    let t_x = match sc_in(&proof.t_x) {
        Some(s) => s,
        None => return false,
    };
    let t_x_blind = match sc_in(&proof.t_x_blind) {
        Some(s) => s,
        None => return false,
    };
    let e_blind = match sc_in(&proof.e_blind) {
        Some(s) => s,
        None => return false,
    };
    let mut v_pts = Vec::with_capacity(proof.v.len());
    for vb in &proof.v {
        match dec(vb) {
            Some(p) => v_pts.push(p),
            None => return false,
        }
    }
    let mut fs = Fs::new();
    absorb_constraints(&mut fs, n, cons);
    for vb in &proof.v {
        fs.point(vb);
    }
    fs.point(&proof.a_i);
    fs.point(&proof.a_o);
    fs.point(&proof.s);
    let y = match fs.chal() {
        Some(s) => s,
        None => return false,
    };
    let z = match fs.chal() {
        Some(s) => s,
        None => return false,
    };
    let flat = match flatten(n, proof.v.len(), cons, &z) {
        Some(f) => f,
        None => return false,
    };
    for tb in &t_pts_b {
        fs.point(tb);
    }
    let x = match fs.chal() {
        Some(s) => s,
        None => return false,
    };
    let (yp, yi) = powers(&y, padded);
    if yp.len() != padded || bool::from(yi[0].is_zero()) {
        return false;
    }
    let mut delta = Scalar::ZERO;
    for i in 0..n {
        delta += yi[i] * flat.w_r[i] * flat.w_l[i];
    }
    let x2 = x * x;
    let x3 = x2 * x;
    let x4 = x2 * x2;
    let x5 = x4 * x;
    let x6 = x4 * x2;
    let mut rhs = gen.b * (x2 * (flat.wc + delta));
    for i in 0..v_pts.len() {
        rhs += v_pts[i] * (x2 * flat.w_v[i]);
    }
    let t_sc = [x, x3, x4, x5, x6];
    for i in 0..5 {
        rhs += t_pts[i] * t_sc[i];
    }
    let lhs = gen.b * t_x + gen.blind * t_x_blind;
    if lhs != rhs {
        return false;
    }
    let p_open = opened_p(&ai, &ao, &s_pt, &e_blind, &x, &flat, &yi, &gen.g, &gen.h, &gen.blind, n, padded);
    let h_scaled = scale_points(&gen.h[..padded], &yi[..padded]);
    ipa_verify(&proof.ipa, &p_open, &t_x, &gen.g, &h_scaled, &gen.q)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sc(k: u64) -> Scalar {
        Scalar::from(k)
    }

    fn product_statement(product: u64) -> Vec<Vec<(Wire, Scalar)>> {
        vec![
            vec![(Wire::L(0), Scalar::ONE), (Wire::One, Scalar::ZERO - sc(2))],
            vec![(Wire::R(0), Scalar::ONE), (Wire::One, Scalar::ZERO - sc(3))],
            vec![(Wire::O(0), Scalar::ONE), (Wire::One, Scalar::ZERO - sc(product))],
        ]
    }

    #[test]
    fn r1cs_mul_two_times_three_is_six() {
        let a_l = [sc(2)];
        let a_r = [sc(3)];
        let a_o = [sc(6)];
        let cons = product_statement(6);
        let proof = r1cs_prove(&a_l, &a_r, &a_o, &cons, &[]).expect("prove 6");
        assert!(r1cs_verify(&proof, 1, &cons), "2*3=6");
        let other = product_statement(7);
        assert!(!r1cs_verify(&proof, 1, &other), "a proof of 6 is not a proof of 7");
    }

    #[test]
    fn r1cs_committed_wire_binds_the_value() {
        let five = sc(5);
        let a_l = [five];
        let a_r = [Scalar::ONE];
        let a_o = [five];
        let cons = vec![
            vec![(Wire::L(0), Scalar::ONE), (Wire::V(0), Scalar::ZERO - Scalar::ONE)],
            vec![(Wire::R(0), Scalar::ONE), (Wire::One, Scalar::ZERO - Scalar::ONE)],
            vec![(Wire::O(0), Scalar::ONE), (Wire::L(0), Scalar::ZERO - Scalar::ONE)],
        ];
        let blind = sc(9);
        let proof = r1cs_prove(&a_l, &a_r, &a_o, &cons, &[(five, blind)]).expect("commit 5");
        assert!(r1cs_verify(&proof, 1, &cons), "committed wire opens to the witness");
        let blob = r1cs_write(&proof, 0).expect("codec");
        let back = r1cs_read(&blob, 0).expect("read");
        assert!(r1cs_verify(&back, 1, &cons), "round-trip");
        assert!(r1cs_read(&blob, 1).is_none(), "round count is part of the blob");
        let other = r1cs_prove(&a_l, &a_r, &a_o, &cons, &[(sc(6), blind)]).expect("commit 6");
        assert!(!r1cs_verify(&other, 1, &cons), "a different committed value must fail");
    }

    #[test]
    fn r1cs_mul_two_times_three_is_not_seven() {
        let a_l = [sc(2)];
        let a_r = [sc(3)];
        let a_o = [sc(7)];
        let cons = product_statement(7);
        let proof = r1cs_prove(&a_l, &a_r, &a_o, &cons, &[]).expect("transcript of a false product");
        assert!(!r1cs_verify(&proof, 1, &cons), "2*3=7 must fail");
    }
}
