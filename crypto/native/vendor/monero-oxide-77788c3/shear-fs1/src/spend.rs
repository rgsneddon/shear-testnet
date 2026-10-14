//! Stage 3: the transaction-bound FS-1 spend (ADMITv3).
//!
//! One spend covers every input of one transaction:
//!
//! - **Membership.** One aggregate FCMP over all inputs proves that each
//!   re-randomised tuple `(O~, I~, R, C~)` opens a leaf of the FS-1 tree whose
//!   root the node holds for the anchor height. The tree is every admit-set note
//!   on the chain (T-1): there are no buckets and no groups.
//! - **SA+L.** Per input, a Schnorr proof over Ed25519 of `x, o, a, b` with
//!   `O~ = x·G − o·T`, `L = x·I~ + a·U`, and `0 = x·R − b·T + a·V`. With the
//!   FCMP relations `O = O~ + o'·T`, `I = I~ + i'·U`, `R = ib'·T − i'·V`, and no
//!   known discrete log between `G, T, U, V`, this gives `L = x·I` for the
//!   leaf's `I = E(Hp(admitPub))`, so `L = E(spendTag)` and one note has one tag.
//!   `L` is not the identity, which rules out `x = 0`.
//! - **Binding.** Every SA+L challenge hashes the body digest, the anchor, the
//!   root, every input's public points and tag, and the FCMP bytes.
//!
//! Shear commits are `C = v·G + r·H` with `H` the note blinding generator, so
//! the FCMP commitment blind must run along `E(H)`, not `G`. Then
//! `C~ = E(C − c·H)`, the wallet publishes `C̃ = C − c·H` on the vin, and
//! conservation `Σ C_out + fee·G = Σ C̃_in + excess·H` holds with `t = −c`.
//! [`spend_params`] is the fixed generator proposal with that one role
//! assignment; the proposal's points and digest are unchanged. Neither is a
//! ratified consensus set.

use std::sync::OnceLock;

use ciphersuite::group::{Group, GroupEncoding};
use curve25519_dalek::{
  constants::{ED25519_BASEPOINT_POINT, RISTRETTO_BASEPOINT_POINT},
  edwards::{CompressedEdwardsY, EdwardsPoint as DEd},
  ristretto::{CompressedRistretto, RistrettoPoint},
  traits::IsIdentity,
  Scalar,
};
use dalek_ff_group::EdwardsPoint;
use full_chain_membership_proofs::{FcmpParams, Input, TreeRoot};
use helioselene::{Helios, Selene};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha512};
use zeroize::{Zeroize, Zeroizing};

use crate::chain_tree::ChainTree;
use crate::generators::fixed_set;
use crate::leaf::{hash_to_ristretto, leaf_bytes, leaf_of, ristretto_to_ed, ChainNote, HP_DST};
use crate::membership::{
  prove_prepared_scalars, proof_len, root_bytes, verify, EdG, Fs1Error, Fs1Params, Fs1Tree, OpenNote, PreparedBlinds,
  Proved, ShearCurves, DEPTH, NOTE_PAYMENT,
};
use crate::rulings::consensus_accepts;

/// First byte of every FS-1 spend blob and record.
pub const SPEND_WIRE: u8 = 0xf1;
/// `SPEND_WIRE || layers || n || root`, then the FCMP bytes.
pub const SPEND_HEAD: usize = 3 + 32;
/// Bytes of one SA+L proof: `e || s_x || s_o || s_a || s_b`.
pub const SAL_BYTES: usize = 5 * 32;
/// One input record: `SPEND_WIRE || tag || C̃ || O~ || I~ || R || SA+L`.
pub const RECORD_BYTES: usize = 1 + 32 + 32 + 3 * 32 + SAL_BYTES;

/// DST and label of Shear's note blinding generator, as `shear_admit` derives it.
pub const NOTE_H_DST: &[u8] = b"shear-bpplus-v2";
pub const NOTE_H_LABEL: &[u8] = b"shear-note-H-v1";

const TRANSCRIPT_DST: &[u8] = b"shear-fs1-spend-v1";
const SAL_DST: &[u8] = b"shear-fs1-sal-v1";

/// Shear's note blinding generator `H` on Ristretto255.
pub fn note_h() -> RistrettoPoint {
  let mut wide = [0u8; 64];
  wide.copy_from_slice(&Sha512::new().chain_update(NOTE_H_DST).chain_update(NOTE_H_LABEL).finalize());
  RistrettoPoint::from_uniform_bytes(&wide)
}

/// The fixed proposal with the commitment blind on `E(H)`.
pub fn spend_params() -> Result<&'static Fs1Params, Fs1Error> {
  static CELL: OnceLock<Option<Fs1Params>> = OnceLock::new();
  CELL
    .get_or_init(|| {
      let set = fixed_set()?;
      let h = ristretto_to_ed(&note_h().compress().to_bytes())?;
      let fcmp = FcmpParams::<ShearCurves>::new(
        set.c1.clone(),
        set.c2.clone(),
        set.c1_init,
        set.c2_init,
        h,
        set.t,
        set.u,
        set.v,
      );
      Some(Fs1Params {
        g: h,
        t: set.t,
        u: set.u,
        v: set.v,
        c1: set.c1,
        c2: set.c2,
        c1_init: set.c1_init,
        c2_init: set.c2_init,
        fcmp,
      })
    })
    .as_ref()
    .ok_or(Fs1Error::Blind)
}

/// One input to spend: the spent note's leaf index and its admit secret.
pub struct SpendIn {
  pub index: u64,
  pub x: Scalar,
}

impl Drop for SpendIn {
  fn drop(&mut self) {
    self.x.zeroize();
  }
}

/// A finished spend.
pub struct SpendOut {
  /// `SPEND_WIRE || layers || n || root || fcmp`. Public.
  pub fs1: Vec<u8>,
  /// One record per input, in input order. Public.
  pub records: Vec<[u8; RECORD_BYTES]>,
  /// Secret. `C̃ = C + t·H` per input, for the wallet's kernel excess.
  pub t: Vec<Zeroizing<[u8; 32]>>,
}

fn ed(point: EdG) -> DEd {
  point.0
}

fn canonical_ed(bytes: &[u8]) -> Option<DEd> {
  let mut repr = [0u8; 32];
  repr.copy_from_slice(bytes.get(.. 32)?);
  let point = CompressedEdwardsY(repr).decompress()?;
  if point.compress().to_bytes() != repr || !point.is_torsion_free() || IsIdentity::is_identity(&point) {
    return None;
  }
  Some(point)
}

fn canonical_ristretto(bytes: &[u8]) -> Option<RistrettoPoint> {
  let mut repr = [0u8; 32];
  repr.copy_from_slice(bytes.get(.. 32)?);
  let point = CompressedRistretto(repr).decompress()?;
  if point.compress().to_bytes() != repr || IsIdentity::is_identity(&point) {
    return None;
  }
  Some(point)
}

fn canonical_scalar(bytes: &[u8]) -> Option<Scalar> {
  let mut repr = [0u8; 32];
  repr.copy_from_slice(bytes.get(.. 32)?);
  Option::from(Scalar::from_canonical_bytes(repr))
}

fn root_from_bytes(bytes: &[u8; 32], layers: usize) -> Option<TreeRoot<Selene, Helios>> {
  if (layers - 1) % 2 == 0 {
    let p: Option<<Selene as ciphersuite::Ciphersuite>::G> = <Selene as ciphersuite::Ciphersuite>::G::from_bytes(bytes).into();
    p.filter(|p| p.to_bytes() == *bytes && !bool::from(p.is_identity())).map(TreeRoot::C1)
  } else {
    let p: Option<<Helios as ciphersuite::Ciphersuite>::G> = <Helios as ciphersuite::Ciphersuite>::G::from_bytes(bytes).into();
    p.filter(|p| p.to_bytes() == *bytes && !bool::from(p.is_identity())).map(TreeRoot::C2)
  }
}

/// Public part of one record before its SA+L.
struct RecordHead {
  tag: [u8; 32],
  c_tilde: [u8; 32],
  points: [u8; 96],
}

fn transcript(body_digest: &[u8; 32], anchor: u64, root: &[u8; 32], heads: &[RecordHead], fcmp: &[u8]) -> [u8; 64] {
  let mut h = Sha512::new();
  h.update(TRANSCRIPT_DST);
  h.update(body_digest);
  h.update(anchor.to_le_bytes());
  h.update(root);
  h.update([u8::try_from(DEPTH).expect("depth fits u8"), u8::try_from(heads.len()).expect("inputs fit u8")]);
  for head in heads {
    h.update(head.tag);
    h.update(head.c_tilde);
    h.update(head.points);
  }
  h.update(Sha512::digest(fcmp));
  let mut out = [0u8; 64];
  out.copy_from_slice(&h.finalize());
  out
}

#[allow(clippy::too_many_arguments)]
fn sal_challenge(m: &[u8; 64], index: u8, l: &DEd, a1: &DEd, a2: &DEd, a3: &DEd) -> Scalar {
  let mut wide = [0u8; 64];
  wide.copy_from_slice(
    &Sha512::new()
      .chain_update(SAL_DST)
      .chain_update(m)
      .chain_update([index])
      .chain_update(l.compress().to_bytes())
      .chain_update(a1.compress().to_bytes())
      .chain_update(a2.compress().to_bytes())
      .chain_update(a3.compress().to_bytes())
      .finalize(),
  );
  Scalar::from_bytes_mod_order_wide(&wide)
}

fn random_scalar() -> Scalar {
  let mut wide = Zeroizing::new([0u8; 64]);
  OsRng.fill_bytes(wide.as_mut());
  Scalar::from_bytes_mod_order_wide(&wide)
}

struct SalPublic {
  o_tilde: DEd,
  i_tilde: DEd,
  r: DEd,
  l: DEd,
}

struct SalWitness {
  x: Scalar,
  o: Scalar,
  a: Scalar,
  b: Scalar,
}

impl Drop for SalWitness {
  fn drop(&mut self) {
    self.x.zeroize();
    self.o.zeroize();
    self.a.zeroize();
    self.b.zeroize();
  }
}

fn sal_prove(params: &Fs1Params, m: &[u8; 64], index: u8, public: &SalPublic, w: &SalWitness) -> [u8; SAL_BYTES] {
  let (t, u, v) = (ed(params.t), ed(params.u), ed(params.v));
  let mut kx = random_scalar();
  let mut ko = random_scalar();
  let mut ka = random_scalar();
  let mut kb = random_scalar();
  let a1 = ED25519_BASEPOINT_POINT * kx - t * ko;
  let a2 = public.i_tilde * kx + u * ka;
  let a3 = public.r * kx - t * kb + v * ka;
  let e = sal_challenge(m, index, &public.l, &a1, &a2, &a3);
  let s = [e, kx + e * w.x, ko + e * w.o, ka + e * w.a, kb + e * w.b];
  kx.zeroize();
  ko.zeroize();
  ka.zeroize();
  kb.zeroize();
  let mut out = [0u8; SAL_BYTES];
  for (slot, scalar) in out.chunks_exact_mut(32).zip(s.iter()) {
    slot.copy_from_slice(scalar.as_bytes());
  }
  out
}

fn sal_verify(params: &Fs1Params, m: &[u8; 64], index: u8, public: &SalPublic, proof: &[u8]) -> bool {
  let mut s = [Scalar::ZERO; 5];
  for (slot, chunk) in s.iter_mut().zip(proof.chunks_exact(32)) {
    match canonical_scalar(chunk) {
      Some(x) => *slot = x,
      None => return false,
    }
  }
  let [e, sx, so, sa, sb] = s;
  let (t, u, v) = (ed(params.t), ed(params.u), ed(params.v));
  let a1 = ED25519_BASEPOINT_POINT * sx - t * so - public.o_tilde * e;
  let a2 = public.i_tilde * sx + u * sa - public.l * e;
  let a3 = public.r * sx - t * sb + v * sa;
  sal_challenge(m, index, &public.l, &a1, &a2, &a3) == e
}

/// Build the tree over `notes` (the admit set at the anchor, in chain order).
pub fn tree_of_notes(notes: &[ChainNote]) -> Result<ChainTree, Fs1Error> {
  let params = spend_params()?;
  let mut tree = ChainTree::new(params)?;
  tree.append_notes(params, notes)?;
  Ok(tree)
}

/// Prove a spend of `inputs` against `tree`, whose leaves are `notes`.
///
/// `notes[i]` must be the note at leaf `i`. Each input's `x` must open its
/// note: `admitPub = x·G`. Input indices must differ.
pub fn prove_spend(
  tree: &ChainTree,
  notes: &[ChainNote],
  inputs: &[SpendIn],
  body_digest: &[u8; 32],
  anchor: u64,
  threads: usize,
) -> Result<SpendOut, Fs1Error> {
  let params = spend_params()?;
  let n = inputs.len();
  if !consensus_accepts(n) || tree.len() == 0 || notes.len() as u64 != tree.len() {
    return Err(Fs1Error::InputCount);
  }
  let mut seen = Vec::with_capacity(n);
  let mut opens = Vec::with_capacity(n);
  for input in inputs {
    if seen.contains(&input.index) {
      return Err(Fs1Error::Path);
    }
    seen.push(input.index);
    let at = usize::try_from(input.index).map_err(|_| Fs1Error::Path)?;
    let note = notes.get(at).ok_or(Fs1Error::Path)?;
    let leaf = leaf_of(note).ok_or(Fs1Error::Path)?;
    if tree.leaf_bytes(input.index) != Some(leaf_bytes(&leaf)) {
      return Err(Fs1Error::Path);
    }
    if (RISTRETTO_BASEPOINT_POINT * input.x).compress().to_bytes() != note.admit_pub {
      return Err(Fs1Error::Blind);
    }
    opens.push(OpenNote { leaf_index: input.index, note_age: 0, set_size: tree.len(), note_type: NOTE_PAYMENT, anchor: [0; 32] });
  }

  let threads = threads.max(1);
  let blinds = PreparedBlinds::prepare(params, n, tree.layers(), threads)?;
  let (proved, scalars) = prove_prepared_scalars(params, tree, &opens, blinds, threads)?;
  let root = root_bytes(&proved.root);
  let h = note_h();

  let mut heads = Vec::with_capacity(n);
  let mut publics = Vec::with_capacity(n);
  let mut ts = Vec::with_capacity(n);
  for (k, input) in inputs.iter().enumerate() {
    let note = &notes[usize::try_from(input.index).map_err(|_| Fs1Error::Path)?];
    let c = canonical_ristretto(&note.commit).ok_or(Fs1Error::Blind)?;
    let c_tilde = (c - h * scalars[k].c).compress().to_bytes();
    let mut points = [0u8; 96];
    points.copy_from_slice(&proved.input_bytes[k][.. 96]);
    if ristretto_to_ed(&c_tilde).map(|p| p.to_bytes()) != Some(proved.input_bytes[k][96 ..].try_into().expect("32 bytes")) {
      return Err(Fs1Error::Blind);
    }
    let hp = hash_to_ristretto(&note.admit_pub, HP_DST);
    let tag = (hp * input.x).compress().to_bytes();
    let l = ristretto_to_ed(&tag).ok_or(Fs1Error::Blind)?;
    publics.push(SalPublic {
      o_tilde: canonical_ed(&points[.. 32]).ok_or(Fs1Error::Blind)?,
      i_tilde: canonical_ed(&points[32 .. 64]).ok_or(Fs1Error::Blind)?,
      r: canonical_ed(&points[64 ..]).ok_or(Fs1Error::Blind)?,
      l: ed(l),
    });
    heads.push(RecordHead { tag, c_tilde, points });
    ts.push(Zeroizing::new((-scalars[k].c).to_bytes()));
  }

  let m = transcript(body_digest, anchor, &root, &heads, &proved.bytes);
  let mut records = Vec::with_capacity(n);
  for (k, input) in inputs.iter().enumerate() {
    let s = &scalars[k];
    let w = SalWitness { x: input.x, o: s.o, a: input.x * s.i, b: input.x * s.ib };
    let sal = sal_prove(params, &m, u8::try_from(k).expect("k < 8"), &publics[k], &w);
    let mut record = [0u8; RECORD_BYTES];
    record[0] = SPEND_WIRE;
    record[1 .. 33].copy_from_slice(&heads[k].tag);
    record[33 .. 65].copy_from_slice(&heads[k].c_tilde);
    record[65 .. 161].copy_from_slice(&heads[k].points);
    record[161 ..].copy_from_slice(&sal);
    records.push(record);
  }

  let mut fs1 = Vec::with_capacity(SPEND_HEAD + proved.bytes.len());
  fs1.push(SPEND_WIRE);
  fs1.push(u8::try_from(tree.layers()).map_err(|_| Fs1Error::Path)?);
  fs1.push(u8::try_from(n).map_err(|_| Fs1Error::InputCount)?);
  fs1.extend_from_slice(&root);
  fs1.extend_from_slice(&proved.bytes);
  Ok(SpendOut { fs1, records, t: ts })
}

/// Largest `fs1` blob for `n` inputs at [`DEPTH`].
pub fn spend_blob_len(n: usize) -> Option<usize> {
  consensus_accepts(n).then(|| SPEND_HEAD + proof_len(n, DEPTH))
}

/// The root a spend blob names. `None` when the head is malformed.
pub fn spend_root(fs1: &[u8]) -> Option<[u8; 32]> {
  if fs1.len() < SPEND_HEAD || fs1[0] != SPEND_WIRE {
    return None;
  }
  fs1[3 .. SPEND_HEAD].try_into().ok()
}

/// Verify a spend against the node's root for `anchor`.
///
/// `root` is the FS-1 root the verifier computed for the anchor height. The
/// blob must name that root. Tags must differ within the spend; the caller
/// checks them against the chain's spent set.
pub fn verify_spend(
  fs1: &[u8],
  records: &[[u8; RECORD_BYTES]],
  root: &[u8; 32],
  body_digest: &[u8; 32],
  anchor: u64,
) -> Result<(), Fs1Error> {
  let params = spend_params()?;
  let n = records.len();
  if !consensus_accepts(n) || fs1.len() < SPEND_HEAD || fs1[0] != SPEND_WIRE {
    return Err(Fs1Error::InputCount);
  }
  if usize::from(fs1[1]) != DEPTH || usize::from(fs1[2]) != n || fs1.len() != SPEND_HEAD + proof_len(n, DEPTH) {
    return Err(Fs1Error::Io);
  }
  if fs1[3 .. SPEND_HEAD] != root[..] {
    return Err(Fs1Error::Path);
  }
  let tree_root = root_from_bytes(root, DEPTH).ok_or(Fs1Error::Path)?;
  let fcmp = &fs1[SPEND_HEAD ..];

  let mut heads = Vec::with_capacity(n);
  let mut publics = Vec::with_capacity(n);
  let mut inputs = Vec::with_capacity(n);
  let mut input_bytes = Vec::with_capacity(n);
  for record in records {
    if record[0] != SPEND_WIRE {
      return Err(Fs1Error::Io);
    }
    let tag: [u8; 32] = record[1 .. 33].try_into().expect("32 bytes");
    let c_tilde: [u8; 32] = record[33 .. 65].try_into().expect("32 bytes");
    if heads.iter().any(|h: &RecordHead| h.tag == tag) {
      return Err(Fs1Error::Verify(full_chain_membership_proofs::FcmpError::IdentityPoint));
    }
    canonical_ristretto(&tag).ok_or(Fs1Error::Blind)?;
    canonical_ristretto(&c_tilde).ok_or(Fs1Error::Blind)?;
    let l = ristretto_to_ed(&tag).ok_or(Fs1Error::Blind)?;
    let c_ed = ristretto_to_ed(&c_tilde).ok_or(Fs1Error::Blind)?;
    let o_tilde = canonical_ed(&record[65 .. 97]).ok_or(Fs1Error::Blind)?;
    let i_tilde = canonical_ed(&record[97 .. 129]).ok_or(Fs1Error::Blind)?;
    let r = canonical_ed(&record[129 .. 161]).ok_or(Fs1Error::Blind)?;
    inputs.push(
      Input::new(EdwardsPoint(o_tilde), EdwardsPoint(i_tilde), EdwardsPoint(r), c_ed).map_err(|_| Fs1Error::Blind)?,
    );
    let mut encoded = [0u8; 128];
    encoded[.. 96].copy_from_slice(&record[65 .. 161]);
    encoded[96 ..].copy_from_slice(&c_ed.to_bytes());
    input_bytes.push(encoded);
    let mut points = [0u8; 96];
    points.copy_from_slice(&record[65 .. 161]);
    heads.push(RecordHead { tag, c_tilde, points });
    publics.push(SalPublic { o_tilde, i_tilde, r, l: ed(l) });
  }

  let proved = Proved { bytes: fcmp.to_vec(), inputs, input_bytes, root: tree_root, layers: DEPTH };
  verify(params, &proved)?;

  let m = transcript(body_digest, anchor, root, &heads, fcmp);
  for (k, (record, public)) in records.iter().zip(publics.iter()).enumerate() {
    if !sal_verify(params, &m, u8::try_from(k).expect("k < 8"), public, &record[161 ..]) {
      return Err(Fs1Error::Batch);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;

  fn random_note(v: u64) -> (ChainNote, Scalar, Scalar) {
    let x = random_scalar();
    let r = random_scalar();
    let commit = (G * Scalar::from(v) + note_h() * r).compress().to_bytes();
    (ChainNote { admit_pub: (G * x).compress().to_bytes(), commit }, x, r)
  }

  fn chain(n: usize) -> (Vec<ChainNote>, Vec<(Scalar, Scalar)>) {
    let mut notes = Vec::new();
    let mut keys = Vec::new();
    for i in 0 .. n {
      let (note, x, r) = random_note(1000 + i as u64);
      notes.push(note);
      keys.push((x, r));
    }
    (notes, keys)
  }

  #[test]
  fn note_h_matches_shear_admit() {
    // crypto/native_admit.js noteH(), the BP+ blinding generator.
    assert_eq!(
      crate::vectors::hex(&note_h().compress().to_bytes()),
      include_str!("../vectors/note_h.txt").trim()
    );
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn spend_proves_verifies_and_keeps_value() {
    let (notes, keys) = chain(50);
    let tree = tree_of_notes(&notes).expect("tree");
    let root = tree.root_bytes();
    let digest = [9u8; 32];
    let picks = [3usize, 41];
    let inputs: Vec<SpendIn> = picks.iter().map(|&i| SpendIn { index: i as u64, x: keys[i].0 }).collect();
    let out = prove_spend(&tree, &notes, &inputs, &digest, 64, 2).expect("prove");
    assert_eq!(out.records.len(), 2);
    assert_eq!(out.fs1.len(), spend_blob_len(2).unwrap());
    verify_spend(&out.fs1, &out.records, &root, &digest, 64).expect("verify");

    for (k, &i) in picks.iter().enumerate() {
      let c = CompressedRistretto(notes[i].commit).decompress().unwrap();
      let ct = CompressedRistretto(out.records[k][33 .. 65].try_into().unwrap()).decompress().unwrap();
      let t = Scalar::from_canonical_bytes(*out.t[k]).unwrap();
      assert_eq!(ct, c + note_h() * t, "C̃ = C + t·H");
      let tag = hash_to_ristretto(&notes[i].admit_pub, HP_DST) * keys[i].0;
      assert_eq!(&out.records[k][1 .. 33], &tag.compress().to_bytes());
    }

    assert!(verify_spend(&out.fs1, &out.records, &root, &[8u8; 32], 64).is_err(), "other digest");
    assert!(verify_spend(&out.fs1, &out.records, &root, &digest, 72).is_err(), "other anchor");
    let mut swapped = out.records.clone();
    swapped.swap(0, 1);
    assert!(verify_spend(&out.fs1, &swapped, &root, &digest, 64).is_err(), "input order");
    let mut bad_tag = out.records.clone();
    let other = hash_to_ristretto(&notes[0].admit_pub, HP_DST) * keys[0].0;
    bad_tag[0][1 .. 33].copy_from_slice(&other.compress().to_bytes());
    assert!(verify_spend(&out.fs1, &bad_tag, &root, &digest, 64).is_err(), "foreign tag");
    let mut bad_c = out.records.clone();
    let shifted = CompressedRistretto(bad_c[0][33 .. 65].try_into().unwrap()).decompress().unwrap() + G;
    bad_c[0][33 .. 65].copy_from_slice(&shifted.compress().to_bytes());
    assert!(verify_spend(&out.fs1, &bad_c, &root, &digest, 64).is_err(), "value shift");

    let mut more = notes.clone();
    more.push(random_note(5).0);
    let other_root = tree_of_notes(&more).unwrap().root_bytes();
    assert!(verify_spend(&out.fs1, &out.records, &other_root, &digest, 64).is_err(), "other root");
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn wrong_key_or_foreign_note_does_not_prove() {
    let (notes, keys) = chain(10);
    let tree = tree_of_notes(&notes).unwrap();
    let bad = [SpendIn { index: 2, x: keys[3].0 }];
    assert!(prove_spend(&tree, &notes, &bad, &[0; 32], 8, 1).is_err());
    let dup = [SpendIn { index: 2, x: keys[2].0 }, SpendIn { index: 2, x: keys[2].0 }];
    assert!(prove_spend(&tree, &notes, &dup, &[0; 32], 8, 1).is_err());
    let none: [SpendIn; 0] = [];
    assert!(prove_spend(&tree, &notes, &none, &[0; 32], 8, 1).is_err());
  }

  #[test]
  fn non_leaf_notes_do_not_enter_the_tree() {
    let (mut notes, _) = chain(3);
    notes[1].commit = [0; 32];
    assert!(matches!(tree_of_notes(&notes), Err(Fs1Error::Path)));
  }

  #[test]
  fn sal_rejects_a_forged_tag_relation() {
    let params = spend_params().unwrap();
    let x = random_scalar();
    let (o, i, ib) = (random_scalar(), random_scalar(), random_scalar());
    let leaf_i = ED25519_BASEPOINT_POINT * random_scalar();
    let (t, u, v) = (ed(params.t), ed(params.u), ed(params.v));
    let public = SalPublic {
      o_tilde: ED25519_BASEPOINT_POINT * x - t * o,
      i_tilde: leaf_i - u * i,
      r: t * ib - v * i,
      l: leaf_i * x,
    };
    let w = SalWitness { x, o, a: x * i, b: x * ib };
    let m = [3u8; 64];
    let proof = sal_prove(params, &m, 0, &public, &w);
    assert!(sal_verify(params, &m, 0, &public, &proof));
    assert!(!sal_verify(params, &m, 1, &public, &proof));
    let forged = SalPublic { l: leaf_i * (x + Scalar::ONE), ..public };
    assert!(!sal_verify(params, &m, 0, &forged, &proof));
  }
}
