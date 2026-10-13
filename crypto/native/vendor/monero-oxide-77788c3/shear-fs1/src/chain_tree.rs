//! The FS-1 tree built from chain notes, one block at a time.
//!
//! T-1. The leaf set is every note that joins the admit set, in block order,
//!      then transaction order, then output order. A note that L-3 rejects
//!      takes no slot. There are no buckets and no groups: every spend hides
//!      among the whole note set under one root.
//! T-2. The tree has [`DEPTH`] layers and the same full-width shape as
//!      [`crate::Tree`]. A slot past the last leaf holds the empty value.
//! T-3. A layer hash is `init + Σ child_j · g_bold[j]`. It is linear in each
//!      child, so a block that appends leaves adds `(new − empty) · g_bold[j]`
//!      to each touched node, and a disconnect adds `(empty − old) · g_bold[j]`.
//!      The tree after any sequence of connects and disconnects equals the tree
//!      built from scratch over the same chain.
//! T-4. A block connects only on top of the tip: its height is the tip height
//!      plus one and its parent is the tip id. Only the tip disconnects.
//!
//! Node hashes use the constant-time `multiexp` 0.5.2, like [`crate::Tree`].
//! A path for a secret leaf index reads every stored leaf and every node of
//! every level through `ct_group`.

use ciphersuite::{group::ff::PrimeFieldBits, Ciphersuite};
use ec_divisors::DivisorCurve;
use full_chain_membership_proofs::{Output, Path, TreeRoot, LAYER_ONE_LEN, LAYER_TWO_LEN};
use generalized_bulletproofs::Generators;
use helioselene::{Helios, Selene};
use multiexp::multiexp;
use subtle::{Choice, ConditionallySelectable, ConstantTimeEq};
use zeroize::Zeroize;

use crate::leaf::{leaf_bytes, leaf_of, ChainNote, LEAF_BYTES};
use crate::membership::{
  ct_group, empty_leaf, hash_layer, leaf_scalars, tree_capacity, EdG, Fs1Error, Fs1Params, Fs1Tree,
  HeliosF, HeliosG, SeleneF, SeleneG, ShearCurves, DEPTH,
};

/// `u64` words in one stored leaf.
pub const LEAF_WORDS: usize = LEAF_BYTES / 8;
const CHUNK_WORDS: usize = LAYER_ONE_LEN * LEAF_WORDS;
const LEAF_SCALARS: usize = 6;

fn words_of(bytes: &[u8; LEAF_BYTES]) -> [u64; LEAF_WORDS] {
  let mut out = [0u64; LEAF_WORDS];
  for (word, chunk) in out.iter_mut().zip(bytes.chunks_exact(8)) {
    *word = u64::from_le_bytes(chunk.try_into().expect("8 bytes"));
  }
  out
}

fn bytes_of(words: &[u64]) -> [u8; LEAF_BYTES] {
  let mut out = [0u8; LEAF_BYTES];
  for (chunk, word) in out.chunks_exact_mut(8).zip(words) {
    chunk.copy_from_slice(&word.to_le_bytes());
  }
  out
}

/// Decode a stored leaf without branching on its bytes.
fn decode_leaf_ct(words: &[u64]) -> Result<Output<EdG>, Fs1Error> {
  use ciphersuite::group::GroupEncoding;
  let bytes = bytes_of(words);
  let mut ok = Choice::from(1);
  let mut points = [<EdG as ciphersuite::group::Group>::identity(); 3];
  for (point, chunk) in points.iter_mut().zip(bytes.chunks_exact(32)) {
    let mut repr = [0u8; 32];
    repr.copy_from_slice(chunk);
    let decoded = EdG::from_bytes(&repr);
    ok &= decoded.is_some();
    *point = decoded.unwrap_or(<EdG as ciphersuite::group::Group>::identity());
  }
  if !bool::from(ok) {
    return Err(Fs1Error::Path);
  }
  Output::new(points[0], points[1], points[2]).map_err(|_| Fs1Error::Path)
}

fn x_of<G: DivisorCurve>(point: G) -> Result<G::FieldElement, Fs1Error> {
  G::to_xy(point).map(|xy| xy.0).ok_or(Fs1Error::Blind)
}

/// Empty values at every level, bottom up.
#[derive(Clone)]
struct Empties {
  leaf_words: [u64; LEAF_WORDS],
  leaf_scalars: Vec<SeleneF>,
  /// Hash of an all-empty node at level `2k`, and its x coordinate.
  selene: Vec<(SeleneG, HeliosF)>,
  /// Hash of an all-empty node at level `2k + 1`, and its x coordinate.
  helios: Vec<(HeliosG, SeleneF)>,
}

impl Empties {
  fn new(params: &Fs1Params, layers: usize) -> Result<Self, Fs1Error> {
    let leaf = empty_leaf();
    let leaf_scalars = leaf_scalars(&[leaf])?;
    let mut chunk = Vec::with_capacity(LAYER_ONE_LEN * LEAF_SCALARS);
    for _ in 0 .. LAYER_ONE_LEN {
      chunk.extend_from_slice(&leaf_scalars);
    }
    let mut selene = Vec::new();
    let mut helios = Vec::new();
    let point = hash_layer(&params.c1, params.c1_init, &chunk);
    selene.push((point, x_of(point)?));
    for level in 1 .. layers {
      if level % 2 == 1 {
        let child = selene.last().ok_or(Fs1Error::Path)?.1;
        let point = hash_layer(&params.c2, params.c2_init, &vec![child; LAYER_TWO_LEN]);
        helios.push((point, x_of(point)?));
      } else {
        let child = helios.last().ok_or(Fs1Error::Path)?.1;
        let point = hash_layer(&params.c1, params.c1_init, &vec![child; LAYER_ONE_LEN]);
        selene.push((point, x_of(point)?));
      }
    }
    Ok(Self { leaf_words: words_of(&leaf_bytes(&leaf)), leaf_scalars, selene, helios })
  }
}

/// One level's nodes: the hash points and their x coordinates.
#[derive(Clone)]
struct Level<G: DivisorCurve> {
  nodes: Vec<G>,
  xs: Vec<G::FieldElement>,
}

impl<G: DivisorCurve> Level<G> {
  fn new() -> Self {
    Self { nodes: Vec::new(), xs: Vec::new() }
  }
}

/// New values for the nodes one level's deltas touch: `(node, point, x)`.
type Writes<G> = Vec<(usize, G, <G as DivisorCurve>::FieldElement)>;

/// Every node write one append or truncate makes, by level.
struct Plan {
  selene: Vec<Writes<SeleneG>>,
  helios: Vec<Writes<HeliosG>>,
}

#[cfg(test)]
std::thread_local! {
  /// Test builds only: the level at which the next propagate fails.
  static FAIL_AT_LEVEL: core::cell::Cell<Option<usize>> = const { core::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) fn fail_next_propagate_at(level: usize) {
  FAIL_AT_LEVEL.with(|c| c.set(Some(level)));
}

/// Plan `Σ delta · g_bold[slot]` onto each named node without writing it. `deltas`
/// is `(node, slot, delta)`, sorted by node. Returns the writes and `(node, new x − old x)`.
#[allow(clippy::type_complexity)]
fn bump<C>(
  generators: &Generators<C>,
  level: &Level<C::G>,
  empty: (C::G, <C::G as DivisorCurve>::FieldElement),
  deltas: &[(usize, usize, C::F)],
) -> Result<(Writes<C::G>, Vec<(usize, <C::G as DivisorCurve>::FieldElement)>), Fs1Error>
where
  C: Ciphersuite,
  C::G: DivisorCurve + Zeroize + ConditionallySelectable,
  C::F: Zeroize + PrimeFieldBits,
{
  let g_bold = generators.g_bold_slice();
  let mut writes = Vec::new();
  let mut out = Vec::new();
  let mut i = 0;
  while i < deltas.len() {
    let node = deltas[i].0;
    let mut pairs = Vec::new();
    while i < deltas.len() && deltas[i].0 == node {
      pairs.push((deltas[i].2, *g_bold.get(deltas[i].1).ok_or(Fs1Error::Path)?));
      i += 1;
    }
    let (old_point, old_x) = match (level.nodes.get(node), level.xs.get(node)) {
      (Some(p), Some(x)) => (*p, *x),
      _ => empty,
    };
    let point = old_point + multiexp(&pairs);
    let x = x_of(point)?;
    writes.push((node, point, x));
    out.push((node, x - old_x));
  }
  Ok((writes, out))
}

fn write<G: DivisorCurve>(level: &mut Level<G>, empty: (G, G::FieldElement), writes: Writes<G>) {
  for (node, point, x) in writes {
    while level.nodes.len() <= node {
      level.nodes.push(empty.0);
      level.xs.push(empty.1);
    }
    level.nodes[node] = point;
    level.xs[node] = x;
  }
}

/// One connected block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockMark {
  /// Block height.
  pub height: u64,
  /// Block id, as the chain names it.
  pub id: [u8; 32],
  /// Leaves in the tree before this block.
  pub start: u64,
}

/// The FS-1 tree over a chain's notes.
#[derive(Clone)]
pub struct ChainTree {
  layers: usize,
  len: u64,
  /// Stored leaves, [`LEAF_WORDS`] per leaf, padded with the empty leaf to a whole chunk.
  words: Vec<u64>,
  empty: Empties,
  /// `selene[k]` is level `2k`. Level 0 holds the leaf-chunk hashes.
  selene: Vec<Level<SeleneG>>,
  /// `helios[k]` is level `2k + 1`.
  helios: Vec<Level<HeliosG>>,
  blocks: Vec<BlockMark>,
}

impl ChainTree {
  /// An empty tree at [`DEPTH`].
  pub fn new(params: &Fs1Params) -> Result<Self, Fs1Error> {
    Self::with_layers(params, DEPTH)
  }

  /// An empty tree at `layers` depth.
  pub fn with_layers(params: &Fs1Params, layers: usize) -> Result<Self, Fs1Error> {
    if layers == 0 {
      return Err(Fs1Error::TreeSize);
    }
    let empty = Empties::new(params, layers)?;
    let mut tree = Self {
      layers,
      len: 0,
      words: Vec::new(),
      empty,
      selene: (0 .. layers.div_ceil(2)).map(|_| Level::new()).collect(),
      helios: (0 .. layers / 2).map(|_| Level::new()).collect(),
      blocks: Vec::new(),
    };
    tree.trim();
    Ok(tree)
  }

  /// Leaves in the tree.
  pub fn len(&self) -> u64 {
    self.len
  }

  /// True before the first leaf.
  pub fn is_empty(&self) -> bool {
    self.len == 0
  }

  /// The connected blocks, oldest first.
  pub fn blocks(&self) -> &[BlockMark] {
    &self.blocks
  }

  /// The tip block, if any.
  pub fn tip(&self) -> Option<BlockMark> {
    self.blocks.last().copied()
  }

  /// Compressed root.
  pub fn root_bytes(&self) -> [u8; 32] {
    crate::root_bytes(&Fs1Tree::root(self))
  }

  /// Leaf `index` as [`crate::leaf::leaf_bytes`] encodes it.
  pub fn leaf_bytes(&self, index: u64) -> Option<[u8; LEAF_BYTES]> {
    if index >= self.len {
      return None;
    }
    let at = usize::try_from(index).ok()? * LEAF_WORDS;
    Some(bytes_of(&self.words[at .. at + LEAF_WORDS]))
  }

  /// T-4 and T-1. Connect one block's notes. Returns the leaf added for each
  /// note, or `None` where L-3 rejected it.
  pub fn connect(
    &mut self,
    params: &Fs1Params,
    height: u64,
    id: [u8; 32],
    parent: [u8; 32],
    notes: &[ChainNote],
  ) -> Result<Vec<Option<[u8; LEAF_BYTES]>>, Fs1Error> {
    if let Some(tip) = self.tip() {
      if height != tip.height.wrapping_add(1) || parent != tip.id {
        return Err(Fs1Error::Link);
      }
    }
    let leaves: Vec<Option<Output<EdG>>> = notes.iter().map(leaf_of).collect();
    let kept: Vec<Output<EdG>> = leaves.iter().flatten().copied().collect();
    let start = self.len;
    self.append(params, &kept)?;
    self.blocks.push(BlockMark { height, id, start });
    Ok(leaves.iter().map(|leaf| leaf.as_ref().map(leaf_bytes)).collect())
  }

  /// T-4. Disconnect the tip block, which must be `id`.
  pub fn disconnect(&mut self, params: &Fs1Params, id: [u8; 32]) -> Result<BlockMark, Fs1Error> {
    let tip = self.tip().ok_or(Fs1Error::Link)?;
    if tip.id != id {
      return Err(Fs1Error::Link);
    }
    self.truncate(params, tip.start)?;
    self.blocks.pop();
    Ok(tip)
  }

  /// Append leaves that are not tied to a block. Used by the synthetic checks.
  pub(crate) fn append(&mut self, params: &Fs1Params, leaves: &[Output<EdG>]) -> Result<(), Fs1Error> {
    if leaves.is_empty() {
      return Ok(());
    }
    let new_len = self.len.checked_add(leaves.len() as u64).ok_or(Fs1Error::TreeSize)?;
    if u128::from(new_len) > tree_capacity(self.layers) {
      return Err(Fs1Error::TreeSize);
    }
    let first = usize::try_from(self.len).map_err(|_| Fs1Error::TreeSize)?;
    let mut deltas = Vec::with_capacity(leaves.len() * LEAF_SCALARS);
    let mut words = Vec::with_capacity(leaves.len() * LEAF_WORDS);
    for (offset, leaf) in leaves.iter().enumerate() {
      let index = first + offset;
      words.extend_from_slice(&words_of(&leaf_bytes(leaf)));
      let scalars = leaf_scalars(&[*leaf])?;
      let base = (index % LAYER_ONE_LEN) * LEAF_SCALARS;
      for (t, (new, empty)) in scalars.iter().zip(self.empty.leaf_scalars.iter()).enumerate() {
        deltas.push((index / LAYER_ONE_LEN, base + t, *new - *empty));
      }
    }
    let plan = self.plan(params, deltas)?;
    let end = (first + leaves.len()) * LEAF_WORDS;
    while self.words.len() < end {
      for _ in 0 .. LAYER_ONE_LEN {
        self.words.extend_from_slice(&self.empty.leaf_words);
      }
    }
    self.words[first * LEAF_WORDS .. end].copy_from_slice(&words);
    self.len = new_len;
    self.apply(plan);
    Ok(())
  }

  /// Drop every leaf from `len` on.
  fn truncate(&mut self, params: &Fs1Params, len: u64) -> Result<(), Fs1Error> {
    if len >= self.len {
      return Ok(());
    }
    let from = usize::try_from(len).map_err(|_| Fs1Error::TreeSize)?;
    let to = usize::try_from(self.len).map_err(|_| Fs1Error::TreeSize)?;
    let mut deltas = Vec::with_capacity((to - from) * LEAF_SCALARS);
    for index in from .. to {
      let at = index * LEAF_WORDS;
      let old = decode_leaf_ct(&self.words[at .. at + LEAF_WORDS])?;
      let scalars = leaf_scalars(&[old])?;
      let base = (index % LAYER_ONE_LEN) * LEAF_SCALARS;
      for (t, (old, empty)) in scalars.iter().zip(self.empty.leaf_scalars.iter()).enumerate() {
        deltas.push((index / LAYER_ONE_LEN, base + t, *empty - *old));
      }
    }
    let plan = self.plan(params, deltas)?;
    for index in from .. to {
      let at = index * LEAF_WORDS;
      self.words[at .. at + LEAF_WORDS].copy_from_slice(&self.empty.leaf_words);
    }
    self.len = len;
    self.words.truncate(from.div_ceil(LAYER_ONE_LEN) * CHUNK_WORDS);
    self.apply(plan);
    Ok(())
  }

  /// T-3. Every node write that pushing these leaf-slot deltas up every level makes.
  /// Reads the tree and writes nothing, so a failure leaves the tree as it was.
  fn plan(&self, params: &Fs1Params, leaf_deltas: Vec<(usize, usize, SeleneF)>) -> Result<Plan, Fs1Error> {
    let mut plan = Plan {
      selene: (0 .. self.selene.len()).map(|_| Vec::new()).collect(),
      helios: (0 .. self.helios.len()).map(|_| Vec::new()).collect(),
    };
    let mut selene_deltas = leaf_deltas;
    let mut level = 0;
    loop {
      #[cfg(test)]
      if FAIL_AT_LEVEL.with(|c| c.get()) == Some(level) {
        FAIL_AT_LEVEL.with(|c| c.set(None));
        return Err(Fs1Error::Blind);
      }
      let k = level / 2;
      let (writes, changed) = bump(&params.c1, &self.selene[k], self.empty.selene[k], &selene_deltas)?;
      plan.selene[k] = writes;
      if level == self.layers - 1 {
        break;
      }
      level += 1;
      #[cfg(test)]
      if FAIL_AT_LEVEL.with(|c| c.get()) == Some(level) {
        FAIL_AT_LEVEL.with(|c| c.set(None));
        return Err(Fs1Error::Blind);
      }
      let helios_deltas: Vec<(usize, usize, HeliosF)> =
        changed.into_iter().map(|(n, dx)| (n / LAYER_TWO_LEN, n % LAYER_TWO_LEN, dx)).collect();
      let k = level / 2;
      let (writes, changed) = bump(&params.c2, &self.helios[k], self.empty.helios[k], &helios_deltas)?;
      plan.helios[k] = writes;
      if level == self.layers - 1 {
        break;
      }
      level += 1;
      selene_deltas = changed.into_iter().map(|(n, dx)| (n / LAYER_ONE_LEN, n % LAYER_ONE_LEN, dx)).collect();
    }
    Ok(plan)
  }

  /// Write a plan, then drop nodes past the tree's end. Cannot fail.
  fn apply(&mut self, plan: Plan) {
    for (k, writes) in plan.selene.into_iter().enumerate() {
      write(&mut self.selene[k], self.empty.selene[k], writes);
    }
    for (k, writes) in plan.helios.into_iter().enumerate() {
      write(&mut self.helios[k], self.empty.helios[k], writes);
    }
    self.trim();
  }

  /// Keep exactly the nodes a tree of `len` leaves has. The top level always has one.
  fn trim(&mut self) {
    let mut count = usize::try_from(self.len).unwrap_or(usize::MAX).div_ceil(LAYER_ONE_LEN);
    for level in 0 .. self.layers {
      if level > 0 {
        let width = if level % 2 == 1 { LAYER_TWO_LEN } else { LAYER_ONE_LEN };
        count = count.div_ceil(width);
      }
      if level == self.layers - 1 {
        count = 1;
      }
      if level % 2 == 0 {
        let empty = self.empty.selene[level / 2];
        let nodes = &mut self.selene[level / 2];
        nodes.nodes.resize(count, empty.0);
        nodes.xs.resize(count, empty.1);
      } else {
        let empty = self.empty.helios[level / 2];
        let nodes = &mut self.helios[level / 2];
        nodes.nodes.resize(count, empty.0);
        nodes.xs.resize(count, empty.1);
      }
    }
  }

  /// The leaf-chunk ids holding these leaf indices, sorted and deduplicated.
  pub fn chunks_of(indices: &[u64]) -> Vec<u64> {
    let mut chunks: Vec<u64> = indices.iter().map(|i| i / LAYER_ONE_LEN as u64).collect();
    chunks.sort_unstable();
    chunks.dedup();
    chunks
  }

  /// A prover-side copy of this tree that holds every level but only the named leaf chunks.
  pub fn snapshot(&self, chunks: &[u64]) -> TreeSnapshot {
    let held = chunks
      .iter()
      .filter_map(|&k| {
        let at = usize::try_from(k).ok()? * CHUNK_WORDS;
        self.words.get(at .. at + CHUNK_WORDS).map(|w| (k, w.to_vec()))
      })
      .collect();
    TreeSnapshot {
      layers: self.layers,
      len: self.len,
      root: Fs1Tree::root(self),
      selene_xs: self.selene.iter().map(|l| l.xs.clone()).collect(),
      helios_xs: self.helios.iter().map(|l| l.xs.clone()).collect(),
      empty_selene_x: self.empty.selene.iter().map(|e| e.1).collect(),
      empty_helios_x: self.empty.helios.iter().map(|e| e.1).collect(),
      held,
    }
  }

  fn upper_path(&self, chunk: usize) -> (Vec<Vec<HeliosF>>, Vec<Vec<SeleneF>>) {
    upper_path(
      self.layers,
      chunk,
      |k| &self.selene[k].xs,
      |k| &self.helios[k].xs,
      |k| self.empty.selene[k].1,
      |k| self.empty.helios[k].1,
    )
  }
}

/// The branches above the leaves for leaf chunk `chunk`, read through `ct_group`.
fn upper_path<'a>(
  layers: usize,
  chunk: usize,
  selene_xs: impl Fn(usize) -> &'a Vec<HeliosF>,
  helios_xs: impl Fn(usize) -> &'a Vec<SeleneF>,
  empty_selene_x: impl Fn(usize) -> HeliosF,
  empty_helios_x: impl Fn(usize) -> SeleneF,
) -> (Vec<Vec<HeliosF>>, Vec<Vec<SeleneF>>) {
  let mut curve_2_layers = Vec::new();
  let mut curve_1_layers = Vec::new();
  let mut at = chunk;
  for level in 1 .. layers {
    if level % 2 == 1 {
      let group = at / LAYER_TWO_LEN;
      let below = (level - 1) / 2;
      curve_2_layers.push(ct_group(selene_xs(below), group, LAYER_TWO_LEN, empty_selene_x(below)));
      at = group;
    } else {
      let group = at / LAYER_ONE_LEN;
      let below = (level - 2) / 2;
      curve_1_layers.push(ct_group(helios_xs(below), group, LAYER_ONE_LEN, empty_helios_x(below)));
      at = group;
    }
  }
  (curve_2_layers, curve_1_layers)
}

fn chunk_path(
  chunk_words: &[u64],
  slot: usize,
  upper: (Vec<Vec<HeliosF>>, Vec<Vec<SeleneF>>),
) -> Result<Path<ShearCurves>, Fs1Error> {
  let mut leaves = Vec::with_capacity(LAYER_ONE_LEN);
  for leaf in chunk_words.chunks_exact(LEAF_WORDS) {
    leaves.push(decode_leaf_ct(leaf)?);
  }
  let output = decode_leaf_ct(&ct_group(chunk_words, slot, LEAF_WORDS, 0u64))?;
  Ok(Path { output, leaves, curve_2_layers: upper.0, curve_1_layers: upper.1 })
}

fn top_root(layers: usize, selene: &[Level<SeleneG>], helios: &[Level<HeliosG>]) -> TreeRoot<Selene, Helios> {
  let top = layers - 1;
  if top % 2 == 0 {
    TreeRoot::C1(selene[top / 2].nodes[0])
  } else {
    TreeRoot::C2(helios[top / 2].nodes[0])
  }
}

impl Fs1Tree for ChainTree {
  fn layers(&self) -> usize {
    self.layers
  }

  fn root(&self) -> TreeRoot<Selene, Helios> {
    top_root(self.layers, &self.selene, &self.helios)
  }

  fn path(&self, index: u64) -> Result<Path<ShearCurves>, Fs1Error> {
    if index >= self.len {
      return Err(Fs1Error::Path);
    }
    let chunk = usize::try_from(index / LAYER_ONE_LEN as u64).map_err(|_| Fs1Error::Path)?;
    let slot = usize::try_from(index % LAYER_ONE_LEN as u64).map_err(|_| Fs1Error::Path)?;
    let chunk_words = ct_group(&self.words, chunk, CHUNK_WORDS, 0u64);
    chunk_path(&chunk_words, slot, self.upper_path(chunk))
  }
}

/// What a wallet holds to prove: every level's x coordinates and the leaf
/// chunks of its own notes.
///
/// Its size is about `32 · len / 38` bytes plus 3,648 bytes per held chunk.
pub struct TreeSnapshot {
  layers: usize,
  len: u64,
  root: TreeRoot<Selene, Helios>,
  selene_xs: Vec<Vec<HeliosF>>,
  helios_xs: Vec<Vec<SeleneF>>,
  empty_selene_x: Vec<HeliosF>,
  empty_helios_x: Vec<SeleneF>,
  held: Vec<(u64, Vec<u64>)>,
}

impl TreeSnapshot {
  /// Bytes of tree data this snapshot holds.
  pub fn data_bytes(&self) -> usize {
    let xs: usize = self.selene_xs.iter().map(Vec::len).sum::<usize>() + self.helios_xs.iter().map(Vec::len).sum::<usize>();
    xs * 32 + self.held.len() * (8 + CHUNK_WORDS * 8)
  }

  /// Leaves in the tree this snapshot was taken from.
  pub fn len(&self) -> u64 {
    self.len
  }

  /// True when the tree had no leaves.
  pub fn is_empty(&self) -> bool {
    self.len == 0
  }
}

impl Fs1Tree for TreeSnapshot {
  fn layers(&self) -> usize {
    self.layers
  }

  fn root(&self) -> TreeRoot<Selene, Helios> {
    self.root
  }

  /// Every held chunk is read through one conditional select, whichever one holds `index`.
  fn path(&self, index: u64) -> Result<Path<ShearCurves>, Fs1Error> {
    if index >= self.len {
      return Err(Fs1Error::Path);
    }
    let chunk = index / LAYER_ONE_LEN as u64;
    let slot = usize::try_from(index % LAYER_ONE_LEN as u64).map_err(|_| Fs1Error::Path)?;
    let mut words = vec![0u64; CHUNK_WORDS];
    let mut found = Choice::from(0);
    for (id, held) in &self.held {
      let hit = id.ct_eq(&chunk);
      found |= hit;
      for (out, word) in words.iter_mut().zip(held) {
        *out = u64::conditional_select(out, word, hit);
      }
    }
    if !bool::from(found) {
      return Err(Fs1Error::Path);
    }
    let chunk = usize::try_from(chunk).map_err(|_| Fs1Error::Path)?;
    let upper = upper_path(
      self.layers,
      chunk,
      |k| &self.selene_xs[k],
      |k| &self.helios_xs[k],
      |k| self.empty_selene_x[k],
      |k| self.empty_helios_x[k],
    );
    chunk_path(&words, slot, upper)
  }
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use crate::leaf::leaf_from_bytes;
  use crate::membership::tests::{note, params_8};
  use crate::membership::{prove, prove_threaded, verify, Tree, NOTE_PAYMENT};
  use crate::vectors::{hex, unhex32, Vectors};
  use curve25519_dalek::{constants::RISTRETTO_BASEPOINT_POINT, Scalar};

  pub(crate) fn chain_note(seed: u64) -> ChainNote {
    let p = RISTRETTO_BASEPOINT_POINT * Scalar::from(seed * 2 + 3);
    let c = RISTRETTO_BASEPOINT_POINT * Scalar::from(seed * 7 + 11);
    ChainNote { admit_pub: p.compress().to_bytes(), commit: c.compress().to_bytes() }
  }

  /// 1,024 notes at depth 7, connected in blocks of 64.
  pub(crate) fn chain_tree_1024() -> &'static ChainTree {
    static CELL: std::sync::OnceLock<ChainTree> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
      let params = params_8();
      let mut tree = ChainTree::new(params).expect("tree");
      let mut parent = [0u8; 32];
      for height in 1 ..= 16u64 {
        let notes: Vec<ChainNote> = (0 .. 64).map(|i| chain_note(height * 64 + i)).collect();
        tree.connect(params, height, id(height), parent, &notes).expect("connect");
        parent = id(height);
      }
      tree
    })
  }

  fn id(n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[.. 8].copy_from_slice(&n.to_le_bytes());
    out
  }

  fn fresh(params: &Fs1Params, chain: &[(u64, Vec<ChainNote>)]) -> ChainTree {
    let mut tree = ChainTree::new(params).expect("tree");
    let mut parent = [0u8; 32];
    for (height, notes) in chain {
      tree.connect(params, *height, id(*height * 1000 + notes.len() as u64), parent, notes).expect("connect");
      parent = id(*height * 1000 + notes.len() as u64);
    }
    tree
  }

  #[test]
  fn t3_incremental_equals_rebuilt_across_a_reorg() {
    let params = params_8();
    let block = |h: u64, n: u64, salt: u64| (h, (0 .. n).map(|i| chain_note(salt * 1000 + h * 100 + i)).collect::<Vec<_>>());
    let main = vec![block(1, 3, 0), block(2, 37, 0), block(3, 2, 0), block(4, 40, 0)];
    let side = vec![block(3, 39, 1), block(4, 0, 1), block(5, 1, 1)];
    let mut tree = fresh(params, &main);
    assert_eq!(tree.len(), 82);
    let tip_root = tree.root_bytes();
    for (height, notes) in main[2 ..].iter().rev() {
      tree.disconnect(params, id(*height * 1000 + notes.len() as u64)).expect("disconnect");
    }
    assert_eq!(tree.len(), 40);
    assert_eq!(tree.root_bytes(), fresh(params, &main[.. 2]).root_bytes());
    let mut parent = id(2 * 1000 + 37);
    for (height, notes) in &side {
      tree.connect(params, *height, id(*height * 1000 + notes.len() as u64), parent, notes).expect("side");
      parent = id(*height * 1000 + notes.len() as u64);
    }
    let mut side_chain = main[.. 2].to_vec();
    side_chain.extend(side.iter().cloned());
    assert_eq!(tree.root_bytes(), fresh(params, &side_chain).root_bytes());
    assert_ne!(tree.root_bytes(), tip_root);
    for (height, notes) in side.iter().rev() {
      tree.disconnect(params, id(*height * 1000 + notes.len() as u64)).expect("undo side");
    }
    let mut parent = id(2 * 1000 + 37);
    for (height, notes) in &main[2 ..] {
      tree.connect(params, *height, id(*height * 1000 + notes.len() as u64), parent, notes).expect("redo");
      parent = id(*height * 1000 + notes.len() as u64);
    }
    assert_eq!(tree.root_bytes(), tip_root);
  }

  #[test]
  fn t4_connect_and_disconnect_only_at_the_tip() {
    let params = params_8();
    let mut tree = ChainTree::new(params).expect("tree");
    tree.connect(params, 7, id(7), [0; 32], &[chain_note(1)]).expect("first");
    assert!(matches!(tree.connect(params, 9, id(9), id(7), &[]), Err(Fs1Error::Link)));
    assert!(matches!(tree.connect(params, 8, id(8), id(6), &[]), Err(Fs1Error::Link)));
    tree.connect(params, 8, id(8), id(7), &[]).expect("second");
    assert!(matches!(tree.disconnect(params, id(7)), Err(Fs1Error::Link)));
    tree.disconnect(params, id(8)).expect("tip");
    tree.disconnect(params, id(7)).expect("tip");
    assert!(tree.is_empty());
    assert_eq!(tree.root_bytes(), ChainTree::new(params).unwrap().root_bytes());
  }

  #[test]
  fn t2_same_leaves_give_the_synthetic_tree_root() {
    let params = params_8();
    for (len, layers) in [(1u64, 1usize), (30, 1), (39, 2), (700, 3), (1 << 10, DEPTH)] {
      let synthetic = Tree::build(params, len, layers).expect("tree");
      let mut chain = ChainTree::with_layers(params, layers).expect("tree");
      let leaves: Vec<_> = (0 .. len).map(|i| synthetic.leaf(i).unwrap()).collect();
      for part in leaves.chunks(97) {
        chain.append(params, part).expect("append");
      }
      assert_eq!(chain.root_bytes(), crate::root_bytes(&synthetic.root()), "{len} {layers}");
    }
  }

  fn assert_same(a: &ChainTree, b: &ChainTree, what: &str) {
    assert_eq!(a.len, b.len, "{what}");
    assert_eq!(a.words, b.words, "{what}");
    assert_eq!(a.blocks, b.blocks, "{what}");
    for (x, y) in a.selene.iter().zip(&b.selene) {
      assert!(x.nodes == y.nodes && x.xs == y.xs, "{what}");
    }
    for (x, y) in a.helios.iter().zip(&b.helios) {
      assert!(x.nodes == y.nodes && x.xs == y.xs, "{what}");
    }
  }

  #[test]
  fn a_failed_propagate_at_any_level_leaves_the_tree_unchanged() {
    let params = params_8();
    let block = |h: u64, n: u64| (0 .. n).map(|i| chain_note(h * 100 + i)).collect::<Vec<_>>();
    let mut tree = fresh(params, &[(1, block(1, 37))]);
    let tip = id(1000 + 37);
    for level in 0 .. tree.layers {
      let before = tree.clone();
      fail_next_propagate_at(level);
      assert!(matches!(tree.connect(params, 2, id(2), tip, &block(2, 41)), Err(Fs1Error::Blind)));
      assert_same(&tree, &before, &format!("connect, level {level}"));
      fail_next_propagate_at(level);
      assert!(matches!(tree.disconnect(params, tip), Err(Fs1Error::Blind)));
      assert_same(&tree, &before, &format!("disconnect, level {level}"));
    }
    tree.connect(params, 2, id(2), tip, &block(2, 41)).expect("connect");
    assert_eq!(tree.root_bytes(), fresh(params, &[(1, block(1, 37)), (2, block(2, 41))]).root_bytes());
    tree.disconnect(params, id(2)).expect("disconnect");
    assert_eq!(tree.root_bytes(), fresh(params, &[(1, block(1, 37))]).root_bytes());
  }

  #[test]
  fn l3_rejected_notes_take_no_slot() {
    let params = params_8();
    let mut tree = ChainTree::new(params).expect("tree");
    let mut bad = chain_note(5);
    bad.commit = [0; 32];
    let out = tree.connect(params, 1, id(1), [0; 32], &[chain_note(4), bad, chain_note(6)]).expect("connect");
    assert_eq!(out.iter().filter(|l| l.is_some()).count(), 2);
    assert!(out[1].is_none());
    assert_eq!(tree.len(), 2);
    let leaf = tree.leaf_bytes(1).expect("leaf");
    assert_eq!(leaf_from_bytes(&leaf), leaf_of(&chain_note(6)));
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn full_set_one_root_every_leaf_proves_and_any_change_moves_the_root() {
    let params = params_8();
    let notes: Vec<ChainNote> = (0 .. 80).map(chain_note).collect();
    let tree = fresh(params, &[(1, notes[.. 40].to_vec()), (2, notes[40 ..].to_vec())]);
    for index in [0u64, 37, 38, 79] {
      let proved = prove(params, &tree, &[note(index, 0, 80, NOTE_PAYMENT)]).expect("prove");
      assert_eq!(crate::root_bytes(&proved.root), tree.root_bytes());
      verify(params, &proved).expect("verify");
    }
    let mut changed = notes.clone();
    changed[3] = chain_note(1000);
    let other = fresh(params, &[(1, changed[.. 40].to_vec()), (2, changed[40 ..].to_vec())]);
    assert_ne!(other.root_bytes(), tree.root_bytes());
    assert!(matches!(prove(params, &tree, &[note(80, 0, 80, NOTE_PAYMENT)]), Err(Fs1Error::Path)));
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn snapshot_proves_its_held_chunks_with_bounded_data() {
    let params = params_8();
    let notes: Vec<ChainNote> = (0 .. 200).map(chain_note).collect();
    let tree = fresh(params, &[(1, notes)]);
    let owned = [5u64, 150, 199];
    let snap = tree.snapshot(&ChainTree::chunks_of(&owned));
    assert_eq!(crate::root_bytes(&snap.root()), tree.root_bytes());
    for index in owned {
      assert_eq!(snap.path(index).unwrap().leaves, tree.path(index).unwrap().leaves);
    }
    assert!(matches!(snap.path(60), Err(Fs1Error::Path)));
    assert!(snap.data_bytes() < 3 * (8 + CHUNK_WORDS * 8) + 32 * 16);
    let notes: Vec<_> = owned.iter().map(|&i| note(i, 0, 200, NOTE_PAYMENT)).collect();
    let proved = prove_threaded(params, &snap, &notes, 3).expect("prove");
    verify(params, &proved).expect("verify");
  }

  /// `vectors/tree_chain.txt`: real fixture notes and a reorg, replayed op by op.
  #[test]
  fn shared_chain_vector_replays_to_the_same_leaves_and_roots() {
    let params = params_8();
    let vectors = Vectors::tree_chain();
    let mut tree = ChainTree::new(params).expect("tree");
    let mut ops = 0;
    for row in &vectors.rows {
      match row[0].as_str() {
        "connect" => {
          let (label, height, id, parent) = (&row[1], row[2].parse().unwrap(), unhex32(&row[3]), unhex32(&row[4]));
          let block_notes = vectors.notes(label);
          let notes: Vec<ChainNote> = block_notes.iter().map(|n| n.0).collect();
          let leaves = tree.connect(params, height, id, parent, &notes).expect("connect");
          for ((_, want), got) in block_notes.iter().zip(&leaves) {
            assert_eq!(want.as_deref(), got.as_ref().map(|l| hex(l)).as_deref(), "{label}");
          }
          assert_eq!(tree.len().to_string(), row[5], "{label}");
          assert_eq!(hex(&tree.root_bytes()), row[6], "{label}");
          ops += 1;
        }
        "disconnect" => {
          tree.disconnect(params, unhex32(&row[2])).expect("disconnect");
          assert_eq!(tree.len().to_string(), row[3], "{}", row[1]);
          assert_eq!(hex(&tree.root_bytes()), row[4], "{}", row[1]);
          ops += 1;
        }
        _ => {}
      }
    }
    assert!(ops >= 8, "{ops}");
    assert_eq!(hex(&ChainTree::new(params).unwrap().root_bytes()), vectors.get("empty_root"));
  }
}
