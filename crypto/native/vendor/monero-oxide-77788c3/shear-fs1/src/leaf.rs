//! Chain note to FS-1 leaf.
//!
//! A chain note is an output that joins the admit set: its `admitPub` and its
//! `commit`, both Ristretto255 encodings. The FS-1 leaf is the output tuple
//! `(O, I, C)` on Ed25519:
//!
//! - L-1. `O = E(admitPub)` and `C = E(commit)`, where `E` decodes a Ristretto
//!   encoding (RFC 9496 §4.3.1) and takes the prime-order component of the
//!   Edwards representative, `E(P) = 8⁻¹·(8·P)`. `E` is the group isomorphism
//!   from Ristretto255 onto the prime-order subgroup, so `E(x·G) = x·G`.
//! - L-2. `I = E(Hp(admitPub))`, where `Hp` is Shear's spend-tag hash,
//!   `hash_to_ristretto255(admitPub, DST = "shear-admit-Hp")` (RFC 9380,
//!   expand_message_xmd with SHA-512). A key image `x·I` is then `E` of the
//!   note's existing spend tag.
//! - L-3. A note whose `admitPub` or `commit` is not a canonical Ristretto
//!   encoding, or maps to the identity, is not a leaf. It takes no slot.
//! - L-4. Leaf bytes are `O || I || C`, each a compressed Ed25519 point.
//!
//! `node/src/fs1_tree.js` implements the same map with `@noble/curves`.
//! `vectors/tree_chain.txt` and `vectors/n1_leaf.txt` are checked against both.

use ciphersuite::group::{
  ff::{Field, PrimeField},
  GroupEncoding,
};
use curve25519_dalek::{edwards::CompressedEdwardsY, ristretto::RistrettoPoint, Scalar};
use dalek_ff_group::{EdwardsPoint, FieldElement};
use full_chain_membership_proofs::Output;
use sha2::{Digest, Sha512};
use subtle::ConditionallyNegatable;

use crate::membership::EdG;

/// DST of Shear's spend-tag hash `Hp`. Shared with `crypto/admit.js`.
pub const HP_DST: &[u8] = b"shear-admit-Hp";

/// Bytes in one leaf: three compressed Ed25519 points.
pub const LEAF_BYTES: usize = 96;

/// One chain note: the two Ristretto encodings the admit set records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainNote {
  /// `admitPub` of the output.
  pub admit_pub: [u8; 32],
  /// `commit` of the output.
  pub commit: [u8; 32],
}

fn edwards_d() -> FieldElement {
  -FieldElement::from(121_665u64) * FieldElement::from(121_666u64).invert().unwrap()
}

/// `E`: Ristretto255 encoding to its prime-order Ed25519 point. `None` when not canonical.
pub fn ristretto_to_ed(bytes: &[u8; 32]) -> Option<EdG> {
  let s = Option::<FieldElement>::from(FieldElement::from_repr(*bytes))?;
  if bool::from(s.is_odd()) {
    return None;
  }
  let one = FieldElement::from(1u8);
  let ss = s.square();
  let u1 = one - ss;
  let u2 = one + ss;
  let u2_sqr = u2.square();
  let v = -(edwards_d() * u1.square()) - u2_sqr;
  let (was_square, invsqrt) = FieldElement::sqrt_ratio_i(one, v * u2_sqr);
  let den_x = invsqrt * u2;
  let den_y = invsqrt * den_x * v;
  let mut x = (s + s) * den_x;
  let x_negative = x.is_odd();
  x.conditional_negate(x_negative);
  let y = u1 * den_y;
  let t = x * y;
  if !bool::from(was_square) || bool::from(t.is_odd()) || bool::from(y.is_zero()) {
    return None;
  }
  let mut encoded = y.to_repr();
  encoded[31] |= u8::from(bool::from(x.is_odd())) << 7;
  let representative = CompressedEdwardsY(encoded).decompress()?;
  let eight_inv = Scalar::from(8u8).invert();
  Some(EdwardsPoint(representative.mul_by_cofactor() * eight_inv))
}

/// RFC 9380 §5.3.1 with SHA-512. `len` is at most 255 · 64 and `dst` under 256 bytes.
fn expand_message_xmd_sha512(msg: &[u8], dst: &[u8], len: usize) -> Vec<u8> {
  let dst_len = u8::try_from(dst.len()).expect("DST under 256 bytes");
  let ell = u8::try_from(len.div_ceil(64)).expect("output under 255 blocks");
  let b0 = Sha512::new()
    .chain_update([0u8; 128])
    .chain_update(msg)
    .chain_update(u16::try_from(len).expect("output under 65536 bytes").to_be_bytes())
    .chain_update([0u8])
    .chain_update(dst)
    .chain_update([dst_len])
    .finalize();
  let mut out = Vec::with_capacity(usize::from(ell) * 64);
  let mut prev = [0u8; 64];
  for i in 1 ..= ell {
    let mut mixed = [0u8; 64];
    for ((m, a), b) in mixed.iter_mut().zip(b0.iter()).zip(prev.iter()) {
      *m = a ^ b;
    }
    let bi = Sha512::new().chain_update(mixed).chain_update([i]).chain_update(dst).chain_update([dst_len]).finalize();
    prev.copy_from_slice(&bi);
    out.extend_from_slice(&bi);
  }
  out.truncate(len);
  out
}

/// `hash_to_ristretto255(msg, dst)` per RFC 9380.
pub fn hash_to_ristretto(msg: &[u8], dst: &[u8]) -> RistrettoPoint {
  let mut uniform = [0u8; 64];
  uniform.copy_from_slice(&expand_message_xmd_sha512(msg, dst, 64));
  RistrettoPoint::from_uniform_bytes(&uniform)
}

/// L-1 to L-3. The leaf for one chain note, or `None` when the note takes no slot.
pub fn leaf_of(note: &ChainNote) -> Option<Output<EdG>> {
  let o = ristretto_to_ed(&note.admit_pub)?;
  let hp = hash_to_ristretto(&note.admit_pub, HP_DST).compress().to_bytes();
  let i = ristretto_to_ed(&hp)?;
  let c = ristretto_to_ed(&note.commit)?;
  Output::new(o, i, c).ok()
}

/// L-4.
pub fn leaf_bytes(leaf: &Output<EdG>) -> [u8; LEAF_BYTES] {
  let mut out = [0u8; LEAF_BYTES];
  out[.. 32].copy_from_slice(&leaf.O().to_bytes());
  out[32 .. 64].copy_from_slice(&leaf.I().to_bytes());
  out[64 ..].copy_from_slice(&leaf.C().to_bytes());
  out
}

/// Parse leaf bytes. Each point must be canonical, prime order, and not the identity.
pub fn leaf_from_bytes(bytes: &[u8; LEAF_BYTES]) -> Option<Output<EdG>> {
  let mut points = [<EdG as ciphersuite::group::Group>::identity(); 3];
  for (point, chunk) in points.iter_mut().zip(bytes.chunks_exact(32)) {
    let mut repr = [0u8; 32];
    repr.copy_from_slice(chunk);
    *point = Option::<EdG>::from(EdG::from_bytes(&repr))?;
    if point.to_bytes() != repr {
      return None;
    }
  }
  Output::new(points[0], points[1], points[2]).ok()
}

#[cfg(test)]
mod tests {
  use super::*;
  use ciphersuite::group::Group;
  use curve25519_dalek::constants::{ED25519_BASEPOINT_POINT, RISTRETTO_BASEPOINT_POINT};
  use rand_core::OsRng;

  #[test]
  fn e_is_the_isomorphism_onto_the_prime_order_subgroup() {
    let base = ristretto_to_ed(&RISTRETTO_BASEPOINT_POINT.compress().to_bytes()).expect("basepoint");
    assert_eq!(base.0, ED25519_BASEPOINT_POINT);
    for _ in 0 .. 16 {
      let x = Scalar::random(&mut OsRng);
      let r = (RISTRETTO_BASEPOINT_POINT * x).compress().to_bytes();
      let e = ristretto_to_ed(&r).expect("decode");
      assert_eq!(e.0, ED25519_BASEPOINT_POINT * x);
      assert!(e.0.is_torsion_free());
    }
    let identity = ristretto_to_ed(&[0u8; 32]).expect("identity decodes");
    assert!(bool::from(identity.is_identity()));
  }

  #[test]
  fn e_accepts_exactly_what_ristretto_accepts() {
    use curve25519_dalek::ristretto::CompressedRistretto;
    let mut cases = Vec::new();
    for _ in 0 .. 256 {
      let mut bytes = [0u8; 32];
      rand_core::RngCore::fill_bytes(&mut OsRng, &mut bytes);
      bytes[31] &= 0x7f;
      cases.push(bytes);
      cases.push((RISTRETTO_BASEPOINT_POINT * Scalar::random(&mut OsRng)).compress().to_bytes());
    }
    let mut odd = RISTRETTO_BASEPOINT_POINT.compress().to_bytes();
    odd[0] ^= 1;
    cases.extend([odd, [0xff; 32], [0xed; 32]]);
    let mut decoded = 0;
    for bytes in cases {
      let ours = ristretto_to_ed(&bytes);
      let theirs = CompressedRistretto(bytes).decompress();
      assert_eq!(ours.is_some(), theirs.is_some(), "{}", crate::vectors::hex(&bytes));
      if let (Some(ours), Some(theirs)) = (ours, theirs) {
        assert_eq!(ours.0.compress().to_bytes(), ristretto_to_ed(&theirs.compress().to_bytes()).unwrap().to_bytes());
        decoded += 1;
      }
    }
    assert!(decoded >= 256);
  }

  #[test]
  fn hp_matches_rfc9380_and_noble() {
    let dst = b"QUUX-V01-CS02-with-expander-SHA512-256";
    assert_eq!(
      crate::vectors::hex(&expand_message_xmd_sha512(b"", dst, 32)),
      "6b9a7312411d92f921c6f68ca0b6380730a1a4d982c507211a90964c394179ba"
    );
    assert_eq!(
      crate::vectors::hex(&expand_message_xmd_sha512(b"abc", dst, 128)),
      "7f1dddd13c08b543f2e2037b14cefb255b44c83cc397c1786d975653e36a6b11bdd7732d8b38adb4a0edc26a0cef4bb4\
       5217135456e58fbca1703cd6032cb1347ee720b87972d63fbf232587043ed2901bce7f22610c0419751c065922b4884318\
       51041310ad659e4b23520e1772ab29dcdeb2002222a363f0c2b1c972b3efe1"
    );
    // @noble/curves ristretto255_hasher.hashToCurve("abc", { DST: "shear-admit-Hp" }), as crypto/admit.js calls it.
    assert_eq!(
      crate::vectors::hex(&hash_to_ristretto(b"abc", HP_DST).compress().to_bytes()),
      "7481a6d0e576cbe0d5c26e53544ce42be3845a6be316f66dcde3f356f981e66f"
    );
  }

  #[test]
  fn leaf_map_skips_identity_and_bad_encodings_and_round_trips() {
    let a = (RISTRETTO_BASEPOINT_POINT * Scalar::from(5u8)).compress().to_bytes();
    let c = (RISTRETTO_BASEPOINT_POINT * Scalar::from(9u8)).compress().to_bytes();
    let leaf = leaf_of(&ChainNote { admit_pub: a, commit: c }).expect("leaf");
    assert_eq!(leaf.O().0, ED25519_BASEPOINT_POINT * Scalar::from(5u8));
    assert_eq!(leaf_from_bytes(&leaf_bytes(&leaf)), Some(leaf));
    assert!(leaf_of(&ChainNote { admit_pub: a, commit: [0; 32] }).is_none());
    assert!(leaf_of(&ChainNote { admit_pub: [0; 32], commit: c }).is_none());
    assert!(leaf_of(&ChainNote { admit_pub: [0xff; 32], commit: c }).is_none());
    let mut torsioned = leaf_bytes(&leaf);
    torsioned[.. 32].copy_from_slice(&(ED25519_BASEPOINT_POINT * Scalar::from(5u8) + EIGHT_TORSION_1).compress().to_bytes());
    assert!(leaf_from_bytes(&torsioned).is_none());
  }

  /// `vectors/n1_leaf.txt`. The same rows `crypto/fs1_leaf.js` checks, including I = E(Hp(admitPub)).
  #[test]
  fn n1_leaf_vector_matches_the_js_predicate() {
    let text = include_str!("../vectors/n1_leaf.txt");
    let mut rows = 0;
    for line in text.lines() {
      if line.is_empty() || line.starts_with('#') {
        continue;
      }
      let cols: Vec<&str> = line.split('\t').collect();
      assert_eq!(cols.len(), 4, "{line}");
      let note = ChainNote { admit_pub: crate::vectors::unhex32(cols[1]), commit: crate::vectors::unhex32(cols[2]) };
      let got = leaf_of(&note).map(|leaf| crate::vectors::hex(&leaf_bytes(&leaf)));
      let want = if cols[3] == "skip" { None } else { Some(cols[3].to_string()) };
      assert_eq!(got.as_deref(), want.as_deref(), "{}", cols[0]);
      rows += 1;
    }
    assert!(rows >= 12, "{rows}");
  }

  const EIGHT_TORSION_1: curve25519_dalek::EdwardsPoint = curve25519_dalek::constants::EIGHT_TORSION[1];
}
