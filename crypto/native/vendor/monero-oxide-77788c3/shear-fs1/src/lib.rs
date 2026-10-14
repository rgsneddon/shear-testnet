//! Shear adaptation of the vendored full-chain membership prover.
//!
//! This crate is not wired into consensus, the wallet, or `shear_admit`.
//! [`Fs1Params::fixed`] uses the generator derivation in [`generators`], which
//! is a Stage 3 proposal and not a ratified consensus set. The upstream
//! insecure test generators stay behind `cfg(test)` or the
//! `insecure-test-generators` feature.

#![allow(non_snake_case)]
#![forbid(unsafe_code)]

pub mod chain_tree;
pub mod ct;
pub mod generators;
pub mod leaf;
pub mod membership;
pub mod rulings;
pub mod t21;
pub mod t21_prove;
pub mod tree_cli;
pub mod vectors;
pub mod witness;

pub use chain_tree::{BlockMark, ChainTree, TreeSnapshot};
pub use generators::{generators_digest, GENERATOR_DST};
pub use leaf::{leaf_bytes, leaf_from_bytes, leaf_of, ChainNote, LEAF_BYTES};
pub use membership::{
  branch_blinds_per_input, empty_leaf, proof_len, prove, prove_prepared, prove_threaded, root_bytes,
  tree_capacity, verify, Fs1Error, Fs1Params, Fs1Tree, OpenNote, PreparedBlinds, Proved, Tree, DEPTH,
  NOTE_CHANGE, NOTE_PAYMENT,
};
pub use rulings::{
  consensus_accepts, reserve_wu, verify_weight, wallet_pad, INPUT_MAX, INPUT_MIN, PREFERRED_INPUTS,
  RESERVE_WU, W_FS1_BASE, W_FS1_PER_INPUT, W_OUT, W_TX,
};
pub use witness::{
  keyed_fetch_rejected, ClientIntent, SyncClient, SyncRange, SyncReject, SyncRequest, SyncServer,
  SYNC_EPOCH,
};
