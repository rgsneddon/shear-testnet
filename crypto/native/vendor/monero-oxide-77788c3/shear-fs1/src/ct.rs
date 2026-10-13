//! Constant-time checks CT-1 through CT-14 for this crate.
//!
//! Each check runs the code it names. CT-2, CT-10, CT-11 and CT-13 are dudect-style:
//! two input classes, interleaved in random order, timed, cropped, and
//! compared with Welch's t. CT-7 is `tests/ct7_threads.rs`.
//!
//! The library does not record prove duration. Timings are taken only in
//! these tests and in the bench binary, which is built only with `bench`.

/// dudect's bound for "definitely not constant time". A run fails above it.
pub const DUDECT_T_MAX: f64 = 10.0;

/// Multiexp version required on secret-scalar paths.
pub const MULTIEXP_PIN: &str = "0.5.2";

#[cfg(test)]
std::thread_local! {
  static SPAWNS: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
}

/// Counts prover threads started from the calling thread. Test builds only.
#[cfg(test)]
pub(crate) fn note_spawn() {
  SPAWNS.with(|c| c.set(c.get() + 1));
}

#[cfg(test)]
pub(crate) fn take_spawns() -> usize {
  SPAWNS.with(|c| c.replace(0))
}

/// Welch's t over two timing samples, after dropping the slowest tenth of each.
pub fn welch_t(a: &[f64], b: &[f64]) -> f64 {
  fn cropped(v: &[f64]) -> Vec<f64> {
    let mut v = v.to_vec();
    v.sort_by(|x, y| x.partial_cmp(y).unwrap_or(core::cmp::Ordering::Equal));
    let keep = (v.len() * 9 / 10).max(2);
    v.truncate(keep);
    v
  }
  fn mean_var(v: &[f64]) -> (f64, f64) {
    let n = v.len() as f64;
    let mean = v.iter().sum::<f64>() / n;
    let var = v.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (n - 1.0);
    (mean, var)
  }
  let (a, b) = (cropped(a), cropped(b));
  let (ma, va) = mean_var(&a);
  let (mb, vb) = mean_var(&b);
  let se = (va / a.len() as f64 + vb / b.len() as f64).sqrt();
  if se == 0.0 {
    return 0.0;
  }
  (ma - mb) / se
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::chain_tree::tests::chain_tree_1024;
  use crate::chain_tree::ChainTree;
  use crate::membership::tests::{note, params_8, tree_1, tree_2_10};
  use crate::membership::{
    ct_group, fresh_output_blinds, hash_layer, open_input_points, proof_len, prove, prove_prepared, prove_threaded,
    verify, BlindScalars, EdF, Fs1Tree, HeliosF, OpenNote, PreparedBlinds, Tree, DEPTH, LEAF_SCAN, NOTE_CHANGE,
    NOTE_PAYMENT,
  };
  use ciphersuite::group::ff::Field;
  use rand_core::{OsRng, RngCore};
  use std::cell::Cell;
  use std::time::Instant;
  use subtle::{Choice, ConditionallySelectable};

  thread_local! {
    static SELECTS: Cell<usize> = const { Cell::new(0) };
    static HITS: Cell<usize> = const { Cell::new(0) };
  }

  /// Counts every conditional select and every select that took the new value.
  #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
  struct Counted(u64);

  impl ConditionallySelectable for Counted {
    fn conditional_select(a: &Self, b: &Self, choice: Choice) -> Self {
      SELECTS.with(|c| c.set(c.get() + 1));
      HITS.with(|c| c.set(c.get() + usize::from(choice.unwrap_u8())));
      Counted(u64::conditional_select(&a.0, &b.0, choice))
    }
  }

  fn reset() {
    SELECTS.with(|c| c.set(0));
    HITS.with(|c| c.set(0));
  }

  fn order(n: usize) -> Vec<bool> {
    let mut classes: Vec<bool> = (0 .. n).map(|i| i % 2 == 0).collect();
    for i in (1 .. classes.len()).rev() {
      let j = usize::try_from(OsRng.next_u64() % (i as u64 + 1)).unwrap();
      classes.swap(i, j);
    }
    classes
  }

  #[test]
  fn ct1_ct6_secret_group_lookup_reads_the_whole_level_for_every_index() {
    for (len, width) in [(1usize, 18usize), (37, 38), (1534, 18), (27_595, 18), (41, 38)] {
      let level: Vec<Counted> = (0 .. len as u64).map(|i| Counted(i + 1)).collect();
      let groups = len.div_ceil(width);
      let mut counts = Vec::new();
      for g in [0, groups / 2, groups - 1] {
        reset();
        let out = ct_group(&level, g, width, Counted(0));
        counts.push(SELECTS.with(Cell::get));
        assert_eq!(HITS.with(Cell::get), width, "{len} {g}");
        for (j, got) in out.iter().enumerate() {
          let want = level.get(g * width + j).copied().unwrap_or(Counted(0));
          assert_eq!(*got, want, "{len} {g} {j}");
        }
      }
      assert!(counts.iter().all(|c| *c == groups * width), "{len} {counts:?}");
    }
  }

  #[test]
  fn ct2_dudect_group_lookup_time_does_not_depend_on_the_index() {
    let level: Vec<HeliosF> = (0 .. 1534).map(|_| HeliosF::random(&mut OsRng)).collect();
    let groups = level.len().div_ceil(18);
    let (mut fixed, mut random) = (Vec::new(), Vec::new());
    let mut sink = HeliosF::ZERO;
    for class in order(4_000) {
      // Both classes draw from the RNG, so only the index differs before the timed call.
      let r = OsRng.next_u64();
      let g = if class { 0 } else { usize::try_from(r % groups as u64).unwrap() };
      let started = Instant::now();
      let out = ct_group(&level, g, 18, HeliosF::ZERO);
      let took = started.elapsed().as_nanos() as f64;
      sink += out[0];
      if class {
        fixed.push(took);
      } else {
        random.push(took);
      }
    }
    let t = welch_t(&fixed, &random);
    assert!(t.abs() < DUDECT_T_MAX, "t = {t} sink {}", bool::from(sink.is_zero()));
  }

  #[test]
  fn ct3_two_private_statements_give_public_output_of_one_shape() {
    let params = params_8();
    let tree = tree_1();
    let a = prove(params, tree, &[note(0, 0, 30, NOTE_PAYMENT)]).expect("prove");
    let b = prove(params, tree, &[note(29, 123_456, 30, NOTE_CHANGE)]).expect("prove");
    verify(params, &a).expect("verify");
    verify(params, &b).expect("verify");
    assert_eq!(a.public_bytes().len(), b.public_bytes().len());
    assert_eq!(a.bytes.len(), proof_len(1, 1));
    assert_ne!(a.bytes, b.bytes);
    assert_ne!(a.input_bytes, b.input_bytes);
    assert_eq!(crate::root_bytes(&a.root), crate::root_bytes(&b.root));
  }

  #[test]
  fn ct4_open_input_adds_back_to_the_output() {
    let params = params_8();
    let tree = tree_1();
    for index in [0u64, 17, 29] {
      let output = tree.leaf(index).expect("leaf");
      let (_, blinds) = fresh_output_blinds(&mut OsRng, params);
      let [o, i, r, c] = open_input_points(&output, &blinds, params);
      assert_eq!(o + params.t * blinds.o, output.O());
      assert_eq!(i + params.u * blinds.i, output.I());
      assert_eq!(r, params.t * blinds.ib - params.v * blinds.i);
      assert_eq!(c + params.g * blinds.c, output.C());
      assert_ne!(o, output.O());
      assert_ne!(c, output.C());
    }
  }

  #[test]
  fn ct5_layer_hash_is_the_plain_sum_over_every_child() {
    let params = params_8();
    for width in [1usize, 18, 38, 228] {
      let children: Vec<<helioselene::Selene as ciphersuite::Ciphersuite>::F> =
        (0 .. width).map(|_| Field::random(&mut OsRng)).collect();
      let got = hash_layer(&params.c1, params.c1_init, &children);
      let mut want = params.c1_init;
      for (s, g) in children.iter().zip(params.c1.g_bold_slice()) {
        want += *g * *s;
      }
      assert_eq!(got, want, "{width}");
      let mut changed = children.clone();
      changed[width - 1] += <helioselene::Selene as ciphersuite::Ciphersuite>::F::ONE;
      assert_ne!(hash_layer(&params.c1, params.c1_init, &changed), got, "{width}");
    }
  }

  #[test]
  fn ct6_every_leaf_chunk_and_branch_is_full_width() {
    let params = params_8();
    let tree = Tree::build(params, 50, 3).expect("tree");
    for index in [0u64, 37, 38, 49] {
      let path = tree.path_for_test(index).expect("path");
      assert_eq!(path.leaves.len(), LEAF_SCAN);
      for layer in &path.curve_2_layers {
        assert_eq!(layer.len(), full_chain_membership_proofs::LAYER_TWO_LEN);
      }
      for layer in &path.curve_1_layers {
        assert_eq!(layer.len(), full_chain_membership_proofs::LAYER_ONE_LEN);
      }
      let start = index - index % 38;
      for (j, leaf) in path.leaves.iter().enumerate() {
        let at = start + j as u64;
        if at < tree.len() {
          assert_eq!(*leaf, tree.leaf(at).unwrap(), "{index} {j}");
        } else {
          assert_eq!(*leaf, tree.empty_leaf_for_test(), "{index} {j}");
        }
      }
      let proved = prove(params, &tree, &[note(index, 0, 50, NOTE_PAYMENT)]).expect("prove");
      verify(params, &proved).expect("verify");
    }
  }

  #[test]
  fn ct8_blinds_are_wiped() {
    let mut blinds = BlindScalars {
      o: EdF::random(&mut OsRng),
      i: EdF::random(&mut OsRng),
      ib: EdF::random(&mut OsRng),
      c: EdF::random(&mut OsRng),
    };
    assert!(!bool::from(blinds.o.is_zero()));
    blinds.wipe();
    for scalar in [blinds.o, blinds.i, blinds.ib, blinds.c] {
      assert!(bool::from(scalar.is_zero()));
    }
  }

  #[test]
  fn ct9_lockfile_resolves_one_pinned_multiexp_on_a_supported_arch() {
    assert!(cfg!(target_arch = "x86_64") || cfg!(target_arch = "aarch64"));
    let lock = include_str!("../../Cargo.lock");
    let mut versions = Vec::new();
    let mut in_multiexp = false;
    for line in lock.lines() {
      if line == "[[package]]" {
        in_multiexp = false;
      } else if line == "name = \"multiexp\"" {
        in_multiexp = true;
      } else if in_multiexp {
        if let Some(v) = line.strip_prefix("version = \"") {
          versions.push(v.trim_end_matches('"').to_string());
          in_multiexp = false;
        }
      }
    }
    assert_eq!(versions, vec![MULTIEXP_PIN.to_string()]);
  }

  #[test]
  fn welch_t_separates_two_shifted_samples_and_not_two_equal_ones() {
    let a: Vec<f64> = (0 .. 200).map(|i| 100.0 + f64::from(i % 7)).collect();
    let b: Vec<f64> = (0 .. 200).map(|i| 100.0 + f64::from((i + 3) % 7)).collect();
    let shifted: Vec<f64> = a.iter().map(|x| x + 20.0).collect();
    assert!(welch_t(&a, &b).abs() < 1.0);
    assert!(welch_t(&a, &shifted).abs() > DUDECT_T_MAX);
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn ct10_dudect_prove_time_does_not_depend_on_leaf_age_or_type() {
    let params = params_8();
    let tree = tree_2_10();
    let size = tree.len();
    let (mut fixed, mut random) = (Vec::new(), Vec::new());
    for class in order(24) {
      let one = if class {
        note(0, 0, size, NOTE_PAYMENT)
      } else {
        let leaf = OsRng.next_u64() % size;
        let ty = if OsRng.next_u32() % 2 == 0 { NOTE_PAYMENT } else { NOTE_CHANGE };
        note(leaf, OsRng.next_u64() % 1_000_000, size, ty)
      };
      let started = Instant::now();
      let proved = prove(params, tree, &[one]).expect("prove");
      let took = started.elapsed().as_nanos() as f64;
      assert_eq!(proved.bytes.len(), proof_len(1, DEPTH));
      if class {
        fixed.push(took);
      } else {
        random.push(took);
      }
    }
    let t = welch_t(&fixed, &random);
    assert!(t.abs() < DUDECT_T_MAX, "t = {t}");
  }

  fn random_note(size: u64) -> OpenNote {
    let ty = if OsRng.next_u32() % 2 == 0 { NOTE_PAYMENT } else { NOTE_CHANGE };
    note(OsRng.next_u64() % size, OsRng.next_u64() % 1_000_000, size, ty)
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn ct11_dudect_chain_tree_and_snapshot_path_time_does_not_depend_on_the_index() {
    let tree = chain_tree_1024();
    let size = tree.len();
    let held: Vec<u64> = (0 .. 8).map(|k| k * 3).collect();
    let snapshot = tree.snapshot(&held);
    let in_held = |r: u64| held[usize::try_from(r % held.len() as u64).unwrap()] * 38 + r % 38;
    let (mut fixed, mut random) = (Vec::new(), Vec::new());
    let (mut snap_fixed, mut snap_random) = (Vec::new(), Vec::new());
    for class in order(1_000) {
      let (r, s) = (OsRng.next_u64(), OsRng.next_u64());
      let index = if class { 0 } else { r % size };
      let started = Instant::now();
      let path = Fs1Tree::path(tree, index).expect("path");
      let took = started.elapsed().as_nanos() as f64;
      assert_eq!(path.leaves.len(), LEAF_SCAN);
      let index = if class { 0 } else { in_held(s) };
      let started = Instant::now();
      let snap = Fs1Tree::path(&snapshot, index).expect("snapshot path");
      let snap_took = started.elapsed().as_nanos() as f64;
      assert_eq!(snap.leaves.len(), LEAF_SCAN);
      if class {
        fixed.push(took);
        snap_fixed.push(snap_took);
      } else {
        random.push(took);
        snap_random.push(snap_took);
      }
    }
    let t = welch_t(&fixed, &random);
    assert!(t.abs() < DUDECT_T_MAX, "tree t = {t}");
    let t = welch_t(&snap_fixed, &snap_random);
    assert!(t.abs() < DUDECT_T_MAX, "snapshot t = {t}");
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn ct12_prover_threads_depend_only_on_input_and_thread_counts() {
    let params = params_8();
    let tree = chain_tree_1024();
    let size = tree.len();
    crate::ct::take_spawns();
    prove(params, tree, &[random_note(size), random_note(size)]).expect("prove");
    assert_eq!(crate::ct::take_spawns(), 0);
    let mut counts = Vec::new();
    for statement in [
      vec![note(0, 0, size, NOTE_PAYMENT), note(1, 0, size, NOTE_PAYMENT)],
      vec![note(size - 1, 999, size, NOTE_CHANGE), note(size - 1, 5, size, NOTE_PAYMENT)],
      vec![random_note(size), random_note(size)],
    ] {
      let proved = prove_threaded(params, tree, &statement, 4).expect("prove");
      counts.push(crate::ct::take_spawns());
      assert_eq!(proved.bytes.len(), proof_len(2, DEPTH));
      verify(params, &proved).expect("verify");
    }
    assert!(counts.iter().all(|c| *c == counts[0] && *c > 0), "{counts:?}");
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn ct13_dudect_threaded_and_prepared_prove_time_does_not_depend_on_the_statement() {
    let params = params_8();
    let tree = chain_tree_1024();
    let size = tree.len();
    let (mut fixed, mut random) = (Vec::new(), Vec::new());
    let (mut prep_fixed, mut prep_random) = (Vec::new(), Vec::new());
    for class in order(20) {
      let statement =
        if class { vec![note(0, 0, size, NOTE_PAYMENT); 2] } else { vec![random_note(size), random_note(size)] };
      let started = Instant::now();
      let proved = prove_threaded(params, tree, &statement, 4).expect("prove");
      let took = started.elapsed().as_nanos() as f64;
      assert_eq!(proved.bytes.len(), proof_len(2, DEPTH));
      let blinds = PreparedBlinds::prepare(params, 2, DEPTH, 4).expect("blinds");
      let started = Instant::now();
      let prepared = prove_prepared(params, tree, &statement, blinds, 4).expect("prove prepared");
      let prep_took = started.elapsed().as_nanos() as f64;
      assert_eq!(prepared.bytes.len(), proof_len(2, DEPTH));
      if class {
        fixed.push(took);
        prep_fixed.push(prep_took);
      } else {
        random.push(took);
        prep_random.push(prep_took);
      }
    }
    let t = welch_t(&fixed, &random);
    assert!(t.abs() < DUDECT_T_MAX, "threaded t = {t}");
    let t = welch_t(&prep_fixed, &prep_random);
    assert!(t.abs() < DUDECT_T_MAX, "prepared t = {t}");
  }

  #[test]
  #[cfg_attr(debug_assertions, ignore = "release only")]
  fn ct14_proofs_and_public_bytes_hold_no_leaf_index_or_chain_position() {
    let params = params_8();
    let tree: &ChainTree = chain_tree_1024();
    let proved = prove(params, tree, &[note(700, 3, tree.len(), NOTE_PAYMENT)]).expect("prove");
    let public = proved.public_bytes();
    let leaf = tree.leaf_bytes(700).expect("leaf");
    for window in [&leaf[.. 32], &leaf[32 .. 64], &leaf[64 ..], &700u64.to_le_bytes()[..]] {
      assert!(!public.windows(window.len()).any(|w| w == window));
    }
    assert_eq!(public.len(), proof_len(1, DEPTH) + 128 + 32);
  }
}
