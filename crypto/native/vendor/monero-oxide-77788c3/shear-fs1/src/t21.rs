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
/// canonical non-zero `λ`, and a probe note `(B* + δ·G, probeC)` that is an FS-1 leaf.
pub fn voucher_keys_ok(b: &[u8; 32], y: &[u8; 32], lambda: &[u8; 32]) -> bool {
  let (Some(bp), Some(yp)) = (canonical_point(b), canonical_point(y)) else { return false };
  if bp == yp {
    return false;
  }
  let lam: Option<Scalar> = Scalar::from_canonical_bytes(*lambda).into();
  match lam {
    Some(l) if l != Scalar::ZERO => {}
    _ => return false,
  }
  let Some((probe_c, p)) = voucher_probe(b) else { return false };
  leaf_of(&ChainNote { admit_pub: p, commit: probe_c }).is_some()
}
