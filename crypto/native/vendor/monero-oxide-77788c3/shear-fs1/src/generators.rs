//! Fixed FS-1 generators, derived by try-and-increment from public labels.
//!
//! Derivation `shear-fs1-generators-v1`:
//!
//! - `G` is the Ed25519 basepoint. A Shear `admitPub = x·G` on Ristretto maps
//!   to `x·G` here (see [`crate::leaf`]).
//! - Every other point is `point(curve, label, index)`. For `ctr = 0, 1, ...`,
//!   `h = Blake2b-512(DST || 0x00 || curve || 0x00 || label || u32le(index) || u32le(ctr))`
//!   and `h[..32]` is read as a compressed point on `curve`. The first `ctr`
//!   that decodes to a non-identity point wins. On Ed25519 the decoded point
//!   is multiplied by the cofactor 8, so the result has prime order.
//!   Selene and Helios have cofactor 1.
//! - Ed25519 labels: `T`, `U`, `V`, each at index 0.
//! - Selene and Helios labels: `g`, `h`, `init` at index 0, then `g_bold` and
//!   `h_bold` at indices `0 .. rows`. Rows are `Fcmp::ipa_rows(8, 7)`:
//!   2,048 on Selene and 1,024 on Helios.
//!
//! No discrete log between any two of these points is known to anyone.
//! The set is pinned by [`generators_digest`] and `vectors/generators.txt`.
//! It is a proposal for Stage 3. It is not a ratified consensus set.

use blake2::{Blake2b512, Digest};
use ciphersuite::{
  group::{Group, GroupEncoding},
  Ciphersuite,
};
use curve25519_dalek::{edwards::CompressedEdwardsY, traits::IsIdentity};

use dalek_ff_group::EdwardsPoint;
use full_chain_membership_proofs::Fcmp;
use generalized_bulletproofs::Generators;
use helioselene::{Helios, Selene};

use crate::membership::{EdG, ShearCurves, DEPTH};
use crate::rulings::INPUT_MAX;

/// Domain separator for every FS-1 generator.
pub const GENERATOR_DST: &[u8] = b"shear-fs1-generators-v1";

/// `(Selene rows, Helios rows)` the fixed set holds: enough for 8 inputs at depth 7.
pub fn generator_rows() -> (usize, usize) {
  Fcmp::<ShearCurves>::ipa_rows(INPUT_MAX, DEPTH)
}

fn candidate(curve: &[u8], label: &[u8], index: u32, ctr: u32) -> [u8; 32] {
  let mut hasher = Blake2b512::new();
  hasher.update(GENERATOR_DST);
  hasher.update([0]);
  hasher.update(curve);
  hasher.update([0]);
  hasher.update(label);
  hasher.update(index.to_le_bytes());
  hasher.update(ctr.to_le_bytes());
  let wide = hasher.finalize();
  let mut out = [0u8; 32];
  out.copy_from_slice(&wide[.. 32]);
  out
}

/// Prime-order Ed25519 point for `label`.
pub fn ed25519_point(label: &[u8]) -> EdG {
  for ctr in 0 .. u32::MAX {
    let Some(point) = CompressedEdwardsY(candidate(b"ed25519", label, 0, ctr)).decompress() else {
      continue;
    };
    let point = point.mul_by_cofactor();
    if !IsIdentity::is_identity(&point) {
      return EdwardsPoint(point);
    }
  }
  unreachable!("no Ed25519 point for a generator label")
}

fn identity_free<G: GroupEncoding<Repr = [u8; 32]> + Group>(bytes: [u8; 32]) -> Option<G> {
  let point: Option<G> = G::from_bytes(&bytes).into();
  point.filter(|p| !bool::from(p.is_identity()))
}

/// Point on a cofactor-1 curve for `label` at `index`.
pub fn cycle_point<C: Ciphersuite>(curve: &[u8], label: &[u8], index: u32) -> C::G
where
  C::G: GroupEncoding<Repr = [u8; 32]>,
{
  for ctr in 0 .. u32::MAX {
    if let Some(point) = identity_free::<C::G>(candidate(curve, label, index, ctr)) {
      return point;
    }
  }
  unreachable!("no curve point for a generator label")
}

fn bold<C: Ciphersuite>(curve: &[u8], label: &[u8], rows: usize) -> Vec<C::G>
where
  C::G: GroupEncoding<Repr = [u8; 32]>,
{
  (0 .. rows).map(|i| cycle_point::<C>(curve, label, u32::try_from(i).expect("rows fit u32"))).collect()
}

/// The full fixed set, before table precomputation.
pub(crate) struct FixedSet {
  pub(crate) g: EdG,
  pub(crate) t: EdG,
  pub(crate) u: EdG,
  pub(crate) v: EdG,
  pub(crate) c1: Generators<Selene>,
  pub(crate) c2: Generators<Helios>,
  pub(crate) c1_init: <Selene as Ciphersuite>::G,
  pub(crate) c2_init: <Helios as Ciphersuite>::G,
}

pub(crate) fn fixed_set() -> Option<FixedSet> {
  let (rows1, rows2) = generator_rows();
  let c1 = Generators::new(
    cycle_point::<Selene>(b"selene", b"g", 0),
    cycle_point::<Selene>(b"selene", b"h", 0),
    bold::<Selene>(b"selene", b"g_bold", rows1),
    bold::<Selene>(b"selene", b"h_bold", rows1),
  )
  .ok()?;
  let c2 = Generators::new(
    cycle_point::<Helios>(b"helios", b"g", 0),
    cycle_point::<Helios>(b"helios", b"h", 0),
    bold::<Helios>(b"helios", b"g_bold", rows2),
    bold::<Helios>(b"helios", b"h_bold", rows2),
  )
  .ok()?;
  Some(FixedSet {
    g: <EdG as Group>::generator(),
    t: ed25519_point(b"T"),
    u: ed25519_point(b"U"),
    v: ed25519_point(b"V"),
    c1,
    c2,
    c1_init: cycle_point::<Selene>(b"selene", b"init", 0),
    c2_init: cycle_point::<Helios>(b"helios", b"init", 0),
  })
}

/// Blake2b-512 over every generator in a fixed order, compressed.
///
/// Order: G, T, U, V, then for Selene and then Helios: g, h, init, every
/// `g_bold`, every `h_bold`.
pub fn generators_digest(params: &crate::Fs1Params) -> [u8; 64] {
  let mut hasher = Blake2b512::new();
  hasher.update(GENERATOR_DST);
  for point in [params.g, params.t, params.u, params.v] {
    hasher.update(point.to_bytes());
  }
  hasher.update(params.c1.g().to_bytes());
  hasher.update(params.c1.h().to_bytes());
  hasher.update(params.c1_init.to_bytes());
  for point in params.c1.g_bold_slice().iter().chain(params.c1.h_bold_slice()) {
    hasher.update(point.to_bytes());
  }
  hasher.update(params.c2.g().to_bytes());
  hasher.update(params.c2.h().to_bytes());
  hasher.update(params.c2_init.to_bytes());
  for point in params.c2.g_bold_slice().iter().chain(params.c2.h_bold_slice()) {
    hasher.update(point.to_bytes());
  }
  let mut out = [0u8; 64];
  out.copy_from_slice(&hasher.finalize());
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::membership::tests::params_8;
  use crate::vectors::{hex, Vectors};

  #[test]
  fn ed25519_points_have_prime_order_and_differ() {
    let points = [ed25519_point(b"T"), ed25519_point(b"U"), ed25519_point(b"V")];
    for p in points {
      assert!(p.0.is_torsion_free());
      assert!(!bool::from(p.is_identity()));
      assert_ne!(p, <EdG as Group>::generator());
    }
    assert_ne!(points[0], points[1]);
    assert_ne!(points[1], points[2]);
  }

  #[test]
  fn fixed_set_is_deterministic_and_matches_the_pinned_digest() {
    let params = params_8();
    let (rows1, rows2) = generator_rows();
    assert_eq!((rows1, rows2), (2048, 1024));
    assert_eq!(params.c1.g_bold_slice().len(), rows1);
    assert_eq!(params.c2.g_bold_slice().len(), rows2);
    assert_eq!(params.t, ed25519_point(b"T"));
    assert_eq!(params.c1.g_bold_slice()[7], cycle_point::<Selene>(b"selene", b"g_bold", 7));
    assert_eq!(params.c2.h_bold_slice()[1023], cycle_point::<Helios>(b"helios", b"h_bold", 1023));
    let vectors = Vectors::generators();
    assert_eq!(hex(&generators_digest(params)), vectors.get("digest"));
    assert_eq!(hex(&params.t.to_bytes()), vectors.get("T"));
    assert_eq!(hex(&params.u.to_bytes()), vectors.get("U"));
    assert_eq!(hex(&params.v.to_bytes()), vectors.get("V"));
    assert_eq!(hex(&params.c1_init.to_bytes()), vectors.get("selene_init"));
    assert_eq!(hex(&params.c2_init.to_bytes()), vectors.get("helios_init"));
  }
}
