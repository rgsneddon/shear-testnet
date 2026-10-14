//! T21 cb-v3 row prover, the native twin of `commitRow`, `proveRow` and
//! `proveTally` in `crypto/t21.js`.
//!
//! Every nonce and blind is `t21_nonce(seed, label, i, j, bind)`, as in JS, so a
//! request is stateless: the prove step re-derives each row's secrets from the
//! seed and the leaf try `n` the commit step returned. Given the same inputs
//! both provers produce the same bytes. `tests/t21_vectors.rs` checks a reply
//! the JS prover wrote.
//!
//! Requests and replies are text, one request per process, fields split by
//! whitespace. The reply ends with `ok`, or is one `error <reason> <index>` line.
//!
//! - `commit <H> <seed> <magic> <height> <prevHash> <W> <rows>`, then per row
//!   `<index> <noLeaf> <v> <Wi> <rho> <B> <Y>`. Replies per row
//!   `row <index> <n> <C> <P> <cw> <rhoK x3> <delK x3> <epV epD M x20>`.
//! - `prove <H> <seed> <stmt> <W> <rate> <rows> <shares>`, then per row
//!   `<index> <n> <v> <Wi> <rho> <finEff> <Y> <lambda>` in index order, then per
//!   share `<w> <E> <ell> <beta>`. Replies per row
//!   `row <index> <bindR1 bindR2 zT zS x20> <RC RVv RDv RVr RDr zv zr ztv ztr> <lawR lawZ>
//!   <A S T1 T2 taux mu that L x9 R x9 a b>`, per share
//!   `inv <Cinv> <Rp> <Ra> <zA> <zDiff> <zBlind>`, then `tally <n> <balR> <balZ> <wtR> <wtZ>`.
//!
//! `<H>` is the note generator the caller uses; any other value is refused.
//! Integers are decimal, points and scalars 32-byte hex, `magic` and `stmt` hex.

use std::{
  sync::{
    atomic::{AtomicUsize, Ordering},
    OnceLock,
  },
  thread,
};

use curve25519_dalek::{
  constants::{RISTRETTO_BASEPOINT_POINT, RISTRETTO_BASEPOINT_TABLE},
  ristretto::{CompressedRistretto, RistrettoBasepointTable, RistrettoPoint},
  traits::{Identity, MultiscalarMul, VartimeMultiscalarMul},
  Scalar,
};
use sha2::{Digest, Sha256, Sha512};

use crate::{
  leaf::{leaf_of, ChainNote},
  t21::t21_nonce,
  vectors::{hex, unhex, unhex_n},
};

pub const V_CHUNKS: usize = 4;
pub const R_CHUNKS: usize = 16;
pub const VE_CHUNKS: usize = V_CHUNKS + R_CHUNKS;
pub const RHO_LIMBS: usize = 3;
pub const BP_N: usize = 16;
pub const BP_M: usize = 32;
const BP_NM: usize = BP_N * BP_M;
const BP_K: usize = 9;
pub const LEAF_TRIES: u32 = 8;
/// `W_MAX` in `crypto/t21_params.js`: every `W`, `ρ` and `W − 1 − ρ` is below it.
pub const W_MAX: u128 = 1 << 48;
pub const DOM_CB: &[u8] = b"dom_cb-v1";
pub const LOGUP_DOM: &[u8] = b"shear-logup-x-v1";
pub const BP_GEN_DST: &[u8] = b"shear-t21-bp-gen-v1";
const BP_DST: &[u8] = b"shear-t21-bp-v1";
const BP_SEED_DOM: &[u8] = b"shear-t21-row-bp-v1";
/// Most rows or shares one request may carry.
pub const MAX_ITEMS: usize = 65_536;
/// Longest request read, in bytes.
pub const MAX_REQUEST: usize = 64 << 20;

/// A refused request: the reason and the row or share index, when there is one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProveError {
  pub reason: &'static str,
  pub index: Option<usize>,
}

fn bad(reason: &'static str) -> ProveError {
  ProveError { reason, index: None }
}

fn bad_at(reason: &'static str, index: usize) -> ProveError {
  ProveError { reason, index: Some(index) }
}

/* ---------- generators ---------- */

struct Gens {
  h: RistrettoPoint,
  h_table: RistrettoBasepointTable,
  bp_g: Vec<RistrettoPoint>,
  bp_h: Vec<RistrettoPoint>,
  bp_u: RistrettoPoint,
}

fn wide(parts: &[&[u8]]) -> [u8; 64] {
  let mut h = Sha512::new();
  for p in parts {
    h.update(p);
  }
  let mut out = [0u8; 64];
  out.copy_from_slice(&h.finalize());
  out
}

fn hs(parts: &[&[u8]]) -> Scalar {
  Scalar::from_bytes_mod_order_wide(&wide(parts))
}

/// The note generator H: `from_uniform_bytes(SHA-512("shear-bpplus-v2" ‖ "shear-note-H-v1"))`.
pub fn note_h() -> RistrettoPoint {
  RistrettoPoint::from_uniform_bytes(&wide(&[b"shear-bpplus-v2", b"shear-note-H-v1"]))
}

fn gen_point(tag: &[u8], i: u32) -> RistrettoPoint {
  RistrettoPoint::from_uniform_bytes(&wide(&[BP_GEN_DST, tag, &i.to_le_bytes()]))
}

fn gens() -> &'static Gens {
  static GENS: OnceLock<Gens> = OnceLock::new();
  GENS.get_or_init(|| {
    let h = note_h();
    Gens {
      h,
      h_table: RistrettoBasepointTable::create(&h),
      bp_g: (0 .. BP_NM as u32).map(|i| gen_point(b"G", i)).collect(),
      bp_h: (0 .. BP_NM as u32).map(|i| gen_point(b"H", i)).collect(),
      bp_u: gen_point(b"U", 0),
    }
  })
}

fn mul_g(s: &Scalar) -> RistrettoPoint {
  RISTRETTO_BASEPOINT_TABLE * s
}

fn mul_h(s: &Scalar) -> RistrettoPoint {
  &gens().h_table * s
}

fn commit(v: Scalar, r: &Scalar) -> RistrettoPoint {
  mul_g(&v) + mul_h(r)
}

fn enc(p: &RistrettoPoint) -> [u8; 32] {
  p.compress().to_bytes()
}

fn pow16(j: usize) -> Scalar {
  let step = Scalar::from(1u64 << 16);
  (0 .. j).fold(Scalar::ONE, |acc, _| acc * step)
}

fn limbs(x: u128, count: usize) -> Vec<u64> {
  (0 .. count).map(|i| if 16 * i >= 128 { 0 } else { ((x >> (16 * i)) & 0xffff) as u64 }).collect()
}

fn scalar_limbs(s: &Scalar) -> Vec<u64> {
  let b = s.to_bytes();
  (0 .. R_CHUNKS).map(|i| u64::from(b[2 * i]) | (u64::from(b[2 * i + 1]) << 8)).collect()
}

/* ---------- inputs ---------- */

/// One payout row of `commit`: `noLeaf` makes it fail, as `forceNonLeaf` does in JS.
#[derive(Clone, Debug)]
pub struct CommitRow {
  pub index: u32,
  pub no_leaf: bool,
  pub v: u64,
  pub wi: u128,
  pub rho: u128,
  pub b: [u8; 32],
  pub y: [u8; 32],
}

/// One payout row of `prove`, with the leaf try `n` its commit used.
#[derive(Clone, Debug)]
pub struct ProveRow {
  pub index: u32,
  pub n: u32,
  pub v: u64,
  pub wi: u128,
  pub rho: u128,
  pub fin_eff: u128,
  pub y: [u8; 32],
  pub lambda: [u8; 32],
}

/// One share of the tally: the public weight and label point, and the label secrets.
#[derive(Clone, Debug)]
pub struct Share {
  pub w: u128,
  pub e: [u8; 32],
  pub ell: Scalar,
  pub beta: Scalar,
}

/// The row secrets both phases derive from the seed.
struct Secrets {
  rw: Scalar,
  rho_limbs: Vec<u64>,
  del_limbs: Vec<u64>,
  s_rho: Vec<Scalar>,
  s_del: Vec<Scalar>,
  r_rho: Scalar,
  limb_m: Vec<u64>,
  enc_t: Vec<Scalar>,
  enc_s: Vec<Scalar>,
}

fn secrets(seed: &[u8], index: u32, r: Scalar, v: u64, rho: u128, w: u128) -> Result<Secrets, ProveError> {
  let at = index as usize;
  if w == 0 || w >= W_MAX || rho >= w {
    return Err(bad_at("split_cap", at));
  }
  let nonce = |label: &[u8], j: u32| t21_nonce(seed, label, index, j, &[]);
  let rho_limbs = limbs(rho, RHO_LIMBS);
  let s_rho: Vec<Scalar> = (0 .. RHO_LIMBS as u32).map(|k| nonce(b"srho", k)).collect();
  let r_rho = (0 .. RHO_LIMBS).fold(Scalar::ZERO, |acc, i| acc + pow16(i) * s_rho[i]);
  let del_limbs = limbs(w - 1 - rho, RHO_LIMBS);
  let mut s_del = vec![nonce(b"sdel", 0), nonce(b"sdel", 1)];
  let top = -r_rho - s_del[0] - pow16(1) * s_del[1];
  s_del.push(top * pow16(2).invert());
  let mut limb_m = limbs(u128::from(v), V_CHUNKS);
  limb_m.extend(scalar_limbs(&r));
  Ok(Secrets {
    rw: nonce(b"rw", 0),
    rho_limbs,
    del_limbs,
    s_rho,
    s_del,
    r_rho,
    limb_m,
    enc_t: (0 .. VE_CHUNKS as u32).map(|j| nonce(b"enc-t", j)).collect(),
    enc_s: (0 .. VE_CHUNKS as u32).map(|j| nonce(b"enc-s", j)).collect(),
  })
}

fn point(bytes: &[u8; 32]) -> Option<RistrettoPoint> {
  CompressedRistretto(*bytes).decompress()
}

fn key_point(bytes: &[u8; 32]) -> Option<RistrettoPoint> {
  point(bytes).filter(|p| *p != RistrettoPoint::identity())
}

/* ---------- phase one ---------- */

/// Phase-one output of one row, every point encoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Committed {
  pub index: u32,
  pub n: u32,
  pub c: [u8; 32],
  pub p: [u8; 32],
  pub cw: [u8; 32],
  pub rho_k: Vec<[u8; 32]>,
  pub del_k: Vec<[u8; 32]>,
  /// `(epV, epD, M)` per VE limb.
  pub chunks: Vec<[[u8; 32]; 3]>,
}

/// The block fields `payoutDelta` binds.
#[derive(Clone, Debug)]
pub struct BlockId {
  pub magic: Vec<u8>,
  pub height: u64,
  pub prev_hash: Vec<u8>,
}

fn payout_delta(block: &BlockId, index: u32, c: &[u8; 32]) -> Scalar {
  hs(&[DOM_CB, &block.magic, &block.height.to_le_bytes(), &block.prev_hash, &index.to_le_bytes(), c])
}

struct Limbs {
  ep_v: Vec<RistrettoPoint>,
  ep_d: Vec<RistrettoPoint>,
  m: Vec<RistrettoPoint>,
}

fn encrypt(sec: &Secrets, y: &RistrettoPoint) -> Limbs {
  let mut out = Limbs { ep_v: vec![], ep_d: vec![], m: vec![] };
  for j in 0 .. VE_CHUNKS {
    let m = Scalar::from(sec.limb_m[j]);
    let t = sec.enc_t[j];
    out.ep_v.push(mul_g(&t));
    out.ep_d.push(y * t + mul_g(&m));
    out.m.push(commit(m, &sec.enc_s[j]));
  }
  out
}

/// `commitRow`: the first leaf try whose `(B* + δ·G, C)` is an FS-1 leaf, then the
/// weight commit, ρ and `W − 1 − ρ` limb commits, and the VE ciphertexts.
pub fn commit_row(seed: &[u8], block: &BlockId, w: u128, row: &CommitRow) -> Result<Committed, ProveError> {
  let at = row.index as usize;
  let b = key_point(&row.b).ok_or(bad_at("voucher_key", at))?;
  let y = key_point(&row.y).ok_or(bad_at("voucher_key", at))?;
  let mut found = None;
  for n in 0 .. if row.no_leaf { 0 } else { LEAF_TRIES } {
    let r = t21_nonce(seed, b"r", row.index, n, &[]);
    let c = enc(&commit(Scalar::from(row.v), &r));
    let delta = payout_delta(block, row.index, &c);
    if delta == Scalar::ZERO {
      continue;
    }
    let p = enc(&(b + mul_g(&delta)));
    if leaf_of(&ChainNote { admit_pub: p, commit: c }).is_some() {
      found = Some((n, r, c, p));
      break;
    }
  }
  let (n, r, c, p) = found.ok_or(bad_at("admit_note_point", at))?;
  let sec = secrets(seed, row.index, r, row.v, row.rho, w)?;
  let limbs = encrypt(&sec, &y);
  Ok(Committed {
    index: row.index,
    n,
    c,
    p,
    cw: enc(&commit(Scalar::from(row.wi), &sec.rw)),
    rho_k: (0 .. RHO_LIMBS).map(|i| enc(&commit(Scalar::from(sec.rho_limbs[i]), &sec.s_rho[i]))).collect(),
    del_k: (0 .. RHO_LIMBS).map(|i| enc(&commit(Scalar::from(sec.del_limbs[i]), &sec.s_del[i]))).collect(),
    chunks: (0 .. VE_CHUNKS).map(|j| [enc(&limbs.ep_v[j]), enc(&limbs.ep_d[j]), enc(&limbs.m[j])]).collect(),
  })
}

/* ---------- aggregated range proof ---------- */

struct Transcript(Sha512);

impl Transcript {
  fn new(seed: &[u8]) -> Self {
    let mut h = Sha512::new();
    h.update(BP_DST);
    h.update(seed);
    Transcript(h)
  }

  fn point(&mut self, p: &RistrettoPoint) {
    self.0.update(p.compress().as_bytes());
  }

  fn scalar(&mut self, s: &Scalar) {
    self.0.update(s.as_bytes());
  }

  fn challenge(&mut self, label: &[u8]) -> Result<Scalar, ProveError> {
    let mut h = self.0.clone();
    h.update(label);
    let mut d = [0u8; 64];
    d.copy_from_slice(&h.finalize());
    self.0.update(d);
    let c = Scalar::from_bytes_mod_order_wide(&d);
    if c == Scalar::ZERO {
      return Err(bad("bp_challenge"));
    }
    Ok(c)
  }
}

/// `bpProve` output, fields in its order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BpProof {
  pub a_pt: [u8; 32],
  pub s_pt: [u8; 32],
  pub t1: [u8; 32],
  pub t2: [u8; 32],
  pub taux: Scalar,
  pub mu: Scalar,
  pub that: Scalar,
  pub l: Vec<[u8; 32]>,
  pub r: Vec<[u8; 32]>,
  pub a: Scalar,
  pub b: Scalar,
}

fn powers(x: Scalar, n: usize) -> Vec<Scalar> {
  let mut out = Vec::with_capacity(n);
  let mut acc = Scalar::ONE;
  for _ in 0 .. n {
    out.push(acc);
    acc *= x;
  }
  out
}

fn inner(a: &[Scalar], b: &[Scalar]) -> Scalar {
  a.iter().zip(b).fold(Scalar::ZERO, |s, (x, y)| s + x * y)
}

/// `bpProve(values, blinds, 16, seed, rand)` over 32 values. `rand(label, k)` is
/// the caller's nonce for `bp-<label>`.
pub fn bp_prove(
  values: &[u64],
  blinds: &[Scalar],
  seed: &[u8],
  rand: impl Fn(&str, u32) -> Scalar,
) -> Result<BpProof, ProveError> {
  let (n, m) = (BP_N, BP_M);
  if values.len() != m || blinds.len() != m {
    return Err(bad("bp_shape"));
  }
  let g = gens();
  let (gv, hv) = (&g.bp_g[.. BP_NM], &g.bp_h[.. BP_NM]);
  let mut tr = Transcript::new(seed);
  for j in 0 .. m {
    if values[j] >> n != 0 {
      return Err(bad("bp_range"));
    }
    tr.point(&commit(Scalar::from(values[j]), &blinds[j]));
  }
  let mut a_l = vec![Scalar::ZERO; BP_NM];
  let mut a_r = vec![Scalar::ZERO; BP_NM];
  for j in 0 .. m {
    for i in 0 .. n {
      let bit = (values[j] >> i) & 1;
      a_l[j * n + i] = Scalar::from(bit);
      a_r[j * n + i] = Scalar::from(bit) - Scalar::ONE;
    }
  }
  let alpha = rand("alpha", 0);
  let gh = || gv.iter().chain(hv.iter());
  let a_pt = mul_h(&alpha) + RistrettoPoint::multiscalar_mul(a_l.iter().chain(a_r.iter()), gh());
  let s_l: Vec<Scalar> = (0 .. BP_NM as u32).map(|i| rand("sl", i)).collect();
  let s_r: Vec<Scalar> = (0 .. BP_NM as u32).map(|i| rand("sr", i)).collect();
  let rho = rand("rho", 0);
  let s_pt = mul_h(&rho) + RistrettoPoint::multiscalar_mul(s_l.iter().chain(s_r.iter()), gh());
  tr.point(&a_pt);
  tr.point(&s_pt);
  let y = tr.challenge(b"y")?;
  let z = tr.challenge(b"z")?;
  let y_n = powers(y, BP_NM);
  let two = powers(Scalar::from(2u64), n);
  let zp = powers(z, m + 2);
  let l0: Vec<Scalar> = a_l.iter().map(|a| a - z).collect();
  let l1 = &s_l;
  let mut r0 = vec![Scalar::ZERO; BP_NM];
  let mut r1 = vec![Scalar::ZERO; BP_NM];
  for j in 0 .. m {
    for i in 0 .. n {
      let k = j * n + i;
      r0[k] = y_n[k] * (a_r[k] + z) + zp[j + 2] * two[i];
      r1[k] = y_n[k] * s_r[k];
    }
  }
  let t1 = inner(&l0, &r1) + inner(l1, &r0);
  let t2 = inner(l1, &r1);
  let tau1 = rand("tau1", 0);
  let tau2 = rand("tau2", 0);
  let t1_pt = commit(t1, &tau1);
  let t2_pt = commit(t2, &tau2);
  tr.point(&t1_pt);
  tr.point(&t2_pt);
  let x = tr.challenge(b"x")?;
  let mut av: Vec<Scalar> = l0.iter().zip(l1).map(|(a, b)| a + b * x).collect();
  let mut bv: Vec<Scalar> = r0.iter().zip(&r1).map(|(a, b)| a + b * x).collect();
  let that = inner(&av, &bv);
  let mut taux = tau2 * x * x + tau1 * x;
  for j in 0 .. m {
    taux += zp[j + 2] * blinds[j];
  }
  let mu = alpha + rho * x;
  tr.scalar(&taux);
  tr.scalar(&mu);
  tr.scalar(&that);
  let w = tr.challenge(b"w")?;
  let uw = g.bp_u * w;
  let y_inv_n = powers(y.invert(), BP_NM);
  // The first round folds y^-i into the H scalars instead of scaling 512 points.
  let mut gs: Vec<RistrettoPoint> = gv.to_vec();
  let mut hs_pts: Vec<RistrettoPoint> = hv.to_vec();
  let mut h_fac: Option<&[Scalar]> = Some(&y_inv_n);
  let (mut ls, mut rs) = (Vec::with_capacity(BP_K), Vec::with_capacity(BP_K));
  while av.len() > 1 {
    let h = av.len() / 2;
    let (a_lo, a_hi) = av.split_at(h);
    let (b_lo, b_hi) = bv.split_at(h);
    let (g_lo, g_hi) = gs.split_at(h);
    let (h_lo, h_hi) = hs_pts.split_at(h);
    let fac = |i: usize| h_fac.map_or(Scalar::ONE, |f| f[i]);
    let c_l = inner(a_lo, b_hi);
    let c_r = inner(a_hi, b_lo);
    let l_sc: Vec<Scalar> =
      a_lo.iter().copied().chain((0 .. h).map(|i| b_hi[i] * fac(i))).chain([c_l]).collect();
    let r_sc: Vec<Scalar> =
      a_hi.iter().copied().chain((0 .. h).map(|i| b_lo[i] * fac(h + i))).chain([c_r]).collect();
    let l_pt = RistrettoPoint::multiscalar_mul(&l_sc, g_hi.iter().chain(h_lo).chain([&uw]));
    let r_pt = RistrettoPoint::multiscalar_mul(&r_sc, g_lo.iter().chain(h_hi).chain([&uw]));
    tr.point(&l_pt);
    tr.point(&r_pt);
    ls.push(enc(&l_pt));
    rs.push(enc(&r_pt));
    let u = tr.challenge(b"u")?;
    let ui = u.invert();
    let na: Vec<Scalar> = (0 .. h).map(|i| a_lo[i] * u + a_hi[i] * ui).collect();
    let nb: Vec<Scalar> = (0 .. h).map(|i| b_lo[i] * ui + b_hi[i] * u).collect();
    let ng: Vec<RistrettoPoint> =
      (0 .. h).map(|i| RistrettoPoint::vartime_multiscalar_mul([ui, u], [g_lo[i], g_hi[i]])).collect();
    let nh: Vec<RistrettoPoint> = (0 .. h)
      .map(|i| RistrettoPoint::vartime_multiscalar_mul([u * fac(i), ui * fac(h + i)], [h_lo[i], h_hi[i]]))
      .collect();
    av = na;
    bv = nb;
    gs = ng;
    hs_pts = nh;
    h_fac = None;
  }
  Ok(BpProof {
    a_pt: enc(&a_pt),
    s_pt: enc(&s_pt),
    t1: enc(&t1_pt),
    t2: enc(&t2_pt),
    taux,
    mu,
    that,
    l: ls,
    r: rs,
    a: av[0],
    b: bv[0],
  })
}

/* ---------- phase two ---------- */

/// A Schnorr proof on H: `(R, z)`.
pub type HProof = ([u8; 32], Scalar);

fn prove_h(p: &RistrettoPoint, s: Scalar, extra: &[u8], k: Scalar) -> HProof {
  let r = enc(&mul_h(&k));
  let e = hs(&[&enc(p), &r, extra]);
  (r, k + e * s)
}

/// Phase-two output of one row, fields in `proveRow` order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proved {
  pub index: u32,
  /// `(bindR1, bindR2, zT, zS)` per VE limb.
  pub chunks: Vec<([u8; 32], [u8; 32], Scalar, Scalar)>,
  /// `RC RVv RDv RVr RDr`.
  pub agg_pts: [[u8; 32]; 5],
  /// `zv zr ztv ztr`.
  pub agg_z: [Scalar; 4],
  pub law: HProof,
  pub bp: BpProof,
}

/// `proveRow` against the final statement `stmt`.
pub fn prove_row(seed: &[u8], stmt: &[u8], w: u128, rate: u128, row: &ProveRow) -> Result<Proved, ProveError> {
  let at = row.index as usize;
  let index = row.index;
  let y = key_point(&row.y).ok_or(bad_at("voucher_key", at))?;
  if row.n >= LEAF_TRIES {
    return Err(bad_at("admit_note_point", at));
  }
  let r = t21_nonce(seed, b"r", index, row.n, &[]);
  let sec = secrets(seed, index, r, row.v, row.rho, w)?;
  let nk = |label: &[u8], j: u32| t21_nonce(seed, label, index, j, stmt);
  let limbs = encrypt(&sec, &y);
  let c_pt = commit(Scalar::from(row.v), &r);
  let c = enc(&c_pt);
  let yb = enc(&y);
  let mut chunks = Vec::with_capacity(VE_CHUNKS);
  for j in 0 .. VE_CHUNKS {
    let (kt, ks) = (nk(b"chunk-kt", j as u32), nk(b"chunk-ks", j as u32));
    let r1 = enc(&mul_g(&kt));
    let r2 = enc(&(y * kt - mul_h(&ks)));
    let e = hs(&[&r1, &r2, &enc(&limbs.ep_v[j]), &enc(&limbs.ep_d[j]), &enc(&limbs.m[j]), stmt]);
    chunks.push((r1, r2, kt + e * sec.enc_t[j], ks + e * sec.enc_s[j]));
  }
  let tv = (0 .. V_CHUNKS).fold(Scalar::ZERO, |acc, j| acc + pow16(j) * sec.enc_t[j]);
  let tr_ = (0 .. R_CHUNKS).fold(Scalar::ZERO, |acc, j| acc + pow16(j) * sec.enc_t[V_CHUNKS + j]);
  let (kv, kr, ktv, ktr) = (nk(b"agg-kv", 0), nk(b"agg-kr", 0), nk(b"agg-ktv", 0), nk(b"agg-ktr", 0));
  let agg_pts = [
    enc(&commit(kv, &kr)),
    enc(&mul_g(&ktv)),
    enc(&(y * ktv + mul_g(&kv))),
    enc(&mul_g(&ktr)),
    enc(&(y * ktr + mul_g(&kr))),
  ];
  let e = hs(&[&agg_pts[0], &agg_pts[1], &agg_pts[2], &agg_pts[3], &agg_pts[4], &c, &yb, stmt]);
  let agg_z = [kv + e * Scalar::from(row.v), kr + e * r, ktv + e * tv, ktr + e * tr_];
  let (ws, rate_s) = (Scalar::from(w), Scalar::from(rate));
  let law_h = ws * r - rate_s * sec.rw + sec.r_rho;
  let cw = commit(Scalar::from(row.wi), &sec.rw);
  let rho_c = commit(Scalar::from(row.rho), &sec.r_rho);
  let law_p = c_pt * ws - cw * rate_s + rho_c - mul_g(&(ws * Scalar::from(row.fin_eff)));
  let law = prove_h(&law_p, law_h, stmt, nk(b"law", 0));
  let mut values = sec.limb_m.clone();
  values.extend(&sec.rho_limbs);
  values.extend(&sec.del_limbs);
  let mut blinds = sec.enc_s.clone();
  blinds.extend(&sec.s_rho);
  blinds.extend(&sec.s_del);
  values.resize(BP_M, 0);
  blinds.resize(BP_M, Scalar::ZERO);
  let mut seed_h = Sha256::new();
  seed_h.update(BP_SEED_DOM);
  seed_h.update(stmt);
  seed_h.update(index.to_le_bytes());
  let bp_seed = seed_h.finalize();
  let bp = bp_prove(&values, &blinds, &bp_seed, |label, k| {
    let full = format!("bp-{label}");
    nk(full.as_bytes(), k)
  })
  .map_err(|e| bad_at(e.reason, at))?;
  Ok(Proved { index, chunks, agg_pts, agg_z, law, bp })
}

/// One share's inverse commitment and product proof, `proveProduct` order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inv {
  pub c_inv: [u8; 32],
  pub rp: [u8; 32],
  pub ra: [u8; 32],
  pub z_a: Scalar,
  pub z_diff: Scalar,
  pub z_blind: Scalar,
}

/// `proveTally` output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tally {
  pub n: u8,
  pub inv: Vec<Inv>,
  pub balance: HProof,
  pub weight: HProof,
}

/// `pickChallenge`: the first non-zero `X = H_s(dom ‖ stmt ‖ n)` equal to no row label.
pub fn pick_challenge(stmt: &[u8], lambdas: &[Scalar]) -> Option<(Scalar, u8)> {
  (0 .. 64u8).find_map(|n| {
    let x = hs(&[LOGUP_DOM, stmt, &[n]]);
    (x != Scalar::ZERO && !lambdas.contains(&x)).then_some((x, n))
  })
}

fn share_inv(seed: &[u8], stmt: &[u8], x: Scalar, si: usize, s: &Share) -> Result<(Inv, RistrettoPoint, Scalar), ProveError> {
  let a = x - s.ell;
  if a == Scalar::ZERO {
    return Err(bad_at("split_tally", si));
  }
  let e_pt = point(&s.e).ok_or(bad_at("share_bind", si))?;
  let nk = |label: &[u8]| t21_nonce(seed, label, si as u32, 0, stmt);
  let r_inv = nk(b"tally-rinv");
  let cb = commit(a.invert(), &r_inv);
  let ca = mul_g(&x) - e_pt;
  let (ka, kb, kr) = (nk(b"prod-ka"), nk(b"prod-kb"), nk(b"prod-kr"));
  let rp = enc(&(cb * ka - mul_h(&kr)));
  let ra = enc(&commit(ka, &kb));
  let cbb = enc(&cb);
  let e = hs(&[&rp, &ra, &enc(&ca), &cbb, stmt]);
  let inv = Inv { c_inv: cbb, rp, ra, z_a: ka + e * a, z_diff: kr + e * (a * r_inv), z_blind: kb + e * -s.beta };
  Ok((inv, cb, r_inv))
}

/// `proveTally` for rows in index order. Shares are proven on `threads` threads.
pub fn prove_tally(
  seed: &[u8],
  stmt: &[u8],
  w: u128,
  rows: &[ProveRow],
  shares: &[Share],
  threads: usize,
) -> Result<Tally, ProveError> {
  let mut lambdas = Vec::with_capacity(rows.len());
  for (i, row) in rows.iter().enumerate() {
    let lam: Option<Scalar> = Scalar::from_canonical_bytes(row.lambda).into();
    lambdas.push(lam.ok_or(bad_at("voucher_key", i))?);
  }
  let (x, n) = pick_challenge(stmt, &lambdas).ok_or(bad("split_tally"))?;
  let done = par_map(shares.len(), threads, |si| share_inv(seed, stmt, x, si, &shares[si]))?;
  let mut h_share = Scalar::ZERO;
  let mut cbs = Vec::with_capacity(done.len());
  let mut ws = Vec::with_capacity(done.len());
  let mut inv = Vec::with_capacity(done.len());
  for (si, (p, cb, r_inv)) in done.into_iter().enumerate() {
    let wsc = Scalar::from(shares[si].w);
    h_share += wsc * r_inv;
    cbs.push(cb);
    ws.push(wsc);
    inv.push(p);
  }
  let ds: Vec<Scalar> = lambdas.iter().map(|l| (x - l).invert()).collect();
  let mut cws = Vec::with_capacity(rows.len());
  let (mut h_row, mut h_w) = (Scalar::ZERO, Scalar::ZERO);
  for (i, row) in rows.iter().enumerate() {
    let rw = t21_nonce(seed, b"rw", row.index, 0, &[]);
    cws.push(commit(Scalar::from(row.wi), &rw));
    h_row += ds[i] * rw;
    h_w += rw;
  }
  let c_share = RistrettoPoint::vartime_multiscalar_mul(&ws, &cbs);
  let c_row = RistrettoPoint::vartime_multiscalar_mul(&ds, &cws);
  let sum_w: RistrettoPoint = cws.iter().sum();
  let balance = prove_h(&(c_share - c_row), h_share - h_row, stmt, t21_nonce(seed, b"tally-bal", 0, 0, stmt));
  let weight = prove_h(
    &(sum_w - RISTRETTO_BASEPOINT_POINT * Scalar::from(w)),
    h_w,
    stmt,
    t21_nonce(seed, b"tally-wt", 0, 0, stmt),
  );
  Ok(Tally { n, inv, balance, weight })
}

/// `f(i)` for `i < count` on up to `threads` threads, in order. The first error by index wins.
pub fn par_map<T: Send>(
  count: usize,
  threads: usize,
  f: impl Fn(usize) -> Result<T, ProveError> + Sync,
) -> Result<Vec<T>, ProveError> {
  let threads = threads.clamp(1, count.max(1));
  let next = AtomicUsize::new(0);
  let mut slots: Vec<Option<Result<T, ProveError>>> = (0 .. count).map(|_| None).collect();
  thread::scope(|scope| {
    let workers: Vec<_> = (0 .. threads)
      .map(|_| {
        scope.spawn(|| {
          let mut out = Vec::new();
          loop {
            let i = next.fetch_add(1, Ordering::Relaxed);
            if i >= count {
              break;
            }
            out.push((i, f(i)));
          }
          out
        })
      })
      .collect();
    for wk in workers {
      for (i, r) in wk.join().expect("prover thread") {
        slots[i] = Some(r);
      }
    }
  });
  slots.into_iter().map(|s| s.expect("every slot")).collect()
}

/* ---------- request protocol ---------- */

fn s_hex(s: &Scalar) -> String {
  hex(s.as_bytes())
}

struct Tokens<'a>(std::str::SplitAsciiWhitespace<'a>);

impl<'a> Tokens<'a> {
  fn next(&mut self) -> Result<&'a str, ProveError> {
    self.0.next().ok_or(bad("request"))
  }
  fn int<T: std::str::FromStr>(&mut self) -> Result<T, ProveError> {
    let t = self.next()?;
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) || (t.len() > 1 && t.starts_with('0')) {
      return Err(bad("request"));
    }
    t.parse().map_err(|_| bad("request"))
  }
  fn b32(&mut self) -> Result<[u8; 32], ProveError> {
    unhex_n::<32>(self.next()?).ok_or(bad("request"))
  }
  fn bytes(&mut self) -> Result<Vec<u8>, ProveError> {
    let t = self.next()?;
    if t == "-" {
      return Ok(vec![]);
    }
    unhex(t).ok_or(bad("request"))
  }
  fn scalar(&mut self) -> Result<Scalar, ProveError> {
    let s: Option<Scalar> = Scalar::from_canonical_bytes(self.b32()?).into();
    s.ok_or(bad("request"))
  }
  fn count(&mut self) -> Result<usize, ProveError> {
    let n: usize = self.int()?;
    if n > MAX_ITEMS {
      return Err(bad("count_cap"));
    }
    Ok(n)
  }
}

fn header(t: &mut Tokens) -> Result<Vec<u8>, ProveError> {
  if t.b32()? != enc(&gens().h) {
    return Err(bad("gen_h"));
  }
  let seed = t.bytes()?;
  if seed.is_empty() {
    return Err(bad("request"));
  }
  Ok(seed)
}

fn index_ok(index: u32, at: usize) -> Result<(), ProveError> {
  if index as usize != at {
    return Err(bad_at("row_order", at));
  }
  Ok(())
}

fn serve_commit(t: &mut Tokens, threads: usize, out: &mut String) -> Result<(), ProveError> {
  let seed = header(t)?;
  let block = BlockId { magic: t.bytes()?, height: t.int()?, prev_hash: t.bytes()? };
  let w: u128 = t.int()?;
  let count = t.count()?;
  let mut rows = Vec::with_capacity(count);
  for at in 0 .. count {
    let index: u32 = t.int()?;
    index_ok(index, at)?;
    let no_leaf = match t.next()? {
      "0" => false,
      "1" => true,
      _ => return Err(bad("request")),
    };
    rows.push(CommitRow { index, no_leaf, v: t.int()?, wi: t.int()?, rho: t.int()?, b: t.b32()?, y: t.b32()? });
  }
  if t.0.next().is_some() {
    return Err(bad("request"));
  }
  let done = par_map(rows.len(), threads, |i| commit_row(&seed, &block, w, &rows[i]))?;
  for c in done {
    out.push_str(&format!("row {} {} {} {} {}", c.index, c.n, hex(&c.c), hex(&c.p), hex(&c.cw)));
    for k in c.rho_k.iter().chain(&c.del_k) {
      out.push(' ');
      out.push_str(&hex(k));
    }
    for ch in &c.chunks {
      for p in ch {
        out.push(' ');
        out.push_str(&hex(p));
      }
    }
    out.push('\n');
  }
  Ok(())
}

fn serve_prove(t: &mut Tokens, threads: usize, out: &mut String) -> Result<(), ProveError> {
  let seed = header(t)?;
  let stmt = t.bytes()?;
  let w: u128 = t.int()?;
  let rate: u128 = t.int()?;
  let count = t.count()?;
  let share_count = t.count()?;
  let mut rows = Vec::with_capacity(count);
  for at in 0 .. count {
    let index: u32 = t.int()?;
    index_ok(index, at)?;
    rows.push(ProveRow {
      index,
      n: t.int()?,
      v: t.int()?,
      wi: t.int()?,
      rho: t.int()?,
      fin_eff: t.int()?,
      y: t.b32()?,
      lambda: t.b32()?,
    });
  }
  let mut shares = Vec::with_capacity(share_count);
  for _ in 0 .. share_count {
    shares.push(Share { w: t.int()?, e: t.b32()?, ell: t.scalar()?, beta: t.scalar()? });
  }
  if t.0.next().is_some() {
    return Err(bad("request"));
  }
  let proved = par_map(rows.len(), threads, |i| prove_row(&seed, &stmt, w, rate, &rows[i]))?;
  let tally = prove_tally(&seed, &stmt, w, &rows, &shares, threads)?;
  for p in proved {
    let mut f: Vec<String> = vec![format!("row {}", p.index)];
    for (r1, r2, zt, zs) in &p.chunks {
      f.extend([hex(r1), hex(r2), s_hex(zt), s_hex(zs)]);
    }
    f.extend(p.agg_pts.iter().map(|x| hex(x)));
    f.extend(p.agg_z.iter().map(s_hex));
    f.extend([hex(&p.law.0), s_hex(&p.law.1)]);
    let bp = &p.bp;
    f.extend([hex(&bp.a_pt), hex(&bp.s_pt), hex(&bp.t1), hex(&bp.t2), s_hex(&bp.taux), s_hex(&bp.mu), s_hex(&bp.that)]);
    f.extend(bp.l.iter().map(|x| hex(x)));
    f.extend(bp.r.iter().map(|x| hex(x)));
    f.extend([s_hex(&bp.a), s_hex(&bp.b)]);
    out.push_str(&f.join(" "));
    out.push('\n');
  }
  for i in &tally.inv {
    out.push_str(&format!(
      "inv {} {} {} {} {} {}\n",
      hex(&i.c_inv),
      hex(&i.rp),
      hex(&i.ra),
      s_hex(&i.z_a),
      s_hex(&i.z_diff),
      s_hex(&i.z_blind)
    ));
  }
  out.push_str(&format!(
    "tally {} {} {} {} {}\n",
    tally.n,
    hex(&tally.balance.0),
    s_hex(&tally.balance.1),
    hex(&tally.weight.0),
    s_hex(&tally.weight.1)
  ));
  Ok(())
}

/// One request in, one reply out. Never panics on input.
pub fn serve(request: &str, threads: usize) -> String {
  let mut t = Tokens(request.split_ascii_whitespace());
  let mut out = String::new();
  let res = match t.next() {
    Ok("commit") => serve_commit(&mut t, threads, &mut out),
    Ok("prove") => serve_prove(&mut t, threads, &mut out),
    _ => Err(bad("request")),
  };
  match res {
    Ok(()) => {
      out.push_str("ok\n");
      out
    }
    Err(e) => match e.index {
      Some(i) => format!("error {} {i}\n", e.reason),
      None => format!("error {} -\n", e.reason),
    },
  }
}
