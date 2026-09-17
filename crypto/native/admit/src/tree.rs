//! D-ary Pedersen vector-commitment trees on the Pasta 2-cycle (dest leaves)
//! and a ristretto select-and-rerandomize tree (C leaves).
//!
//! Parent of Fp children is a Vesta Pedersen (Vesta scalar = Pallas base).
//! Internal Vesta-point x-coords (Fq) are committed on Pallas.

use crate::leaf::{dest_leaf_fp, jroot_hash, sha512_64};
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar as RScalar;
use ff::{FromUniformBytes, PrimeField};
use group::{Group, GroupEncoding};
use pasta_curves::{pallas, vesta};

pub const ARITY: usize = 32;
pub const HEIGHT_MAX: usize = 6;
pub const K_REF: u32 = 1;

fn gen_vesta(i: u64, dst: &[u8]) -> vesta::Point {
    let mut w = sha512_64(&[dst, &i.to_le_bytes()]);
    // hash-to-curve via from_bytes loop
    for ctr in 0u8..=255 {
        w[63] = ctr;
        let mut repr = [0u8; 32];
        repr.copy_from_slice(&w[..32]);
        if let Some(p) = Option::<vesta::Point>::from(vesta::Point::from_bytes(&repr.into())) {
            if !bool::from(p.is_identity()) {
                return p;
            }
        }
    }
    vesta::Point::generator() * vesta::Scalar::from(i + 1)
}

fn gen_pallas(i: u64, dst: &[u8]) -> pallas::Point {
    let mut w = sha512_64(&[dst, &i.to_le_bytes()]);
    for ctr in 0u8..=255 {
        w[63] = ctr;
        let mut repr = [0u8; 32];
        repr.copy_from_slice(&w[..32]);
        if let Some(p) = Option::<pallas::Point>::from(pallas::Point::from_bytes(&repr.into())) {
            if !bool::from(p.is_identity()) {
                return p;
            }
        }
    }
    pallas::Point::generator() * pallas::Scalar::from(i + 1)
}

fn gen_ristretto(i: u64, dst: &[u8]) -> RistrettoPoint {
    let mut w = sha512_64(&[dst, &i.to_le_bytes()]);
    w[0] ^= i as u8;
    RistrettoPoint::from_uniform_bytes(&w)
}

use std::sync::OnceLock;

pub(crate) fn vesta_gens() -> &'static (vesta::Point, Vec<vesta::Point>) {
    static G: OnceLock<(vesta::Point, Vec<vesta::Point>)> = OnceLock::new();
    G.get_or_init(|| {
        let u = gen_vesta(0, b"shear-ct-vesta-U");
        let g: Vec<_> = (0..ARITY as u64)
            .map(|i| gen_vesta(i + 1, b"shear-ct-vesta-G"))
            .collect();
        (u, g)
    })
}

fn pallas_gens() -> &'static (pallas::Point, Vec<pallas::Point>) {
    static G: OnceLock<(pallas::Point, Vec<pallas::Point>)> = OnceLock::new();
    G.get_or_init(|| {
        let u = gen_pallas(0, b"shear-ct-pallas-U");
        let g: Vec<_> = (0..ARITY as u64)
            .map(|i| gen_pallas(i + 1, b"shear-ct-pallas-G"))
            .collect();
        (u, g)
    })
}

pub(crate) fn ristretto_gens() -> &'static (RistrettoPoint, Vec<RistrettoPoint>, RistrettoPoint) {
    static G: OnceLock<(RistrettoPoint, Vec<RistrettoPoint>, RistrettoPoint)> = OnceLock::new();
    G.get_or_init(|| {
        let u = gen_ristretto(0, b"shear-ct-ristretto-U");
        let g: Vec<_> = (0..ARITY as u64)
            .map(|i| gen_ristretto(i + 1, b"shear-ct-ristretto-G"))
            .collect();
        let h = crate::bpplus::h_note();
        (u, g, h)
    })
}

pub(crate) fn vesta_gsel() -> vesta::Point {
    gen_vesta(99, b"shear-ct-vesta-sel")
}

pub(crate) fn ristretto_gsel() -> RistrettoPoint {
    gen_ristretto(99, b"shear-ct-ristretto-sel")
}

pub(crate) fn blind_fp(xs: &[[u8; 32]]) -> vesta::Scalar {
    let mut parts: Vec<&[u8]> = vec![b"shear-ct-blind"];
    for x in xs {
        parts.push(x.as_ref());
    }
    let w = sha512_64(&parts);
    vesta::Scalar::from_uniform_bytes(&w)
}

/// Map a 32-byte child to a Vesta scalar. Canonical Fp encodings (dest leaves)
/// stay as-is; internal Vesta-point bytes that are not a field element reduce
/// via SHA-512 so every slot has a defined opening (matches CDS).
pub(crate) fn vesta_x(b: &[u8; 32]) -> vesta::Scalar {
    Option::<vesta::Scalar>::from(vesta::Scalar::from_repr((*b).into())).unwrap_or_else(|| {
        vesta::Scalar::from_uniform_bytes(&sha512_64(&[b"shear-ct-vesta-red", b]))
    })
}

pub(crate) fn commit_vesta(xs: &[[u8; 32]; ARITY]) -> [u8; 32] {
    let (u, g) = vesta_gens();
    let r = blind_fp(xs);
    let mut acc = *u * r;
    for i in 0..ARITY {
        acc += g[i] * vesta_x(&xs[i]);
    }
    let enc = acc.to_bytes();
    let mut o = [0u8; 32];
    o.copy_from_slice(enc.as_ref());
    o
}

fn take32(buf: &[u8], i: usize) -> [u8; 32] {
    let mut o = [0u8; 32];
    let start = i.saturating_mul(32);
    if buf.len() >= start + 32 {
        o.copy_from_slice(&buf[start..start + 32]);
    }
    o
}

/// Pad a level to a multiple of ARITY with identity children. Do not expand
/// to the next power of D (that made |J|=100k rebuild 1_048_576 dummy leaves).
fn pad_to_arity(level: &mut Vec<[u8; 32]>) {
    if level.is_empty() {
        level.push([0u8; 32]);
    }
    while level.len() % ARITY != 0 {
        level.push([0u8; 32]);
    }
}

fn height_of(n: usize) -> usize {
    if n <= 1 {
        return 1;
    }
    let mut h = 0usize;
    let mut w = 1usize;
    while w < n {
        w = w.saturating_mul(ARITY);
        h += 1;
        if h >= HEIGHT_MAX {
            break;
        }
    }
    h.max(1)
}

fn dest_leaf_level(dest_leaves: &[u8], n: usize) -> Vec<[u8; 32]> {
    let mut level: Vec<[u8; 32]> = Vec::with_capacity(n.max(ARITY));
    for i in 0..n {
        level.push(dest_leaf_fp(&take32(dest_leaves, i)));
    }
    if level.is_empty() {
        level.push([0u8; 32]);
    }
    pad_to_arity(&mut level);
    level
}

fn c_leaf_level(c_leaves: &[u8], n: usize) -> Vec<[u8; 32]> {
    let mut level: Vec<[u8; 32]> = Vec::with_capacity(n.max(ARITY));
    for i in 0..n {
        // C-tree leaves are the ristretto C encodings (not a hash of C).
        level.push(take32(c_leaves, i));
    }
    if level.is_empty() {
        level.push([0u8; 32]);
    }
    pad_to_arity(&mut level);
    level
}

fn fold_dest(level: &[[u8; 32]]) -> Vec<[u8; 32]> {
    let mut next = Vec::with_capacity(level.len() / ARITY + 1);
    for chunk in level.chunks(ARITY) {
        let mut xs = [[0u8; 32]; ARITY];
        for (i, c) in chunk.iter().enumerate() {
            xs[i] = *c;
        }
        next.push(commit_vesta(&xs));
    }
    next
}

fn fold_c(level: &[[u8; 32]]) -> Vec<[u8; 32]> {
    let mut next = Vec::with_capacity(level.len() / ARITY + 1);
    for chunk in level.chunks(ARITY) {
        let mut xs = [[0u8; 32]; ARITY];
        for (i, c) in chunk.iter().enumerate() {
            xs[i] = *c;
        }
        next.push(commit_ristretto_encodings(&xs));
    }
    next
}

/// Every D-ary level including the 1-element root. Built once per prove.
pub fn dest_levels(dest_leaves: &[u8], n: usize) -> Vec<Vec<[u8; 32]>> {
    let mut level = dest_leaf_level(dest_leaves, n);
    let mut levels = Vec::new();
    loop {
        if level.len() == 1 {
            levels.push(level);
            break;
        }
        let next = fold_dest(&level);
        levels.push(level);
        if next.len() == 1 {
            levels.push(next);
            break;
        }
        level = next;
        pad_to_arity(&mut level);
    }
    levels
}

pub fn c_levels(c_leaves: &[u8], n: usize) -> Vec<Vec<[u8; 32]>> {
    let mut level = c_leaf_level(c_leaves, n);
    let mut levels = Vec::new();
    loop {
        if level.len() == 1 {
            levels.push(level);
            break;
        }
        let next = fold_c(&level);
        levels.push(level);
        if next.len() == 1 {
            levels.push(next);
            break;
        }
        level = next;
        pad_to_arity(&mut level);
    }
    levels
}

pub fn path_from_levels(levels: &[Vec<[u8; 32]>], index: usize) -> Option<Vec<[[u8; 32]; ARITY]>> {
    if levels.is_empty() {
        return None;
    }
    let mut idx = index;
    let mut path = Vec::new();
    let last_is_root = levels.last().map(|l| l.len() == 1).unwrap_or(false);
    let n_path = if last_is_root {
        levels.len() - 1
    } else {
        levels.len()
    };
    for lvl in levels.iter().take(n_path) {
        if lvl.len() <= 1 {
            break;
        }
        let mut xs = [[0u8; 32]; ARITY];
        let start = (idx / ARITY) * ARITY;
        for i in 0..ARITY {
            if start + i < lvl.len() {
                xs[i] = lvl[start + i];
            }
        }
        path.push(xs);
        idx /= ARITY;
    }
    if path.is_empty() {
        return None;
    }
    Some(path)
}

pub fn root_of_levels(levels: &[Vec<[u8; 32]>]) -> [u8; 32] {
    levels
        .last()
        .and_then(|l| l.first().copied())
        .unwrap_or([0u8; 32])
}

pub fn dest_paths_and_root(
    dest_leaves: &[u8],
    n: usize,
    index: usize,
) -> Option<(Vec<[[u8; 32]; ARITY]>, [u8; 32])> {
    if n == 0 || index >= n {
        return None;
    }
    let levels = dest_levels(dest_leaves, n);
    let path = path_from_levels(&levels, index)?;
    Some((path, root_of_levels(&levels)))
}

pub fn c_paths_and_root(
    c_leaves: &[u8],
    n: usize,
    index: usize,
) -> Option<(Vec<[[u8; 32]; ARITY]>, [u8; 32])> {
    if n == 0 || index >= n {
        return None;
    }
    let levels = c_levels(c_leaves, n);
    let path = path_from_levels(&levels, index)?;
    Some((path, root_of_levels(&levels)))
}

/// Bottom-up D-ary fold of dest-leaf field elements → 32-byte Vesta/Pallas root encoding.
pub fn pasta_root(dest_leaves: &[u8], n: usize) -> [u8; 32] {
    root_of_levels(&dest_levels(dest_leaves, n))
}

pub(crate) fn commit_ristretto_encodings(cs: &[[u8; 32]; ARITY]) -> [u8; 32] {
    let (u, g, _) = ristretto_gens();
    let mut parts: Vec<&[u8]> = vec![b"shear-ct-c-blind"];
    for c in cs {
        parts.push(c.as_ref());
    }
    let w = sha512_64(&parts);
    let r = RScalar::from_bytes_mod_order_wide(&w);
    let mut acc = u * r;
    for i in 0..ARITY {
        let s = RScalar::from_bytes_mod_order(cs[i]);
        acc += g[i] * s;
    }
    acc.compress().to_bytes()
}

pub fn c_root(c_leaves: &[u8], n: usize) -> [u8; 32] {
    root_of_levels(&c_levels(c_leaves, n))
}

pub fn jroot(dest_leaves: &[u8], c_leaves: &[u8], n: usize) -> [u8; 32] {
    let p = pasta_root(dest_leaves, n);
    let c = c_root(c_leaves, n);
    jroot_hash(&p, &c)
}

pub struct PastaTree {
    pub leaves: Vec<[u8; 32]>,
}

impl PastaTree {
    pub fn new() -> Self {
        Self { leaves: Vec::new() }
    }
    pub fn append_p(&mut self, p: &[u8; 32]) {
        self.leaves.push(*p);
    }
    pub fn root(&self) -> [u8; 32] {
        let mut blob = Vec::with_capacity(self.leaves.len() * 32);
        for l in &self.leaves {
            blob.extend_from_slice(l);
        }
        pasta_root(&blob, self.leaves.len())
    }
}

pub struct CTree {
    pub leaves: Vec<[u8; 32]>,
}

impl CTree {
    pub fn new() -> Self {
        Self { leaves: Vec::new() }
    }
    pub fn append_c(&mut self, c: &[u8; 32]) {
        self.leaves.push(*c);
    }
    pub fn root(&self) -> [u8; 32] {
        let mut blob = Vec::with_capacity(self.leaves.len() * 32);
        for l in &self.leaves {
            blob.extend_from_slice(l);
        }
        c_root(&blob, self.leaves.len())
    }
}

/// Path of D-ary sibling vectors from leaf to root (prover-side).
pub fn dest_path(dest_leaves: &[u8], n: usize, index: usize) -> Option<Vec<[[u8; 32]; ARITY]>> {
    dest_paths_and_root(dest_leaves, n, index).map(|(p, _)| p)
}

pub fn c_path(c_leaves: &[u8], n: usize, index: usize) -> Option<Vec<[[u8; 32]; ARITY]>> {
    c_paths_and_root(c_leaves, n, index).map(|(p, _)| p)
}

pub fn note_h() -> RistrettoPoint {
    ristretto_gens().2
}

pub fn note_u() -> RistrettoPoint {
    ristretto_gens().0
}

pub fn ristretto_h_note() -> RistrettoPoint {
    crate::bpplus::h_note()
}

/// C̃ = C + t·H. Returns None if C does not decompress.
pub fn rerand_c(c: &[u8; 32], t: &[u8; 32]) -> Option<[u8; 32]> {
    let cp = CompressedRistretto(*c).decompress()?;
    let ts = RScalar::from_bytes_mod_order(*t);
    if ts == RScalar::ZERO {
        return None;
    }
    let h = ristretto_h_note();
    Some((cp + h * ts).compress().to_bytes())
}

pub fn height_for(n: usize) -> usize {
    height_of(n.max(1))
}

fn parse_path(raw: &[u8]) -> Option<Vec<[[u8; 32]; ARITY]>> {
    if raw.len() % (ARITY * 32) != 0 || raw.is_empty() {
        return None;
    }
    let mut path = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let mut xs = [[0u8; 32]; ARITY];
        for k in 0..ARITY {
            xs[k].copy_from_slice(&raw[i..i + 32]);
            i += 32;
        }
        path.push(xs);
    }
    Some(path)
}

fn fold_path(
    raw: &[u8],
    commit: fn(&[[u8; 32]; ARITY]) -> [u8; 32],
) -> Option<[u8; 32]> {
    fold_path_slots(raw, commit).map(|(root, _)| root)
}

/// Parent-in-child fold that also returns the unique child slot of each parent.
/// Ambiguous or missing slots fail — mixed dest/C indices cannot hide here.
fn fold_path_slots(
    raw: &[u8],
    commit: fn(&[[u8; 32]; ARITY]) -> [u8; 32],
) -> Option<([u8; 32], Vec<u8>)> {
    let path = parse_path(raw)?;
    if path.is_empty() {
        return None;
    }
    let mut digits = Vec::with_capacity(path.len().saturating_sub(1));
    for i in 0..path.len() - 1 {
        let parent = commit(&path[i]);
        let mut found: Option<u8> = None;
        for (k, x) in path[i + 1].iter().enumerate() {
            if *x == parent {
                if found.is_some() {
                    return None;
                }
                found = Some(k as u8);
            }
        }
        digits.push(found?);
    }
    Some((commit(path.last()?), digits))
}

/// Fold an unblinded dest path to the dest-tree root. Intermediate levels must
/// commit into a child slot of the next level (log-time; no full-J scan).
pub fn dest_path_root(raw: &[u8]) -> Option<[u8; 32]> {
    fold_path(raw, commit_vesta)
}

pub fn c_path_root(raw: &[u8]) -> Option<[u8; 32]> {
    fold_path(raw, commit_ristretto_encodings)
}

pub fn dest_path_slots(raw: &[u8]) -> Option<([u8; 32], Vec<u8>)> {
    fold_path_slots(raw, commit_vesta)
}

pub fn c_path_slots(raw: &[u8]) -> Option<([u8; 32], Vec<u8>)> {
    fold_path_slots(raw, commit_ristretto_encodings)
}

/// Leaf at slot `d0` of the bottom sibling vector.
pub fn path_selected_leaf(raw: &[u8], d0: u8) -> Option<[u8; 32]> {
    if (d0 as usize) >= ARITY {
        return None;
    }
    let path = parse_path(raw)?;
    let first = path.first()?;
    Some(first[d0 as usize])
}
