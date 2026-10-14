//! T21 cb-v3 rulings shared with `crypto/t21_law.js` and `crypto/t21_voucher.js`.
//! Not wired into consensus. The vectors live in `crypto/vectors/`.

use curve25519_dalek::{
  constants::RISTRETTO_BASEPOINT_POINT,
  ristretto::{CompressedRistretto, RistrettoPoint},
  Scalar,
};
use sha2::{Digest, Sha512};

use crate::leaf::{leaf_of, ChainNote};

/// Domain of the voucher leaf probe.
pub const VCH_PROBE_DOM: &[u8] = b"shear-vch-probe-v1";
/// Domain of the voucher label `λ = Hs(dom ‖ B* ‖ Y)`.
pub const VCH_LAM_DOM: &[u8] = b"shear-vch-lam-v2";

/// The LogUp label bound to the payout keys.
pub fn voucher_lambda(b: &[u8; 32], y: &[u8; 32]) -> Scalar {
  let mut h = Sha512::new();
  h.update(VCH_LAM_DOM);
  h.update(b);
  h.update(y);
  let mut wide = [0u8; 64];
  wide.copy_from_slice(&h.finalize());
  Scalar::from_bytes_mod_order_wide(&wide)
}

/// `W·v = (R + W·u)·W_i − ρ + W·fin`, `0 ≤ ρ < W`. Returns `(v, ρ)`, or `None`
/// for `W = 0`, `W_i > W`, or an overflow.
pub fn split_law(r: u128, w: u128, wi: u128, u: u128, fin: u128) -> Option<(u128, u128)> {
  if w == 0 || wi > w {
    return None;
  }
  let num = r.checked_add(w.checked_mul(u)?)?.checked_mul(wi)?.checked_add(w.checked_mul(fin)?)?;
  Some((num / w, num % w))
}

fn canonical_point(bytes: &[u8; 32]) -> Option<RistrettoPoint> {
  let p = CompressedRistretto(*bytes).decompress()?;
  if p == RistrettoPoint::default() || p.compress().to_bytes() != *bytes {
    return None;
  }
  Some(p)
}

/// The probe commitment and admit point for `B*`.
pub fn voucher_probe(b: &[u8; 32]) -> Option<([u8; 32], [u8; 32])> {
  let bp = canonical_point(b)?;
  let mut h = Sha512::new();
  h.update(VCH_PROBE_DOM);
  h.update(b);
  let mut wide = [0u8; 64];
  wide.copy_from_slice(&h.finalize());
  let probe_c = RistrettoPoint::from_uniform_bytes(&wide).compress().to_bytes();
  let mut h = Sha512::new();
  h.update(VCH_PROBE_DOM);
  h.update(b);
  h.update(probe_c);
  let mut wide = [0u8; 64];
  wide.copy_from_slice(&h.finalize());
  let delta = Scalar::from_bytes_mod_order_wide(&wide);
  let p = (bp + RISTRETTO_BASEPOINT_POINT * delta).compress().to_bytes();
  Some((probe_c, p))
}

/// Voucher acceptance: canonical, distinct, non-identity `B*` and `Y`, a
/// canonical non-zero `λ` equal to `voucher_lambda(B*, Y)`, and a probe note `(B* + δ·G, probeC)` that is an FS-1 leaf.
pub fn voucher_keys_ok(b: &[u8; 32], y: &[u8; 32], lambda: &[u8; 32]) -> bool {
  let (Some(bp), Some(yp)) = (canonical_point(b), canonical_point(y)) else { return false };
  if bp == yp {
    return false;
  }
  let lam: Option<Scalar> = Scalar::from_canonical_bytes(*lambda).into();
  match lam {
    Some(l) if l != Scalar::ZERO && l == voucher_lambda(b, y) => {}
    _ => return false,
  }
  let Some((probe_c, p)) = voucher_probe(b) else { return false };
  leaf_of(&ChainNote { admit_pub: p, commit: probe_c }).is_some()
}

/* ---------- prover primitives shared with crypto/t21.js ---------- */

/// Domain of every prover nonce and blind.
pub const NONCE_DOM: &[u8] = b"shear-t21-nonce-v1";
/// Domain of the KT-10 0x23 blind.
pub const VAULT_R_DOM: &[u8] = b"shear-kt10-0x23-r-v1";

fn wide_scalar(parts: &[&[u8]]) -> Scalar {
  let mut h = Sha512::new();
  for p in parts {
    h.update(p);
  }
  let mut wide = [0u8; 64];
  wide.copy_from_slice(&h.finalize());
  Scalar::from_bytes_mod_order_wide(&wide)
}

/// `H_s(dom ‖ seed ‖ bind ‖ len ‖ label ‖ u32le(i) ‖ u32le(j))`, with zero mapped to one.
/// `t21Nonce` in JS. Labels are at most 255 bytes.
pub fn t21_nonce(seed: &[u8], label: &[u8], i: u32, j: u32, bind: &[u8]) -> Scalar {
  assert!(label.len() <= 255, "nonce label");
  let s = wide_scalar(&[NONCE_DOM, seed, bind, &[label.len() as u8], label, &i.to_le_bytes(), &j.to_le_bytes()]);
  if s == Scalar::ZERO {
    Scalar::ONE
  } else {
    s
  }
}

/// `vaultBlind`: the first non-zero `H_s(dom ‖ mintId ‖ u64le(height) ‖ parentId ‖ u8 ctr)`.
pub fn vault_blind(mint_id: &[u8], height: u64, parent_id: &[u8; 32]) -> Option<Scalar> {
  (0 ..= 255u8)
    .map(|n| wide_scalar(&[VAULT_R_DOM, mint_id, &height.to_le_bytes(), parent_id, &[n]]))
    .find(|r| *r != Scalar::ZERO)
}

/// `v·G + r·H`.
pub fn pedersen(v: Scalar, r: Scalar, h: &RistrettoPoint) -> RistrettoPoint {
  RISTRETTO_BASEPOINT_POINT * v + h * r
}

/// One VE limb: `(t·G, t·Y + m·G, m·G + s·H)`, `encryptLimb` in JS.
pub fn encrypt_limb(m: u64, y: &RistrettoPoint, t: Scalar, s: Scalar, h: &RistrettoPoint) -> [[u8; 32]; 3] {
  let ms = Scalar::from(m);
  [
    (RISTRETTO_BASEPOINT_POINT * t).compress().to_bytes(),
    (y * t + RISTRETTO_BASEPOINT_POINT * ms).compress().to_bytes(),
    pedersen(ms, s, h).compress().to_bytes(),
  ]
}
