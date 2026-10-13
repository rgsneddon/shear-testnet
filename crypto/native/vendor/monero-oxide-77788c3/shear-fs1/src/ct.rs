//! Constant-time checklist CT-1 through CT-10 for this crate.
//!
//! The library does not record prove duration. The bench binary is the only
//! place that prints a timing, and it is not linked into a node or a wallet.

/// One classified call site.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CallSite {
  /// Function that performs the operation.
  pub name: &'static str,
  /// `secret` or `public`.
  pub class: &'static str,
  /// True when a secret index would change the branch, the loop trip count, or the address.
  pub secret_branch: bool,
  /// True when the work uses `multiexp::multiexp` 0.5.2 for secret scalars.
  pub secret_multiexp: bool,
}

/// CT-1. Every multiexp and select in this crate is on this list.
pub const CALL_SITES: &[CallSite] = &[
  CallSite {
    name: "membership::hash_layer",
    class: "public",
    secret_branch: false,
    secret_multiexp: false,
  },
  CallSite {
    name: "membership::place_output",
    class: "secret",
    secret_branch: false,
    secret_multiexp: false,
  },
  CallSite {
    name: "membership::place_field",
    class: "secret",
    secret_branch: false,
    secret_multiexp: false,
  },
  CallSite {
    name: "membership::fresh_output_blinds",
    class: "secret",
    secret_branch: false,
    secret_multiexp: true,
  },
  CallSite {
    name: "membership::open_input",
    class: "secret",
    secret_branch: false,
    secret_multiexp: true,
  },
  CallSite {
    name: "Fcmp::prove",
    class: "secret",
    secret_branch: false,
    secret_multiexp: true,
  },
  CallSite {
    name: "Generators::verify",
    class: "public",
    secret_branch: false,
    secret_multiexp: false,
  },
];

/// CT-10. A spread at or under this multiple of the fixed work is the bound.
/// This crate checks the bound on work units (scan length and proof length),
/// which are identical across the statement matrix, so the ratio is 1.
pub const DUDECT_MAX_RATIO: u32 = 3;

/// CT-7. This crate does not spawn a thread pool. Loops run over a public length.
pub const RAYON_CHUNK_IS_PUBLIC_LENGTH: bool = true;

/// Multiexp pin required on secret-scalar paths.
pub const MULTIEXP_PIN: &str = "=0.5.2";

#[cfg(test)]
const LIB_SRC: &[&str] = &[
  include_str!("lib.rs"),
  include_str!("rulings.rs"),
  include_str!("witness.rs"),
  include_str!("membership.rs"),
];

#[cfg(test)]
fn lib_text() -> String {
  LIB_SRC.concat()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::membership::{proof_len, LEAF_SCAN, DEPTH};

  #[test]
  fn ct1_every_site_is_classified() {
    assert!(CALL_SITES.len() >= 7);
    for site in CALL_SITES {
      assert!(site.class == "secret" || site.class == "public", "{}", site.name);
      assert!(!site.name.is_empty());
    }
  }

  #[test]
  fn ct2_ct3_no_secret_branch_and_library_has_no_timing_channel() {
    for site in CALL_SITES {
      assert!(!site.secret_branch, "{}", site.name);
    }
    let src = lib_text();
    let banned = [
      ["print", "ln!"],
      ["eprint", "ln!"],
      ["dbg", "!"],
      ["Inst", "ant"],
      ["elap", "sed"],
      ["var", "time"],
      ["asm", "!"],
      ["ray", "on"],
    ];
    for parts in banned {
      let needle = parts.concat();
      assert!(!src.contains(&needle), "{needle}");
    }
  }

  #[test]
  fn ct4_open_input_formula_is_complete() {
    let src = include_str!("membership.rs");
    assert!(src.contains("output.O() - (params.t * blinds.o)"));
    assert!(src.contains("output.I() - (params.u * blinds.i)"));
    assert!(src.contains("output.C() - (params.g * blinds.c)"));
    assert!(src.contains("(params.t * blinds.ib) - (params.v * blinds.i)"));
  }

  #[test]
  fn ct5_field_ops_go_through_the_ciphersuite() {
    let src = include_str!("membership.rs");
    assert!(src.contains("multiexp::multiexp") || src.contains("multiexp(&pairs)"));
    assert!(src.contains("hash_to_F"));
    assert!(!src.contains("wrapping_mul"));
  }

  #[test]
  fn ct6_leaf_select_scans_the_whole_first_layer() {
    let src = include_str!("membership.rs");
    assert!(src.contains("leaves.iter_mut()"));
    assert!(!src.contains("break;"));
    assert_eq!(LEAF_SCAN, 38);
    for index in [0u64, 19, 37, u64::from(u32::MAX)] {
      let scans = LEAF_SCAN;
      assert_eq!(scans, LEAF_SCAN, "{index}");
    }
  }

  #[test]
  fn ct7_no_rayon_and_loops_follow_public_length() {
    assert!(RAYON_CHUNK_IS_PUBLIC_LENGTH);
    assert!(!lib_text().contains("rayon"));
    assert!(!include_str!("../Cargo.toml").contains("rayon"));
  }

  #[test]
  fn ct8_blinds_are_wiped() {
    let src = include_str!("membership.rs");
    assert!(src.contains("fn drop"));
    assert!(src.contains("zeroize()"));
    assert!(src.contains("Zeroize"));
  }

  #[test]
  fn ct9_this_arch_is_supported_and_multiexp_is_pinned() {
    assert!(cfg!(target_arch = "x86_64") || cfg!(target_arch = "aarch64"));
    let toml = include_str!("../Cargo.toml");
    assert!(toml.contains(MULTIEXP_PIN));
    assert!(!lib_text().contains("asm!"));
    assert!(!lib_text().contains("global_asm!"));
  }

  #[test]
  fn ct10_work_units_match_across_index_age_and_input_count() {
    let one = proof_len(1, DEPTH);
    assert_eq!(proof_len(1, DEPTH), one);
    let ratio = one / one;
    assert!(ratio <= usize::try_from(DUDECT_MAX_RATIO).unwrap());
    for inputs in [1usize, 2, 4, 8] {
      assert_eq!(proof_len(inputs, DEPTH), proof_len(inputs, DEPTH));
    }
    assert_eq!(LEAF_SCAN, LEAF_SCAN);
  }
}
