//! Fixed-depth membership proofs over a real curve tree.
//!
//! Depth is 7. The serialised proof length is `Fcmp::proof_size(inputs, 7)`.
//! The private witness (leaf index, note age, set size, note type, anchor) is
//! never part of [`Proved`]. It must never be published.
//!
//! Every tree node is full width. A slot past the last real child holds the
//! empty value for that level, so every path has the same shape and the
//! vendored prover never takes its partial-path branch.
//!
//! Secret scalars go through `multiexp::multiexp` 0.5.2 inside the vendored
//! prover. Layer hashes in this crate use the same constant-time multiexp.
//! The upstream `tree::hash_grow` helper is not called: it uses a
//! variable-time multiexp. The batch check inside `Generators::verify` is the
//! verifier's public check.
//!
//! [`Fs1Params::fixed`] builds the curve parameters from the fixed derivation
//! in [`crate::generators`]. Status: pending PA+CA ratification. It is not a
//! ratified consensus set. [`Fs1Params::open`] builds them from the upstream
//! insecure test generators and exists only under `cfg(test)` or the
//! `insecure-test-generators` feature. Those test generators are never a
//! consensus set.
//!
//! [`prove`] runs on the calling thread. [`prove_threaded`] and
//! [`prove_prepared`] spread the paths and the blind divisors over a fixed
//! number of scoped threads. The split depends only on the input count and the
//! thread count. The vendored `Fcmp::prove` always runs on the calling thread.

use ciphersuite::{
  group::{
    ff::{Field, PrimeField, PrimeFieldBits},
    Group, GroupEncoding,
  },
  Ciphersuite,
};
use dalek_ff_group::Ed25519;
use ec_divisors::{DivisorCurve, ScalarDecomposition};
use full_chain_membership_proofs::{
  BranchBlind, Branches, CBlind, Fcmp, FcmpCurves, FcmpError, FcmpParams, IBlind, IBlindBlind,
  Input, OBlind, Output, OutputBlinds, Path, TreeRoot, LAYER_ONE_LEN, LAYER_TWO_LEN,
};
use generalized_bulletproofs::Generators;
use generalized_bulletproofs_ec_gadgets::DiscreteLogParameter;
use generic_array::typenum::U;
use helioselene::{Helios, Selene};
use multiexp::multiexp;
use rand_core::{CryptoRng, OsRng, RngCore};
use subtle::{Choice, ConditionallySelectable, ConstantTimeEq, ConstantTimeLess};
use zeroize::Zeroize;

use crate::generators::{ed25519_point, fixed_set};
use crate::rulings::consensus_accepts;

/// Curve-tree depth. Proof length depends on this and the input count.
pub const DEPTH: usize = 7;

/// Payment note type.
pub const NOTE_PAYMENT: u8 = 0x02;
/// Change note type.
pub const NOTE_CHANGE: u8 = 0x03;

/// How many slots a full-scan select always touches on the first layer.
pub const LEAF_SCAN: usize = LAYER_ONE_LEN;

pub(crate) type EdG = <Ed25519 as Ciphersuite>::G;
pub(crate) type EdF = <Ed25519 as Ciphersuite>::F;
pub(crate) type SeleneF = <Selene as Ciphersuite>::F;
pub(crate) type HeliosF = <Helios as Ciphersuite>::F;
pub(crate) type SeleneG = <Selene as Ciphersuite>::G;
pub(crate) type HeliosG = <Helios as Ciphersuite>::G;

/// Scalar bit width of Ed25519.
pub struct EdBits;
impl DiscreteLogParameter for EdBits {
  #[allow(clippy::cast_possible_truncation)]
  type ScalarBits = U<{ <<Ed25519 as Ciphersuite>::F as PrimeField>::NUM_BITS as usize }>;
}

/// Scalar bit width of Selene.
pub struct SeleneBits;
impl DiscreteLogParameter for SeleneBits {
  #[allow(clippy::cast_possible_truncation)]
  type ScalarBits = U<{ <<Selene as Ciphersuite>::F as PrimeField>::NUM_BITS as usize }>;
}

/// Scalar bit width of Helios.
pub struct HeliosBits;
impl DiscreteLogParameter for HeliosBits {
  #[allow(clippy::cast_possible_truncation)]
  type ScalarBits = U<{ <<Helios as Ciphersuite>::F as PrimeField>::NUM_BITS as usize }>;
}

/// The curve cycle: Ed25519 outputs, Selene and Helios layers.
pub struct ShearCurves;
impl FcmpCurves for ShearCurves {
  type OC = Ed25519;
  type OcParameters = EdBits;
  type C1 = Selene;
  type C1Parameters = SeleneBits;
  type C2 = Helios;
  type C2Parameters = HeliosBits;
}

/// One note opened by the wallet that already holds it.
///
/// This is the private statement. None of it is copied into [`Proved`], and
/// it must never be published or sent to a node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenNote {
  /// Position of the note in the tree. The proof length does not depend on it.
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

/// Bytes in one note's private statement.
#[cfg(test)]
pub(crate) const WITNESS_LEN: usize = 8 + 8 + 8 + 1 + 32;

#[cfg(test)]
impl OpenNote {
  /// Fixed-width private encoding. Used only inside the prover's process.
  pub(crate) fn witness_bytes(self) -> [u8; WITNESS_LEN] {
    let mut out = [0u8; WITNESS_LEN];
    out[.. 8].copy_from_slice(&self.leaf_index.to_le_bytes());
    out[8 .. 16].copy_from_slice(&self.note_age.to_le_bytes());
    out[16 .. 24].copy_from_slice(&self.set_size.to_le_bytes());
    out[24] = self.note_type;
    out[25 ..].copy_from_slice(&self.anchor);
    out
  }
}

/// A membership proof plus the public inputs a verifier needs. Nothing else.
pub struct Proved {
  /// Serialised FCMP. Its length is [`proof_len`] for this input count and depth.
  pub bytes: Vec<u8>,
  /// Re-randomised input tuples. Fresh blinds make these differ across proves.
  pub inputs: Vec<Input<SeleneF>>,
  /// Compressed `O~ || I~ || R || C~` for each input, in the order of `inputs`.
  pub input_bytes: Vec<[u8; 128]>,
  /// Tree root the proof opens.
  pub root: TreeRoot<Selene, Helios>,
  /// Layer count used to build the proof.
  pub layers: usize,
}

impl Proved {
  /// Everything this proof would put on the wire: proof, inputs, and root.
  pub fn public_bytes(&self) -> Vec<u8> {
    let mut out = self.bytes.clone();
    for input in &self.input_bytes {
      out.extend_from_slice(input);
    }
    out.extend_from_slice(&root_bytes(&self.root));
    out
  }
}

/// Compressed root point.
pub fn root_bytes(root: &TreeRoot<Selene, Helios>) -> [u8; 32] {
  match root {
    TreeRoot::C1(point) => point.to_bytes(),
    TreeRoot::C2(point) => point.to_bytes(),
  }
}

/// Curve parameters. Not a consensus generator set.
pub struct Fs1Params {
  pub(crate) g: EdG,
  pub(crate) t: EdG,
  pub(crate) u: EdG,
  pub(crate) v: EdG,
  pub(crate) c1: Generators<Selene>,
  pub(crate) c2: Generators<Helios>,
  pub(crate) c1_init: SeleneG,
  pub(crate) c2_init: HeliosG,
  pub(crate) fcmp: FcmpParams<ShearCurves>,
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
  /// A leaf index is outside the tree, or the tree does not have this depth.
  Path,
  /// The tree is larger than this depth can hold, or is empty.
  TreeSize,
  /// A block does not extend the tree's tip, or is not the tip.
  Link,
  /// The vendored prover rejected the witness.
  Prove(FcmpError),
  /// The vendored verifier rejected the proof.
  Verify(FcmpError),
  /// The public batch check failed.
  Batch,
  /// Reading or writing the proof failed.
  Io,
}

pub(crate) struct BlindScalars {
  pub(crate) o: EdF,
  pub(crate) i: EdF,
  pub(crate) ib: EdF,
  pub(crate) c: EdF,
}

impl BlindScalars {
  pub(crate) fn wipe(&mut self) {
    self.o.zeroize();
    self.i.zeroize();
    self.ib.zeroize();
    self.c.zeroize();
  }
}

impl Drop for BlindScalars {
  fn drop(&mut self) {
    self.wipe();
  }
}

#[cfg(any(test, feature = "insecure-test-generators"))]
impl Fs1Params {
  /// Test parameters that can prove up to `input_limit` inputs, from the
  /// upstream insecure test generators.
  ///
  /// The generator counts follow the upstream test harness:
  /// `2 * input_limit * 256` on the first curve and `2 * input_limit * 128` on the second.
  pub fn open(input_limit: usize) -> Result<Self, Fs1Error> {
    use generalized_bulletproofs::tests::insecure_test_generators;
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
    let c1_init = SeleneG::random(&mut rng);
    let c2_init = HeliosG::random(&mut rng);
    let fcmp = FcmpParams::<ShearCurves>::new(c1.clone(), c2.clone(), c1_init, c2_init, g, t, u, v);
    Ok(Self { g, t, u, v, c1, c2, c1_init, c2_init, fcmp })
  }
}

#[cfg(any(test, feature = "insecure-test-generators"))]
fn nonzero_point(rng: &mut OsRng) -> EdG {
  let mut point = EdG::identity();
  for _ in 0 .. 8 {
    let next = EdG::random(&mut *rng);
    let keep = point.is_identity();
    point = EdG::conditional_select(&point, &next, keep);
  }
  point
}

impl Fs1Params {
  /// Parameters from the fixed generator derivation. Every call gives the same set.
  pub fn fixed() -> Result<Self, Fs1Error> {
    let set = fixed_set().ok_or(Fs1Error::Blind)?;
    let fcmp = FcmpParams::<ShearCurves>::new(
      set.c1.clone(),
      set.c2.clone(),
      set.c1_init,
      set.c2_init,
      set.g,
      set.t,
      set.u,
      set.v,
    );
    Ok(Self {
      g: set.g,
      t: set.t,
      u: set.u,
      v: set.v,
      c1: set.c1,
      c2: set.c2,
      c1_init: set.c1_init,
      c2_init: set.c2_init,
      fcmp,
    })
  }

  /// The Ed25519 generator `T`.
  pub fn t_point(&self) -> EdG {
    self.t
  }
  /// The Ed25519 generator `U`.
  pub fn u_point(&self) -> EdG {
    self.u
  }
  /// The Ed25519 generator `V`.
  pub fn v_point(&self) -> EdG {
    self.v
  }
  /// Selene hash initialisation point.
  pub fn c1_init_point(&self) -> SeleneG {
    self.c1_init
  }
  /// Helios hash initialisation point.
  pub fn c2_init_point(&self) -> HeliosG {
    self.c2_init
  }

}

/// Serialised FCMP length for this many inputs at this depth.
pub fn proof_len(inputs: usize, layers: usize) -> usize {
  Fcmp::<ShearCurves>::proof_size(inputs, layers)
}

/// Branch widths above the leaves, bottom up. Odd positions are Helios layers.
pub(crate) fn branch_width(level: usize) -> usize {
  if level % 2 == 1 {
    LAYER_TWO_LEN
  } else {
    LAYER_ONE_LEN
  }
}

/// Leaves a tree of this depth can hold.
pub fn tree_capacity(layers: usize) -> u128 {
  let mut cap = LAYER_ONE_LEN as u128;
  for level in 1 .. layers {
    cap *= branch_width(level) as u128;
  }
  cap
}

/// A full-width curve tree.
///
/// Leaf `i` is the public output `((i+1)·A, (i+1)·B, (i+1)·D)` for fixed
/// points A, B, D. The leaves are not stored; a chunk is regenerated when a
/// path is opened. Each stored level holds the x coordinate of every node hash.
pub struct Tree {
  len: u64,
  layers: usize,
  bases: [EdG; 3],
  empty_leaf: Output<EdG>,
  /// `helios_levels[k]` holds level `2k + 1`: x coordinates of Selene hashes.
  helios_levels: Vec<Vec<HeliosF>>,
  /// `selene_levels[k]` holds level `2k + 2`: x coordinates of Helios hashes.
  selene_levels: Vec<Vec<SeleneF>>,
  empty_helios: Vec<HeliosF>,
  empty_selene: Vec<SeleneF>,
  root: TreeRoot<Selene, Helios>,
}

/// The empty leaf. Its points come from [`crate::generators::ed25519_point`],
/// so no one knows a discrete log for them and the empty leaf cannot be opened.
pub fn empty_leaf() -> Output<EdG> {
  Output::new(ed25519_point(b"empty-O"), ed25519_point(b"empty-I"), ed25519_point(b"empty-C"))
    .expect("generator points are not the identity")
}

fn chunk_hash_x(params: &Fs1Params, chunk: &[Output<EdG>]) -> Result<HeliosF, Fs1Error> {
  let hash = hash_layer(&params.c1, params.c1_init, &leaf_scalars(chunk)?);
  Ok(SeleneG::to_xy(hash).ok_or(Fs1Error::Blind)?.0)
}

impl Tree {
  /// Build a tree of `len` leaves at `layers` depth.
  pub fn build(params: &Fs1Params, len: u64, layers: usize) -> Result<Self, Fs1Error> {
    if len == 0 || layers == 0 || u128::from(len) > tree_capacity(layers) {
      return Err(Fs1Error::TreeSize);
    }
    let bases = [ed25519_point(b"synthetic-O"), ed25519_point(b"synthetic-I"), ed25519_point(b"synthetic-C")];
    let empty_leaf = empty_leaf();
    let mut tree = Tree {
      len,
      layers,
      bases,
      empty_leaf,
      helios_levels: Vec::new(),
      selene_levels: Vec::new(),
      empty_helios: Vec::new(),
      empty_selene: Vec::new(),
      root: TreeRoot::C1(SeleneG::identity()),
    };

    let chunks = len.div_ceil(LAYER_ONE_LEN as u64);
    let empty_chunk = vec![empty_leaf; LAYER_ONE_LEN];
    let empty1 = chunk_hash_x(params, &empty_chunk)?;
    if layers == 1 {
      let hash = hash_layer(&params.c1, params.c1_init, &leaf_scalars(&tree.chunk(0)?)?);
      tree.root = TreeRoot::C1(hash);
      return Ok(tree);
    }
    let mut level1 = Vec::with_capacity(usize::try_from(chunks).map_err(|_| Fs1Error::TreeSize)?);
    for k in 0 .. chunks {
      level1.push(chunk_hash_x(params, &tree.chunk(k)?)?);
    }
    tree.helios_levels.push(level1);
    tree.empty_helios.push(empty1);

    // Level `level` holds the hashes of groups of `branch_width(level)` children from level - 1.
    for level in 1 .. layers {
      let width = branch_width(level);
      let top = level == layers - 1;
      if level % 2 == 1 {
        let below = tree.helios_levels.last().ok_or(Fs1Error::Path)?;
        let empty = *tree.empty_helios.last().ok_or(Fs1Error::Path)?;
        let groups = below.len().div_ceil(width);
        if top && groups != 1 {
          return Err(Fs1Error::TreeSize);
        }
        let mut next = Vec::with_capacity(groups);
        let mut root = None;
        for g in 0 .. groups {
          let group = full_group(below, g, width, empty);
          let hash = hash_layer(&params.c2, params.c2_init, &group);
          root = Some(hash);
          next.push(HeliosG::to_xy(hash).ok_or(Fs1Error::Blind)?.0);
        }
        let empty_group = vec![empty; width];
        let empty_hash = hash_layer(&params.c2, params.c2_init, &empty_group);
        if top {
          tree.root = TreeRoot::C2(root.ok_or(Fs1Error::Path)?);
        } else {
          tree.selene_levels.push(next);
          tree.empty_selene.push(HeliosG::to_xy(empty_hash).ok_or(Fs1Error::Blind)?.0);
        }
      } else {
        let below = tree.selene_levels.last().ok_or(Fs1Error::Path)?;
        let empty = *tree.empty_selene.last().ok_or(Fs1Error::Path)?;
        let groups = below.len().div_ceil(width);
        if top && groups != 1 {
          return Err(Fs1Error::TreeSize);
        }
        let mut next = Vec::with_capacity(groups);
        let mut root = None;
        for g in 0 .. groups {
          let group = full_group(below, g, width, empty);
          let hash = hash_layer(&params.c1, params.c1_init, &group);
          root = Some(hash);
          next.push(SeleneG::to_xy(hash).ok_or(Fs1Error::Blind)?.0);
        }
        let empty_group = vec![empty; width];
        let empty_hash = hash_layer(&params.c1, params.c1_init, &empty_group);
        if top {
          tree.root = TreeRoot::C1(root.ok_or(Fs1Error::Path)?);
        } else {
          tree.helios_levels.push(next);
          tree.empty_helios.push(SeleneG::to_xy(empty_hash).ok_or(Fs1Error::Blind)?.0);
        }
      }
    }
    Ok(tree)
  }

  /// Real leaves in this tree.
  pub fn len(&self) -> u64 {
    self.len
  }

  /// Always false. A tree is built with at least one leaf.
  pub fn is_empty(&self) -> bool {
    self.len == 0
  }

  /// Depth of this tree.
  pub fn layers(&self) -> usize {
    self.layers
  }

  /// Root every path in this tree opens.
  pub fn root(&self) -> TreeRoot<Selene, Helios> {
    self.root
  }

  /// The public output at leaf `index`.
  pub fn leaf(&self, index: u64) -> Result<Output<EdG>, Fs1Error> {
    if index >= self.len {
      return Err(Fs1Error::Path);
    }
    let k = EdF::from(index + 1);
    Output::new(self.bases[0] * k, self.bases[1] * k, self.bases[2] * k).map_err(|_| Fs1Error::Blind)
  }

  /// Leaf chunk `k`, full width. Slots past the last leaf hold the empty leaf.
  fn chunk(&self, k: u64) -> Result<Vec<Output<EdG>>, Fs1Error> {
    let start = k * LAYER_ONE_LEN as u64;
    let first = EdF::from(start + 1);
    let mut points = [self.bases[0] * first, self.bases[1] * first, self.bases[2] * first];
    let mut out = Vec::with_capacity(LAYER_ONE_LEN);
    for j in 0 .. LAYER_ONE_LEN as u64 {
      let real = (start + j).ct_lt(&self.len);
      let o = EdG::conditional_select(&self.empty_leaf.O(), &points[0], real);
      let i = EdG::conditional_select(&self.empty_leaf.I(), &points[1], real);
      let c = EdG::conditional_select(&self.empty_leaf.C(), &points[2], real);
      out.push(Output::new(o, i, c).map_err(|_| Fs1Error::Blind)?);
      for (point, base) in points.iter_mut().zip(self.bases.iter()) {
        *point += *base;
      }
    }
    Ok(out)
  }

  #[cfg(test)]
  pub(crate) fn path_for_test(&self, index: u64) -> Result<Path<ShearCurves>, Fs1Error> {
    self.path(index)
  }

  #[cfg(test)]
  pub(crate) fn empty_leaf_for_test(&self) -> Output<EdG> {
    self.empty_leaf
  }

  /// The path from leaf `index` to the root.
  fn path(&self, index: u64) -> Result<Path<ShearCurves>, Fs1Error> {
    let output = self.leaf(index)?;
    let k = index / LAYER_ONE_LEN as u64;
    let leaves = self.chunk(k)?;
    let mut curve_2_layers = Vec::new();
    let mut curve_1_layers = Vec::new();
    let mut at = usize::try_from(k).map_err(|_| Fs1Error::Path)?;
    for level in 1 .. self.layers {
      if level % 2 == 1 {
        let group = at / LAYER_TWO_LEN;
        let below = &self.helios_levels[(level - 1) / 2];
        curve_2_layers.push(ct_group(below, group, LAYER_TWO_LEN, self.empty_helios[(level - 1) / 2]));
        at = group;
      } else {
        let group = at / LAYER_ONE_LEN;
        let below = &self.selene_levels[(level - 2) / 2];
        curve_1_layers.push(ct_group(below, group, LAYER_ONE_LEN, self.empty_selene[(level - 2) / 2]));
        at = group;
      }
    }
    Ok(Path { output, leaves, curve_2_layers, curve_1_layers })
  }
}

/// Group `g` of `width` children from `level`. Slots past the end hold `empty`.
/// Used while building the public tree, where `g` is public.
pub(crate) fn full_group<F: Copy>(level: &[F], g: usize, width: usize, empty: F) -> Vec<F> {
  let start = g * width;
  let mut out = vec![empty; width];
  let have = level.len().saturating_sub(start).min(width);
  out[.. have].copy_from_slice(&level[start .. start + have]);
  out
}

/// Group `g` of `width` children from `level`, where `g` comes from a secret
/// leaf index. Every element of the level is read and passed through one
/// conditional select, whatever `g` is. Slots past the end hold `empty`.
pub(crate) fn ct_group<F: ConditionallySelectable + Copy>(
  level: &[F],
  g: usize,
  width: usize,
  empty: F,
) -> Vec<F> {
  let mut out = vec![empty; width];
  let groups = level.len().div_ceil(width).max(1);
  let want = u64::try_from(g).unwrap_or(u64::MAX);
  for gi in 0 .. groups {
    let hit = u64::try_from(gi).unwrap_or(u64::MAX).ct_eq(&want);
    for (j, slot) in out.iter_mut().enumerate() {
      let child = level.get(gi * width + j).copied().unwrap_or(empty);
      *slot = F::conditional_select(slot, &child, hit);
    }
  }
  out
}

/// A tree a membership proof can open.
pub trait Fs1Tree: Sync {
  /// Depth of this tree.
  fn layers(&self) -> usize;
  /// Root every path in this tree opens.
  fn root(&self) -> TreeRoot<Selene, Helios>;
  /// The full-width path from leaf `index` to the root.
  ///
  /// `index` is secret. The memory read must not depend on it.
  fn path(&self, index: u64) -> Result<Path<ShearCurves>, Fs1Error>;
}

impl Fs1Tree for Tree {
  fn layers(&self) -> usize {
    self.layers
  }
  fn root(&self) -> TreeRoot<Selene, Helios> {
    self.root
  }
  fn path(&self, index: u64) -> Result<Path<ShearCurves>, Fs1Error> {
    Tree::path(self, index)
  }
}

/// Branch blinds one input needs at this depth, `(Selene, Helios)`.
///
/// Matches `Branches::necessary_c1_blinds` and `necessary_c2_blinds` for full paths.
pub fn branch_blinds_per_input(layers: usize) -> (usize, usize) {
  if layers <= 1 {
    return (0, 0);
  }
  let helios_levels = (1 .. layers).filter(|l| l % 2 == 1).count();
  let selene_levels = (1 .. layers).filter(|l| l % 2 == 0).count();
  if (layers - 1) % 2 == 1 {
    (1 + selene_levels, helios_levels - 1)
  } else {
    (selene_levels, helios_levels)
  }
}

/// Run `jobs` jobs on `threads` scoped threads, job `j` on thread `j % threads`.
///
/// With one thread, or one job, nothing is spawned. Every thread is joined
/// before this returns. The schedule depends only on `jobs` and `threads`.
pub(crate) fn run_jobs<T: Send>(threads: usize, jobs: usize, job: impl Fn(usize) -> T + Sync) -> Vec<T> {
  let threads = threads.clamp(1, jobs.max(1));
  if threads == 1 {
    return (0 .. jobs).map(job).collect();
  }
  let job = &job;
  let mut lanes: Vec<Vec<(usize, T)>> = std::thread::scope(|scope| {
    let handles: Vec<_> = (0 .. threads)
      .map(|lane| {
        #[cfg(test)]
        crate::ct::note_spawn();
        scope.spawn(move || (lane .. jobs).step_by(threads).map(|j| (j, job(j))).collect::<Vec<_>>())
      })
      .collect();
    handles.into_iter().map(|h| h.join().expect("prover thread panicked")).collect()
  });
  let mut out: Vec<Option<T>> = (0 .. jobs).map(|_| None).collect();
  for lane in &mut lanes {
    for (j, value) in lane.drain(..) {
      out[j] = Some(value);
    }
  }
  out.into_iter().map(|v| v.expect("every job ran")).collect()
}

/// Secret blinds for up to [`PreparedBlinds::inputs`] inputs, made before the
/// statement is known.
///
/// A wallet can build these while the user is still choosing what to send,
/// which takes the divisor work off the prove. They are consumed by
/// [`prove_prepared`] and never reused. Unused blinds are wiped on drop.
pub struct PreparedBlinds {
  layers: usize,
  outputs: Vec<(OutputBlinds<EdG>, BlindScalars)>,
  c1: Vec<BranchBlind<SeleneG>>,
  c2: Vec<BranchBlind<HeliosG>>,
}

impl Drop for PreparedBlinds {
  fn drop(&mut self) {
    for (blinds, scalars) in &mut self.outputs {
      blinds.zeroize();
      scalars.wipe();
    }
    for blind in &mut self.c1 {
      blind.zeroize();
    }
    for blind in &mut self.c2 {
      blind.zeroize();
    }
  }
}

enum BlindJob {
  Output(Box<(OutputBlinds<EdG>, BlindScalars)>),
  C1(BranchBlind<SeleneG>),
  C2(BranchBlind<HeliosG>),
}

impl PreparedBlinds {
  /// Blinds for up to `inputs` inputs at `layers` depth, on `threads` threads.
  pub fn prepare(params: &Fs1Params, inputs: usize, layers: usize, threads: usize) -> Result<Self, Fs1Error> {
    if !consensus_accepts(inputs) || layers == 0 {
      return Err(Fs1Error::InputCount);
    }
    let (per_c1, per_c2) = branch_blinds_per_input(layers);
    let (n_c1, n_c2) = (per_c1 * inputs, per_c2 * inputs);
    let jobs = inputs + n_c1 + n_c2;
    let made = run_jobs(threads, jobs, |j| {
      let mut rng = OsRng;
      if j < inputs {
        BlindJob::Output(Box::new(fresh_output_blinds(&mut rng, params)))
      } else if j < inputs + n_c1 {
        BlindJob::C1(BranchBlind::<SeleneG>::new(params.c1.h(), nonzero_decomposition(&mut rng)))
      } else {
        BlindJob::C2(BranchBlind::<HeliosG>::new(params.c2.h(), nonzero_decomposition(&mut rng)))
      }
    });
    let mut blinds = PreparedBlinds {
      layers,
      outputs: Vec::with_capacity(inputs),
      c1: Vec::with_capacity(n_c1),
      c2: Vec::with_capacity(n_c2),
    };
    for job in made {
      match job {
        BlindJob::Output(pair) => blinds.outputs.push(*pair),
        BlindJob::C1(blind) => blinds.c1.push(blind),
        BlindJob::C2(blind) => blinds.c2.push(blind),
      }
    }
    Ok(blinds)
  }

  /// Most inputs these blinds can prove.
  pub fn inputs(&self) -> usize {
    self.outputs.len()
  }
}

/// Prove membership of `notes` in `tree` on the calling thread.
///
/// Blinds come from the operating system's RNG. The same notes proved twice
/// differ in bytes and match in length. No thread is started.
pub fn prove(params: &Fs1Params, tree: &impl Fs1Tree, notes: &[OpenNote]) -> Result<Proved, Fs1Error> {
  prove_threaded(params, tree, notes, 1)
}

/// [`prove`], with paths and blinds spread over `threads` scoped threads.
pub fn prove_threaded(
  params: &Fs1Params,
  tree: &impl Fs1Tree,
  notes: &[OpenNote],
  threads: usize,
) -> Result<Proved, Fs1Error> {
  check_notes(tree, notes)?;
  let blinds = PreparedBlinds::prepare(params, notes.len(), tree.layers(), threads)?;
  prove_prepared(params, tree, notes, blinds, threads)
}

fn check_notes(tree: &impl Fs1Tree, notes: &[OpenNote]) -> Result<(), Fs1Error> {
  if !consensus_accepts(notes.len()) || tree.layers() == 0 {
    return Err(Fs1Error::InputCount);
  }
  let mut types_ok = Choice::from(1);
  for note in notes {
    types_ok &= note.note_type.ct_eq(&NOTE_PAYMENT) | note.note_type.ct_eq(&NOTE_CHANGE);
  }
  if !bool::from(types_ok) {
    return Err(Fs1Error::NoteType);
  }
  Ok(())
}

/// Prove with blinds made earlier by [`PreparedBlinds::prepare`].
///
/// The blinds must be for this depth and at least `notes.len()` inputs. They
/// are consumed whether or not the prove succeeds.
pub fn prove_prepared(
  params: &Fs1Params,
  tree: &impl Fs1Tree,
  notes: &[OpenNote],
  blinds: PreparedBlinds,
  threads: usize,
) -> Result<Proved, Fs1Error> {
  prove_prepared_scalars(params, tree, notes, blinds, threads).map(|(proved, _)| proved)
}

/// [`prove_prepared`], also returning each input's blind scalars in input order.
/// The spend proof needs them; they are wiped when dropped.
pub(crate) fn prove_prepared_scalars(
  params: &Fs1Params,
  tree: &impl Fs1Tree,
  notes: &[OpenNote],
  mut blinds: PreparedBlinds,
  threads: usize,
) -> Result<(Proved, Vec<BlindScalars>), Fs1Error> {
  check_notes(tree, notes)?;
  let n = notes.len();
  if blinds.layers != tree.layers() || blinds.inputs() < n {
    return Err(Fs1Error::Blind);
  }

  let paths = run_jobs(threads, n, |i| tree.path(notes[i].leaf_index)).into_iter().collect::<Result<Vec<_>, _>>()?;
  let outputs: Vec<Output<EdG>> = paths.iter().map(|path| path.output).collect();
  let branches = Branches::new(paths).ok_or(Fs1Error::Path)?;
  let (per_c1, per_c2) = branch_blinds_per_input(tree.layers());
  if branches.necessary_c1_blinds() != per_c1 * n || branches.necessary_c2_blinds() != per_c2 * n {
    return Err(Fs1Error::Path);
  }

  let mut output_blinds = Vec::with_capacity(n);
  let mut opened = Vec::with_capacity(n);
  let mut input_bytes = Vec::with_capacity(n);
  let mut kept = Vec::with_capacity(n);
  for (output, (blinds, scalars)) in outputs.iter().zip(blinds.outputs.drain(.. n)) {
    let points = open_input_points(output, &scalars, params);
    opened.push(Input::new(points[0], points[1], points[2], points[3]).map_err(|_| Fs1Error::Blind)?);
    let mut encoded = [0u8; 128];
    for (slot, point) in encoded.chunks_mut(32).zip(points.iter()) {
      slot.copy_from_slice(&point.to_bytes());
    }
    input_bytes.push(encoded);
    output_blinds.push(blinds);
    kept.push(scalars);
  }
  let c1_blinds: Vec<_> = blinds.c1.drain(.. per_c1 * n).collect();
  let c2_blinds: Vec<_> = blinds.c2.drain(.. per_c2 * n).collect();
  drop(blinds);

  let mut rng = OsRng;
  let blinded = branches.blind(output_blinds, c1_blinds, c2_blinds).map_err(Fs1Error::Prove)?;
  let proof = Fcmp::<ShearCurves>::prove(&mut rng, &params.fcmp, blinded).map_err(Fs1Error::Prove)?;
  let mut bytes = Vec::new();
  proof.write(&mut bytes).map_err(|_| Fs1Error::Io)?;
  if bytes.len() != proof_len(n, tree.layers()) {
    return Err(Fs1Error::Io);
  }
  Ok((Proved { bytes, inputs: opened, input_bytes, root: tree.root(), layers: tree.layers() }, kept))
}

/// Verify a proof produced by [`prove`] against the same parameters.
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

pub(crate) fn leaf_scalars(leaves: &[Output<EdG>]) -> Result<Vec<SeleneF>, Fs1Error> {
  let mut out = Vec::with_capacity(leaves.len() * 6);
  for leaf in leaves {
    let (ox, oy) = EdG::to_xy(leaf.O()).ok_or(Fs1Error::Blind)?;
    let (ix, iy) = EdG::to_xy(leaf.I()).ok_or(Fs1Error::Blind)?;
    let (cx, cy) = EdG::to_xy(leaf.C()).ok_or(Fs1Error::Blind)?;
    out.extend([ox, oy, ix, iy, cx, cy]);
  }
  Ok(out)
}

/// Public layer hash. Every child is included. The scalar list length is public.
pub(crate) fn hash_layer<C: Ciphersuite>(generators: &Generators<C>, init: C::G, children: &[C::F]) -> C::G
where
  C::G: zeroize::Zeroize + ConditionallySelectable,
  C::F: zeroize::Zeroize + PrimeFieldBits,
{
  let pairs: Vec<(C::F, C::G)> =
    children.iter().copied().zip(generators.g_bold_slice().iter().copied()).collect();
  init + multiexp(&pairs)
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

pub(crate) fn fresh_output_blinds(
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

fn nonzero_scalar(rng: &mut OsRng) -> EdF {
  let mut scalar = EdF::ZERO;
  for _ in 0 .. 8 {
    let next = EdF::random(&mut *rng);
    let keep = scalar.is_zero();
    scalar = EdF::conditional_select(&scalar, &next, keep);
  }
  scalar
}

/// `[O~, I~, R, C~]` for one output.
///
/// input = output - blind, so the circuit can add the blind back.
/// R is I's blind-of-a-blind minus I's V blind. Same formula for every note.
pub(crate) fn open_input_points(output: &Output<EdG>, blinds: &BlindScalars, params: &Fs1Params) -> [EdG; 4] {
  [
    output.O() - (params.t * blinds.o),
    output.I() - (params.u * blinds.i),
    (params.t * blinds.ib) - (params.v * blinds.i),
    output.C() - (params.g * blinds.c),
  ]
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use std::sync::OnceLock;

  pub(crate) fn note(leaf: u64, age: u64, set_size: u64, note_type: u8) -> OpenNote {
    OpenNote { leaf_index: leaf, note_age: age, set_size, note_type, anchor: [7; 32] }
  }

  pub(crate) fn params_8() -> &'static Fs1Params {
    static CELL: OnceLock<Fs1Params> = OnceLock::new();
    CELL.get_or_init(|| Fs1Params::fixed().expect("params"))
  }

  pub(crate) fn tree_1() -> &'static Tree {
    static CELL: OnceLock<Tree> = OnceLock::new();
    CELL.get_or_init(|| Tree::build(params_8(), 30, 1).expect("tree"))
  }

  pub(crate) fn tree_2_10() -> &'static Tree {
    static CELL: OnceLock<Tree> = OnceLock::new();
    CELL.get_or_init(|| Tree::build(params_8(), 1 << 10, DEPTH).expect("tree"))
  }

  pub(crate) fn tree_2_20() -> &'static Tree {
    static CELL: OnceLock<Tree> = OnceLock::new();
    CELL.get_or_init(|| Tree::build(params_8(), 1 << 20, DEPTH).expect("tree"))
  }

  fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
  }

  #[test]
  fn proof_length_depends_only_on_input_count_at_depth_7() {
    let lens: Vec<usize> = (1 ..= 8).map(|n| proof_len(n, DEPTH)).collect();
    for pair in lens.windows(2) {
      assert!(pair[0] < pair[1], "{lens:?}");
    }
    assert!(lens[0] > 64);
  }

  #[test]
  fn rejected_note_type_input_count_and_leaf() {
    let params = params_8();
    let tree = tree_1();
    assert!(matches!(prove(params, tree, &[note(0, 0, 1, 0x01)]), Err(Fs1Error::NoteType)));
    assert!(matches!(prove(params, tree, &[]), Err(Fs1Error::InputCount)));
    let nine = vec![note(0, 0, 1, NOTE_PAYMENT); 9];
    assert!(matches!(Fs1Params::open(9), Err(Fs1Error::InputCount)));
    assert!(matches!(prove(params, tree, &nine), Err(Fs1Error::InputCount)));
    assert!(matches!(prove(params, tree, &[note(30, 0, 1, NOTE_PAYMENT)]), Err(Fs1Error::Path)));
    assert!(matches!(Tree::build(params, 0, DEPTH), Err(Fs1Error::TreeSize)));
    assert!(matches!(Tree::build(params, 39, 1), Err(Fs1Error::TreeSize)));
  }

  #[test]
  fn proved_carries_no_private_statement() {
    let params = params_8();
    let tree = tree_1();
    let secret = OpenNote {
      leaf_index: 29,
      note_age: 0x5eed_c0de_1234_5678,
      set_size: 0x0bad_f00d_8765_4321,
      note_type: NOTE_CHANGE,
      anchor: [0xa5; 32],
    };
    let proved = prove(params, tree, &[secret]).expect("prove");
    verify(params, &proved).expect("verify");
    let wire = proved.public_bytes();
    let witness = secret.witness_bytes();
    assert!(!contains(&wire, &witness));
    assert!(!contains(&wire, &secret.note_age.to_le_bytes()));
    assert!(!contains(&wire, &secret.set_size.to_le_bytes()));
    assert!(!contains(&wire, &secret.anchor[.. 16]));
    assert_eq!(wire.len(), proved.bytes.len() + 128 + 32);
  }

  #[test]
  fn one_layer_tree_proves_every_leaf_at_one_length() {
    let params = params_8();
    let tree = tree_1();
    let mut lengths = Vec::new();
    for (leaf, age, ty) in [(0, 0, NOTE_PAYMENT), (18, 7, NOTE_CHANGE), (29, 100_000, NOTE_PAYMENT)] {
      let proved = prove(params, tree, &[note(leaf, age, 30, ty)]).expect("prove");
      verify(params, &proved).expect("verify");
      lengths.push(proved.bytes.len());
    }
    assert!(lengths.iter().all(|len| *len == proof_len(1, 1)), "{lengths:?}");
  }

  #[test]
  fn a_proof_does_not_verify_against_another_tree() {
    let params = params_8();
    let mut proved = prove(params, tree_1(), &[note(3, 0, 30, NOTE_PAYMENT)]).expect("prove");
    let other = Tree::build(params, 31, 1).expect("tree");
    assert_ne!(root_bytes(&other.root()), root_bytes(&proved.root));
    proved.root = other.root();
    assert!(verify(params, &proved).is_err());
  }

  #[test]
  fn tree_capacity_holds_2_20_at_depth_7() {
    assert!(tree_capacity(DEPTH) > 1u128 << 20);
    assert_eq!(tree_capacity(1), 38);
    assert_eq!(tree_capacity(2), 38 * 18);
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn depth_7_length_is_constant_for_1_to_8_inputs_across_leaf_and_age() {
    let params = params_8();
    let tree = tree_2_10();
    assert_eq!(tree.len(), 1 << 10);
    let size = tree.len();
    for inputs in 1 ..= 8usize {
      let mut lengths = Vec::new();
      for variant in 0 .. 2u64 {
        let notes: Vec<OpenNote> = (0 .. inputs as u64)
          .map(|i| {
            let leaf = if variant == 0 { i } else { size - 1 - i * 97 };
            let age = if variant == 0 { 0 } else { 100_000 + i };
            note(leaf, age, size, if i % 2 == 0 { NOTE_PAYMENT } else { NOTE_CHANGE })
          })
          .collect();
        let proved = prove(params, tree, &notes).expect("prove");
        verify(params, &proved).expect("verify");
        lengths.push(proved.bytes.len());
      }
      assert!(lengths.iter().all(|len| *len == proof_len(inputs, DEPTH)), "{inputs} {lengths:?}");
    }
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn a_2_20_tree_proves_its_first_middle_and_last_leaf() {
    let params = params_8();
    let tree = tree_2_20();
    assert_eq!(tree.len(), 1 << 20);
    let small = tree_2_10();
    assert_ne!(root_bytes(&tree.root()), root_bytes(&small.root()));
    let last = tree.len() - 1;
    let notes = [note(0, 0, 1 << 20, NOTE_PAYMENT), note(1 << 19, 9, 1 << 20, NOTE_CHANGE), note(last, 99, 1 << 20, NOTE_PAYMENT)];
    for one in notes {
      let proved = prove(params, tree, &[one]).expect("prove");
      verify(params, &proved).expect("verify");
      assert_eq!(proved.bytes.len(), proof_len(1, DEPTH));
    }
    let proved = prove(params, tree, &notes).expect("prove");
    verify(params, &proved).expect("verify");
    assert_eq!(proved.bytes.len(), proof_len(3, DEPTH));
    assert!(matches!(prove(params, tree, &[note(1 << 20, 0, 1 << 20, NOTE_PAYMENT)]), Err(Fs1Error::Path)));
  }
}
