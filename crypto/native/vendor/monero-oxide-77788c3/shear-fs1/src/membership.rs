//! Fixed-depth membership proofs.
//!
//! Depth is 7. The serialised proof length is `Fcmp::proof_size(inputs, 7)`.
//! Leaf index, note age, set size, note type, and the anchor sit in a
//! fixed-width statement. They do not change that length.
//!
//! Secret scalars go through `multiexp::multiexp` 0.5.2 inside the vendored
//! prover. Layer hashes in this crate use the same constant-time multiexp.
//! The upstream `tree::hash_grow` helper is not called: it multiplies public
//! scalars with a variable-time multiexp. The batch check inside
//! `Generators::verify` is the verifier's public check.
//!
//! `insecure_test_generators` builds the curve parameters. Those parameters
//! are for this unwired crate. They are not consensus generators.

use ciphersuite::{
  group::{
    ff::{Field, PrimeField, PrimeFieldBits},
    Group,
  },
  Ciphersuite,
};
use dalek_ff_group::Ed25519;
use ec_divisors::{DivisorCurve, ScalarDecomposition};
use full_chain_membership_proofs::{
  BranchBlind, Branches, CBlind, Fcmp, FcmpCurves, FcmpError, FcmpParams, IBlind, IBlindBlind,
  Input, OBlind, Output, OutputBlinds, Path, TreeRoot, LAYER_ONE_LEN, LAYER_TWO_LEN,
};
use generalized_bulletproofs::{tests::insecure_test_generators, Generators};
use generalized_bulletproofs_ec_gadgets::DiscreteLogParameter;
use generic_array::typenum::U;
use helioselene::{Helios, Selene};
use multiexp::multiexp;
use rand_core::{CryptoRng, OsRng, RngCore};
use subtle::{ConditionallySelectable, ConstantTimeEq};
use zeroize::Zeroize;

use crate::rulings::consensus_accepts;

/// Curve-tree depth. Proof length depends on this and the input count.
pub const DEPTH: usize = 7;

/// Payment note type.
pub const NOTE_PAYMENT: u8 = 0x02;
/// Change note type.
pub const NOTE_CHANGE: u8 = 0x03;

/// Bytes in one note's statement: leaf index, age, set size, type, anchor.
pub const STATEMENT_LEN: usize = 8 + 8 + 8 + 1 + 32;

/// How many layer slots a full-scan select always touches on the first layer.
pub const LEAF_SCAN: usize = LAYER_ONE_LEN;

type EdG = <Ed25519 as Ciphersuite>::G;
type SeleneF = <Selene as Ciphersuite>::F;
type HeliosF = <Helios as Ciphersuite>::F;

struct EdBits;
impl DiscreteLogParameter for EdBits {
  #[allow(clippy::cast_possible_truncation)]
  type ScalarBits = U<{ <<Ed25519 as Ciphersuite>::F as PrimeField>::NUM_BITS as usize }>;
}

struct SeleneBits;
impl DiscreteLogParameter for SeleneBits {
  #[allow(clippy::cast_possible_truncation)]
  type ScalarBits = U<{ <<Selene as Ciphersuite>::F as PrimeField>::NUM_BITS as usize }>;
}

struct HeliosBits;
impl DiscreteLogParameter for HeliosBits {
  #[allow(clippy::cast_possible_truncation)]
  type ScalarBits = U<{ <<Helios as Ciphersuite>::F as PrimeField>::NUM_BITS as usize }>;
}

struct ShearCurves;
impl FcmpCurves for ShearCurves {
  type OC = Ed25519;
  type OcParameters = EdBits;
  type C1 = Selene;
  type C1Parameters = SeleneBits;
  type C2 = Helios;
  type C2Parameters = HeliosBits;
}

/// One note opened by the wallet that already holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenNote {
  /// Position of the note in the set. The proof length does not depend on it.
  pub leaf_index: u64,
  /// Blocks since the note was created. The proof length does not depend on it.
  pub note_age: u64,
  /// Size of the set the note is a member of. The proof length does not depend on it.
  pub set_size: u64,
  /// `0x02` or `0x03`.
  pub note_type: u8,
  /// Anchor the wallet folded from verified headers.
  pub anchor: [u8; 32],
}

impl OpenNote {
  /// Fixed-width encoding. Every accepted note occupies [`STATEMENT_LEN`] bytes.
  pub fn encode(self) -> [u8; STATEMENT_LEN] {
    let mut out = [0u8; STATEMENT_LEN];
    out[.. 8].copy_from_slice(&self.leaf_index.to_le_bytes());
    out[8 .. 16].copy_from_slice(&self.note_age.to_le_bytes());
    out[16 .. 24].copy_from_slice(&self.set_size.to_le_bytes());
    out[24] = self.note_type;
    out[25 ..].copy_from_slice(&self.anchor);
    out
  }
}

/// A membership proof plus the public inputs a verifier needs.
pub struct Proved {
  /// Serialised FCMP. Its length is [`proof_len`] for this input count and depth.
  pub bytes: Vec<u8>,
  /// Re-randomised input tuples. Fresh blinds make these differ across proves.
  pub inputs: Vec<Input<SeleneF>>,
  /// Tree root the proof opens.
  pub root: TreeRoot<Selene, Helios>,
  /// Layer count used to build the proof.
  pub layers: usize,
  /// Concatenated fixed-width statements, one per input.
  pub statement: Vec<u8>,
}

/// Test parameters. Not a consensus generator set.
pub struct Fs1Params {
  g: EdG,
  t: EdG,
  u: EdG,
  v: EdG,
  c1: Generators<Selene>,
  c2: Generators<Helios>,
  c1_init: <Selene as Ciphersuite>::G,
  c2_init: <Helios as Ciphersuite>::G,
  fcmp: FcmpParams<ShearCurves>,
}

/// Failure while building or checking a membership proof.
#[derive(Debug)]
pub enum Fs1Error {
  /// The input count is outside 1..=8, or the layer count is zero.
  InputCount,
  /// A note type was neither `0x02` nor `0x03`.
  NoteType,
  /// A blind or a point was unusable.
  Blind,
  /// The paths did not share one tree.
  Path,
  /// The vendored prover rejected the witness.
  Prove(FcmpError),
  /// The vendored verifier rejected the proof.
  Verify(FcmpError),
  /// The public batch check on the test generators failed.
  Batch,
  /// Reading or writing the proof failed.
  Io,
}

struct BlindScalars {
  o: <Ed25519 as Ciphersuite>::F,
  i: <Ed25519 as Ciphersuite>::F,
  ib: <Ed25519 as Ciphersuite>::F,
  c: <Ed25519 as Ciphersuite>::F,
}

impl Drop for BlindScalars {
  fn drop(&mut self) {
    self.o.zeroize();
    self.i.zeroize();
    self.ib.zeroize();
    self.c.zeroize();
  }
}

impl Fs1Params {
  /// Build test parameters that can prove up to `input_limit` inputs.
  ///
  /// The generator counts follow the upstream test harness:
  /// `2 * input_limit * 256` on the first curve and `2 * input_limit * 128` on the second.
  pub fn open(input_limit: usize) -> Result<Self, Fs1Error> {
    if !consensus_accepts(input_limit) {
      return Err(Fs1Error::InputCount);
    }
    let mut rng = OsRng;
    let g = nonzero_point(&mut rng);
    let t = nonzero_point(&mut rng);
    let u = nonzero_point(&mut rng);
    let v = nonzero_point(&mut rng);
    let c1 = insecure_test_generators::<_, Selene>(&mut rng, 2 * input_limit * 256)
      .map_err(|_| Fs1Error::Blind)?;
    let c2 = insecure_test_generators::<_, Helios>(&mut rng, 2 * input_limit * 128)
      .map_err(|_| Fs1Error::Blind)?;
    let c1_init = <Selene as Ciphersuite>::G::random(&mut rng);
    let c2_init = <Helios as Ciphersuite>::G::random(&mut rng);
    let fcmp = FcmpParams::<ShearCurves>::new(
      c1.clone(),
      c2.clone(),
      c1_init,
      c2_init,
      g,
      t,
      u,
      v,
    );
    Ok(Self { g, t, u, v, c1, c2, c1_init, c2_init, fcmp })
  }
}

fn nonzero_point(rng: &mut OsRng) -> EdG {
  let mut point = EdG::identity();
  for _ in 0 .. 8 {
    let next = EdG::random(&mut *rng);
    let keep = point.is_identity();
    point = EdG::conditional_select(&point, &next, keep);
  }
  point
}

/// Serialised FCMP length for this many inputs at this depth.
pub fn proof_len(inputs: usize, layers: usize) -> usize {
  Fcmp::<ShearCurves>::proof_size(inputs, layers)
}

/// Prove membership of `notes` at `layers`.
///
/// Blinds come from the operating system's RNG. The same notes proved twice
/// differ in bytes and match in length.
pub fn prove(params: &Fs1Params, notes: &[OpenNote], layers: usize) -> Result<Proved, Fs1Error> {
  if !consensus_accepts(notes.len()) || layers == 0 {
    return Err(Fs1Error::InputCount);
  }
  for note in notes {
    if note.note_type != NOTE_PAYMENT && note.note_type != NOTE_CHANGE {
      return Err(Fs1Error::NoteType);
    }
  }

  let mut rng = OsRng;
  let mut paths = Vec::with_capacity(notes.len());
  for (i, note) in notes.iter().enumerate() {
    let slot = if layers == 1 {
      u32::try_from(i).unwrap_or(0)
    } else {
      u32::try_from(note.leaf_index % u64::try_from(LAYER_ONE_LEN).unwrap_or(1)).unwrap_or(0)
    };
    paths.push(one_path(&mut rng, params, note, layers, slot)?);
  }
  let root = unify(params, &mut paths, layers)?;
  let outputs: Vec<Output<EdG>> = paths.iter().map(|path| path.output).collect();
  let branches = Branches::new(paths).ok_or(Fs1Error::Path)?;

  let mut output_blinds = Vec::with_capacity(notes.len());
  let mut opened = Vec::with_capacity(notes.len());
  for output in &outputs {
    let (blinds, scalars) = fresh_output_blinds(&mut rng, params);
    opened.push(open_input(output, &scalars, params)?);
    output_blinds.push(blinds);
  }

  let mut c1_blinds = Vec::with_capacity(branches.necessary_c1_blinds());
  for _ in 0 .. branches.necessary_c1_blinds() {
    c1_blinds.push(BranchBlind::<<Selene as Ciphersuite>::G>::new(
      params.c1.h(),
      nonzero_decomposition(&mut rng),
    ));
  }
  let mut c2_blinds = Vec::with_capacity(branches.necessary_c2_blinds());
  for _ in 0 .. branches.necessary_c2_blinds() {
    c2_blinds.push(BranchBlind::<<Helios as Ciphersuite>::G>::new(
      params.c2.h(),
      nonzero_decomposition(&mut rng),
    ));
  }

  let blinded = branches.blind(output_blinds, c1_blinds, c2_blinds).map_err(Fs1Error::Prove)?;
  let proof = Fcmp::<ShearCurves>::prove(&mut rng, &params.fcmp, blinded).map_err(Fs1Error::Prove)?;
  let mut bytes = Vec::new();
  proof.write(&mut bytes).map_err(|_| Fs1Error::Io)?;
  if bytes.len() != proof_len(notes.len(), layers) {
    return Err(Fs1Error::Io);
  }

  let mut statement = Vec::with_capacity(notes.len() * STATEMENT_LEN);
  for note in notes {
    statement.extend_from_slice(&note.encode());
  }
  Ok(Proved { bytes, inputs: opened, root, layers, statement })
}

/// Verify a proof produced by [`prove`] against the same test parameters.
pub fn verify(params: &Fs1Params, proved: &Proved) -> Result<(), Fs1Error> {
  if proved.bytes.len() != proof_len(proved.inputs.len(), proved.layers) {
    return Err(Fs1Error::Io);
  }
  let proof = Fcmp::<ShearCurves>::read(&mut proved.bytes.as_slice(), proved.inputs.len(), proved.layers)
    .map_err(|_| Fs1Error::Io)?;
  let mut verifier_1 = Generators::<Selene>::batch_verifier();
  let mut verifier_2 = Generators::<Helios>::batch_verifier();
  proof
    .verify(
      &mut OsRng,
      &mut verifier_1,
      &mut verifier_2,
      &params.fcmp,
      proved.root,
      proved.layers,
      &proved.inputs,
    )
    .map_err(Fs1Error::Verify)?;
  if !params.c1.verify(verifier_1) || !params.c2.verify(verifier_2) {
    return Err(Fs1Error::Batch);
  }
  Ok(())
}

fn one_path(
  rng: &mut OsRng,
  params: &Fs1Params,
  note: &OpenNote,
  layers: usize,
  slot: u32,
) -> Result<Path<ShearCurves>, Fs1Error> {
  let output = note_output(note)?;
  let mut leaves = Vec::with_capacity(LAYER_ONE_LEN);
  for _ in 0 .. LAYER_ONE_LEN {
    leaves.push(random_output(rng)?);
  }
  place_output(&mut leaves, output, slot);

  let mut selene_hash = Some(hash_layer(&params.c1, params.c1_init, &leaf_scalars(&leaves)));
  let mut curve_2_layers = Vec::new();
  let mut curve_1_layers = Vec::new();

  while 1 + curve_1_layers.len() + curve_2_layers.len() < layers {
    let mut layer = Vec::with_capacity(LAYER_TWO_LEN);
    for _ in 0 .. LAYER_TWO_LEN {
      layer.push(HeliosF::random(&mut *rng));
    }
    let child = <Selene as Ciphersuite>::G::to_xy(selene_hash.take().ok_or(Fs1Error::Path)?)
      .ok_or(Fs1Error::Blind)?
      .0;
    place_field(&mut layer, child, 0);
    let helios_hash = hash_layer(&params.c2, params.c2_init, &layer);
    curve_2_layers.push(layer);

    if 1 + curve_1_layers.len() + curve_2_layers.len() < layers {
      let mut layer = Vec::with_capacity(LAYER_ONE_LEN);
      for _ in 0 .. LAYER_ONE_LEN {
        layer.push(SeleneF::random(&mut *rng));
      }
      let child = <Helios as Ciphersuite>::G::to_xy(helios_hash).ok_or(Fs1Error::Blind)?.0;
      place_field(&mut layer, child, 0);
      selene_hash = Some(hash_layer(&params.c1, params.c1_init, &layer));
      curve_1_layers.push(layer);
    }
  }

  Ok(Path { output, leaves, curve_2_layers, curve_1_layers })
}

fn unify(
  params: &Fs1Params,
  paths: &mut [Path<ShearCurves>],
  layers: usize,
) -> Result<TreeRoot<Selene, Helios>, Fs1Error> {
  if paths.len() == 1 {
    return fold_root(params, &paths[0]);
  }
  if layers == 1 {
    let mut leaves = paths[0].leaves.clone();
    for (i, path) in paths.iter().enumerate() {
      place_output(&mut leaves, path.output, u32::try_from(i).unwrap_or(0));
    }
    for path in paths.iter_mut() {
      path.leaves.clone_from(&leaves);
    }
    return fold_root(params, &paths[0]);
  }
  if layers % 2 == 0 {
    let mut children = Vec::with_capacity(paths.len());
    for path in paths.iter() {
      let hash = if let Some(layer) = path.curve_1_layers.last() {
        hash_layer(&params.c1, params.c1_init, layer)
      } else {
        hash_layer(&params.c1, params.c1_init, &leaf_scalars(&path.leaves))
      };
      children.push(<Selene as Ciphersuite>::G::to_xy(hash).ok_or(Fs1Error::Blind)?.0);
    }
    let mut shared = Vec::with_capacity(LAYER_TWO_LEN);
    for _ in 0 .. LAYER_TWO_LEN {
      shared.push(HeliosF::random(&mut OsRng));
    }
    for (i, child) in children.iter().enumerate() {
      place_field(&mut shared, *child, u32::try_from(i).unwrap_or(0));
    }
    for path in paths.iter_mut() {
      *path.curve_2_layers.last_mut().ok_or(Fs1Error::Path)? = shared.clone();
    }
    Ok(TreeRoot::C2(hash_layer(&params.c2, params.c2_init, &shared)))
  } else {
    let mut children = Vec::with_capacity(paths.len());
    for path in paths.iter() {
      let layer = path.curve_2_layers.last().ok_or(Fs1Error::Path)?;
      let hash = hash_layer(&params.c2, params.c2_init, layer);
      children.push(<Helios as Ciphersuite>::G::to_xy(hash).ok_or(Fs1Error::Blind)?.0);
    }
    let mut shared = Vec::with_capacity(LAYER_ONE_LEN);
    for _ in 0 .. LAYER_ONE_LEN {
      shared.push(SeleneF::random(&mut OsRng));
    }
    for (i, child) in children.iter().enumerate() {
      place_field(&mut shared, *child, u32::try_from(i).unwrap_or(0));
    }
    for path in paths.iter_mut() {
      *path.curve_1_layers.last_mut().ok_or(Fs1Error::Path)? = shared.clone();
    }
    Ok(TreeRoot::C1(hash_layer(&params.c1, params.c1_init, &shared)))
  }
}

fn fold_root(
  params: &Fs1Params,
  path: &Path<ShearCurves>,
) -> Result<TreeRoot<Selene, Helios>, Fs1Error> {
  let mut selene = Some(hash_layer(&params.c1, params.c1_init, &leaf_scalars(&path.leaves)));
  let mut helios = None;
  let rounds = path.curve_1_layers.len().max(path.curve_2_layers.len());
  for i in 0 .. rounds {
    if i < path.curve_2_layers.len() {
      helios = Some(hash_layer(&params.c2, params.c2_init, &path.curve_2_layers[i]));
      selene = None;
    }
    if i < path.curve_1_layers.len() {
      selene = Some(hash_layer(&params.c1, params.c1_init, &path.curve_1_layers[i]));
      helios = None;
    }
  }
  if let Some(point) = selene {
    Ok(TreeRoot::C1(point))
  } else {
    Ok(TreeRoot::C2(helios.ok_or(Fs1Error::Path)?))
  }
}

fn note_output(note: &OpenNote) -> Result<Output<EdG>, Fs1Error> {
  let msg = note.encode();
  let o = Ed25519::generator() * Ed25519::hash_to_F(b"shear-fs1-O", &msg);
  let i = Ed25519::generator() * Ed25519::hash_to_F(b"shear-fs1-I", &msg);
  let c = Ed25519::generator() * Ed25519::hash_to_F(b"shear-fs1-C", &msg);
  Output::new(o, i, c).map_err(|_| Fs1Error::Blind)
}

fn random_output(rng: &mut OsRng) -> Result<Output<EdG>, Fs1Error> {
  Output::new(EdG::random(&mut *rng), EdG::random(&mut *rng), EdG::random(&mut *rng))
    .map_err(|_| Fs1Error::Blind)
}

fn leaf_scalars(leaves: &[Output<EdG>]) -> Vec<SeleneF> {
  let mut out = Vec::with_capacity(leaves.len() * 6);
  for leaf in leaves {
    let (ox, oy) = EdG::to_xy(leaf.O()).expect("leaf point is not identity");
    let (ix, iy) = EdG::to_xy(leaf.I()).expect("leaf point is not identity");
    let (cx, cy) = EdG::to_xy(leaf.C()).expect("leaf point is not identity");
    out.extend([ox, oy, ix, iy, cx, cy]);
  }
  out
}

/// Public layer hash. Every child is included. The scalar list length is public.
fn hash_layer<C: Ciphersuite>(generators: &Generators<C>, init: C::G, children: &[C::F]) -> C::G
where
  C::G: zeroize::Zeroize + ConditionallySelectable,
  C::F: zeroize::Zeroize + PrimeFieldBits,
{
  let pairs: Vec<(C::F, C::G)> = children
    .iter()
    .copied()
    .zip(generators.g_bold_slice().iter().copied())
    .map(|(scalar, point)| (scalar, point))
    .collect();
  init + multiexp(&pairs)
}

/// Full-scan select. Every slot is visited. There is no early return.
fn place_output(leaves: &mut [Output<EdG>], spent: Output<EdG>, slot: u32) {
  debug_assert_eq!(leaves.len(), LEAF_SCAN);
  for (i, leaf) in leaves.iter_mut().enumerate() {
    let pick = u32::ct_eq(&(i as u32), &slot);
    let o = EdG::conditional_select(&leaf.O(), &spent.O(), pick);
    let image = EdG::conditional_select(&leaf.I(), &spent.I(), pick);
    let c = EdG::conditional_select(&leaf.C(), &spent.C(), pick);
    *leaf = Output::new(o, image, c).expect("selected leaf stayed on curve");
  }
}

fn place_field<F: ConditionallySelectable + Copy>(layer: &mut [F], child: F, slot: u32) {
  for (i, item) in layer.iter_mut().enumerate() {
    let pick = u32::ct_eq(&(i as u32), &slot);
    *item = F::conditional_select(item, &child, pick);
  }
}

fn nonzero_decomposition<F>(rng: &mut (impl RngCore + CryptoRng)) -> ScalarDecomposition<F>
where
  F: Copy + zeroize::Zeroize + PrimeFieldBits,
{
  for _ in 0 .. 8 {
    let scalar = F::random(&mut *rng);
    if let Some(decomp) = ScalarDecomposition::new(scalar) {
      return decomp;
    }
  }
  let scalar = F::random(&mut *rng);
  ScalarDecomposition::new(scalar).expect("a fresh scalar was zero eight times")
}

fn fresh_output_blinds(
  rng: &mut OsRng,
  params: &Fs1Params,
) -> (OutputBlinds<EdG>, BlindScalars) {
  let o = nonzero_scalar(rng);
  let i = nonzero_scalar(rng);
  let ib = nonzero_scalar(rng);
  let c = nonzero_scalar(rng);
  let blinds = OutputBlinds::new(
    OBlind::new(params.t, ScalarDecomposition::new(o).expect("nonzero")),
    IBlind::new(params.u, params.v, ScalarDecomposition::new(i).expect("nonzero")),
    IBlindBlind::new(params.t, ScalarDecomposition::new(ib).expect("nonzero")),
    CBlind::new(params.g, ScalarDecomposition::new(c).expect("nonzero")),
  );
  (blinds, BlindScalars { o, i, ib, c })
}

fn nonzero_scalar(rng: &mut OsRng) -> <Ed25519 as Ciphersuite>::F {
  let mut scalar = <Ed25519 as Ciphersuite>::F::ZERO;
  for _ in 0 .. 8 {
    let next = <Ed25519 as Ciphersuite>::F::random(&mut *rng);
    let keep = scalar.is_zero();
    scalar = <Ed25519 as Ciphersuite>::F::conditional_select(&scalar, &next, keep);
  }
  scalar
}

fn open_input(
  output: &Output<EdG>,
  blinds: &BlindScalars,
  params: &Fs1Params,
) -> Result<Input<SeleneF>, Fs1Error> {
  // input = output - blind, so the circuit can add the blind back.
  // R is I's blind-of-a-blind minus I's V blind. Same formula for every note.
  let o_tilde = output.O() - (params.t * blinds.o);
  let i_tilde = output.I() - (params.u * blinds.i);
  let c_tilde = output.C() - (params.g * blinds.c);
  let r = (params.t * blinds.ib) - (params.v * blinds.i);
  Input::new(o_tilde, i_tilde, r, c_tilde).map_err(|_| Fs1Error::Blind)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn note(leaf: u64, age: u64, set_size: u64, note_type: u8) -> OpenNote {
    OpenNote { leaf_index: leaf, note_age: age, set_size, note_type, anchor: [7; 32] }
  }

  #[test]
  fn statement_width_ignores_leaf_age_set_and_type() {
    let samples = [
      note(0, 0, 1, NOTE_PAYMENT),
      note(19, 0, 1, NOTE_PAYMENT),
      note(u64::from(u32::MAX), 0, 1, NOTE_CHANGE),
      note(0, 0, 1, NOTE_PAYMENT),
      note(0, 100_000, 1, NOTE_PAYMENT),
      note(0, 0, 1, NOTE_PAYMENT),
      note(0, 0, 1 << 10, NOTE_PAYMENT),
      note(0, 0, 1 << 20, NOTE_CHANGE),
      note(4, 3, 9, 0x02),
      note(4, 3, 9, 0x03),
    ];
    let lens: Vec<usize> = samples.iter().map(|n| n.encode().len()).collect();
    assert!(lens.iter().all(|len| *len == STATEMENT_LEN));
    assert_ne!(samples[0].encode(), samples[2].encode());
    assert_ne!(samples[8].encode(), samples[9].encode());
  }

  #[test]
  fn proof_length_depends_only_on_input_count_at_depth_7() {
    for inputs in 1 ..= 8 {
      let len = proof_len(inputs, DEPTH);
      assert_eq!(proof_len(inputs, DEPTH), len);
      assert!(len > 64, "{inputs} {len}");
    }
    assert_ne!(proof_len(1, DEPTH), proof_len(2, DEPTH));
    assert_ne!(proof_len(2, DEPTH), proof_len(4, DEPTH));
    assert_ne!(proof_len(4, DEPTH), proof_len(8, DEPTH));
  }

  fn params_1() -> &'static Fs1Params {
    use std::sync::OnceLock;
    static CELL: OnceLock<Fs1Params> = OnceLock::new();
    CELL.get_or_init(|| Fs1Params::open(1).expect("params"))
  }

  #[test]
  fn rejected_note_type_and_input_count() {
    let params = params_1();
    let bad = note(0, 0, 1, 0x01);
    assert!(matches!(prove(params, &[bad], 1), Err(Fs1Error::NoteType)));
    assert!(matches!(prove(params, &[], 1), Err(Fs1Error::InputCount)));
    let nine = vec![note(0, 0, 1, NOTE_PAYMENT); 9];
    assert!(matches!(Fs1Params::open(9), Err(Fs1Error::InputCount)));
    assert!(matches!(prove(params, &nine, 1), Err(Fs1Error::InputCount)));
    assert!(matches!(prove(params, &nine[.. 1], 0), Err(Fs1Error::InputCount)));
  }

  #[test]
  fn one_layer_length_is_stable_across_the_statement_matrix() {
    let params = params_1();
    let variants = [
      note(0, 0, 1, NOTE_PAYMENT),
      note(18, 7, 1 << 10, NOTE_CHANGE),
      note(u64::from(u32::MAX), 100_000, 1 << 20, NOTE_PAYMENT),
    ];
    let mut lengths = Vec::new();
    for variant in variants {
      let proved = prove(params, &[variant], 1).expect("prove");
      verify(params, &proved).expect("verify");
      assert_eq!(proved.statement.len(), STATEMENT_LEN);
      lengths.push(proved.bytes.len());
    }
    assert!(lengths.iter().all(|len| *len == lengths[0]));
    assert_eq!(lengths[0], proof_len(1, 1));
  }
}
