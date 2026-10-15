//! Fixed FS-1 generators, derived by try-and-increment from public labels.
//!
//! Derivation `shear-fs1-generators-v1` (version-bound; the same points on
//! every network):
//!
//! - The spend proof's `G` is `E(H)`, Shear's note blinding generator mapped
//!   onto Ed25519. `H` is Ristretto `from_uniform_bytes(SHA-512("shear-bpplus-v2"
//!   || "shear-note-H-v1"))`. `E` is [`crate::leaf::ristretto_to_ed`]. `G`
//!   blinds the FCMP commitment. Spend auth uses `B`, the Ed25519 basepoint.
//! - `T`, `U`, and `V` are Blake2b try-and-increment on Ed25519. That
//!   derivation is unchanged. Spec 100c §1.5.1 still names a different
//!   SHA-512 derivation; amending it is pending Russell's ruling.
//! - Every try-and-increment point is `point(curve, label, index)`. For
//!   `ctr = 0, 1, ...`,
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
//! [`crate::Fs1Params::fixed`] still stores the basepoint in its `g` field.
//! The pinned set is [`crate::spend_params`]: that field is `E(H)`, and the
//! digest also covers `B`. No discrete log between any two of `{B, E(H), T, U, V}`
//! is known to anyone. The set is pinned by [`generators_digest`] and
//! `vectors/generators.txt`. Status: pending PA+CA ratification. It is not a
//! ratified consensus set.

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
use crate::vectors::hex;

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

/// Blake2b-512 over the spend generator set, compressed.
///
/// Order: `E(H)` (`params.g` on [`crate::spend_params`]), `B` (the Ed25519
/// basepoint, spend auth), `T`, `U`, `V`, then for Selene and then Helios:
/// g, h, init, every `g_bold`, every `h_bold`.
///
/// The digest matches `vectors/generators.txt` when `params` is the spend set.
pub fn generators_digest(params: &crate::Fs1Params) -> [u8; 64] {
  let mut hasher = Blake2b512::new();
  hasher.update(GENERATOR_DST);
  let b = <EdG as Group>::generator();
  for point in [params.g, b, params.t, params.u, params.v] {
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

fn vector_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
  text.lines().find_map(|line| {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
      return None;
    }
    let (k, v) = line.split_once('\t')?;
    (k == key).then_some(v)
  })
}

fn expect_point(got: &[u8], want: &str, label: &str) -> Result<(), String> {
  let got = hex(got);
  if got != want {
    return Err(format!("{label}: {got} != {want}"));
  }
  Ok(())
}

/// Recompute every spend generator and compare it to `params`, then check
/// the pinned rows in `vectors/generators.txt`.
///
/// `params` is the spend set: `g` is `E(H)`. `B` is the Ed25519 basepoint
/// and is hashed beside it. `T`, `U`, and `V` stay Blake2b try-and-increment.
///
/// `Ok` is the Blake2b-512 digest of the set. The set is pending PA+CA
/// ratification. It is not a ratified consensus set.
pub fn generators_match_derivation(params: &crate::Fs1Params) -> Result<[u8; 64], String> {
  let (rows1, rows2) = generator_rows();
  if params.c1.g_bold_slice().len() != rows1 || params.c1.h_bold_slice().len() != rows1 {
    return Err(format!("selene rows {} != {rows1}", params.c1.g_bold_slice().len()));
  }
  if params.c2.g_bold_slice().len() != rows2 || params.c2.h_bold_slice().len() != rows2 {
    return Err(format!("helios rows {} != {rows2}", params.c2.g_bold_slice().len()));
  }
  let blind = crate::spend::commitment_blind().ok_or("E(H)")?;
  let b = <EdG as Group>::generator();
  if params.g != blind {
    return Err(format!("G is not E(H): {}", hex(&params.g.to_bytes())));
  }
  if params.g == b {
    return Err("G and B are the same point".into());
  }
  if params.t != ed25519_point(b"T") || params.u != ed25519_point(b"U") || params.v != ed25519_point(b"V") {
    return Err("Ed25519 T, U, or V".into());
  }
  if params.c1.g() != cycle_point::<Selene>(b"selene", b"g", 0)
    || params.c1.h() != cycle_point::<Selene>(b"selene", b"h", 0)
    || params.c1_init != cycle_point::<Selene>(b"selene", b"init", 0)
  {
    return Err("Selene g, h, or init".into());
  }
  if params.c2.g() != cycle_point::<Helios>(b"helios", b"g", 0)
    || params.c2.h() != cycle_point::<Helios>(b"helios", b"h", 0)
    || params.c2_init != cycle_point::<Helios>(b"helios", b"init", 0)
  {
    return Err("Helios g, h, or init".into());
  }
  for i in 0 .. rows1 {
    let idx = u32::try_from(i).map_err(|_| "selene index".to_string())?;
    if params.c1.g_bold_slice()[i] != cycle_point::<Selene>(b"selene", b"g_bold", idx) {
      return Err(format!("selene g_bold {i}"));
    }
    if params.c1.h_bold_slice()[i] != cycle_point::<Selene>(b"selene", b"h_bold", idx) {
      return Err(format!("selene h_bold {i}"));
    }
  }
  for i in 0 .. rows2 {
    let idx = u32::try_from(i).map_err(|_| "helios index".to_string())?;
    if params.c2.g_bold_slice()[i] != cycle_point::<Helios>(b"helios", b"g_bold", idx) {
      return Err(format!("helios g_bold {i}"));
    }
    if params.c2.h_bold_slice()[i] != cycle_point::<Helios>(b"helios", b"h_bold", idx) {
      return Err(format!("helios h_bold {i}"));
    }
  }
  let digest = generators_digest(params);
  let vectors = include_str!("../vectors/generators.txt");
  let row = |key: &str| vector_value(vectors, key).ok_or_else(|| format!("no {key} vector"));
  expect_point(&digest, row("digest")?, "digest")?;
  expect_point(&params.g.to_bytes(), row("G")?, "G")?;
  expect_point(&b.to_bytes(), row("B")?, "B")?;
  expect_point(&params.t.to_bytes(), row("T")?, "T")?;
  expect_point(&params.u.to_bytes(), row("U")?, "U")?;
  expect_point(&params.v.to_bytes(), row("V")?, "V")?;
  expect_point(&params.c1_init.to_bytes(), row("selene_init")?, "selene_init")?;
  expect_point(&params.c2_init.to_bytes(), row("helios_init")?, "helios_init")?;
  Ok(digest)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::leaf::ristretto_to_ed;
  use crate::spend::{commitment_blind, spend_params, NOTE_H_DST, NOTE_H_LABEL};
  use crate::vectors::{hex, Vectors};
  use curve25519_dalek::ristretto::RistrettoPoint;
  use sha2::{Digest, Sha512};

  #[test]
  fn ed25519_points_have_prime_order_and_differ() {
    let blind = commitment_blind().expect("E(H)");
    let points = [blind, ed25519_point(b"T"), ed25519_point(b"U"), ed25519_point(b"V")];
    let b = <EdG as Group>::generator();
    for p in points {
      assert!(p.0.is_torsion_free());
      assert!(!bool::from(p.is_identity()));
      assert_ne!(p, b);
    }
    assert_ne!(points[0], points[1]);
    assert_ne!(points[1], points[2]);
    assert_ne!(points[2], points[3]);
  }

  /// `E(H)` from the public label, without [`commitment_blind`] or [`crate::spend::note_h`].
  fn derive_commitment_blind() -> EdG {
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&Sha512::new().chain_update(b"shear-bpplus-v2").chain_update(b"shear-note-H-v1").finalize());
    let h = RistrettoPoint::from_uniform_bytes(&wide);
    ristretto_to_ed(&h.compress().to_bytes()).expect("E(H)")
  }

  #[test]
  fn commitment_blind_recomputes_independently() {
    assert_eq!(NOTE_H_DST, b"shear-bpplus-v2");
    assert_eq!(NOTE_H_LABEL, b"shear-note-H-v1");
    let derived = derive_commitment_blind();
    let live = spend_params().expect("spend generators").g;
    assert_eq!(derived, live);
    assert_eq!(derived, commitment_blind().expect("E(H)"));
    let got = hex(&derived.to_bytes());
    assert!(got.starts_with("132ba4e1"), "E(H) {got}");
    assert!(derived.0.is_torsion_free());
    assert_ne!(derived, <EdG as Group>::generator());
    let vectors = Vectors::generators();
    assert_eq!(got, vectors.get("G"));
    assert_eq!(
      hex(&<EdG as Group>::generator().to_bytes()),
      "5866666666666666666666666666666666666666666666666666666666666666"
    );
  }

  #[test]
  fn every_generator_recomputes_to_the_pinned_set() {
    let params = spend_params().expect("spend generators");
    let (rows1, rows2) = generator_rows();
    assert_eq!((rows1, rows2), (2048, 1024));
    let digest = generators_match_derivation(params).expect("pending PA+CA ratification");
    let vectors = Vectors::generators();
    assert_eq!(hex(&digest), vectors.get("digest"));
    assert_eq!(hex(&params.g.to_bytes()), vectors.get("G"));
    assert!(vectors.get("G").starts_with("132ba4e1"));
    assert_eq!(hex(&<EdG as Group>::generator().to_bytes()), vectors.get("B"));
    assert_eq!(hex(&params.t.to_bytes()), vectors.get("T"));
    assert_eq!(hex(&params.u.to_bytes()), vectors.get("U"));
    assert_eq!(hex(&params.v.to_bytes()), vectors.get("V"));
    assert_eq!(hex(&params.c1_init.to_bytes()), vectors.get("selene_init"));
    assert_eq!(hex(&params.c2_init.to_bytes()), vectors.get("helios_init"));
  }
}
