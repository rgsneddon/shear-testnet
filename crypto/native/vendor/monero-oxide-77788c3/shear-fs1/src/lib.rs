//! Shear adaptation of the vendored full-chain membership prover.
//!
//! [`Fs1Params::fixed`] uses the generator derivation in [`generators`].
//! The pinned digest is [`spend_params`]: `E(H)`, the auth basepoint `B`,
//! and the same `T`/`U`/`V` and curve points. Status: pending PA+CA
//! ratification. It is not a ratified consensus set.
//! The upstream insecure test generators stay behind `cfg(test)` or the
//! `insecure-test-generators` feature and are never a consensus set.

#![allow(non_snake_case)]
#![forbid(unsafe_code)]

pub mod chain_tree;
pub mod ct;
pub mod generators;
pub mod leaf;
pub mod membership;
pub mod rulings;
pub mod spend;
pub mod tree_cli;
pub mod vectors;
pub mod witness;

pub use chain_tree::{BlockMark, ChainTree, TreeSnapshot};
pub use generators::{generators_digest, generators_match_derivation, GENERATOR_DST};
pub use leaf::{leaf_bytes, leaf_from_bytes, leaf_of, ChainNote, LEAF_BYTES};
pub use membership::{
  branch_blinds_per_input, empty_leaf, proof_len, prove, prove_prepared, prove_threaded, root_bytes,
  tree_capacity, verify, Fs1Error, Fs1Params, Fs1Tree, OpenNote, PreparedBlinds, Proved, Tree,
  ADMIT_CYCLE, CYCLE_C1, CYCLE_C2, DEPTH, NOTE_CHANGE, NOTE_PAYMENT,
};
pub use rulings::{
  consensus_accepts, reserve_wu, verify_weight, wallet_pad, INPUT_MAX, INPUT_MIN, PREFERRED_INPUTS,
  RESERVE_WU, W_FS1_BASE, W_FS1_PER_INPUT, W_OUT, W_TX,
};
pub use spend::{
  prove_spend, prove_spend_unlinked, spend_blob_fits, spend_blob_len, spend_params, spend_root, tree_of_notes,
  verify_spend, verify_spend_unlinked, SpendIn, SpendOut,
  RECORD_BYTES, SAL_BYTES, SPEND_HEAD, SPEND_WIRE,
};
pub use witness::{
  keyed_fetch_rejected, ClientIntent, SyncClient, SyncRange, SyncReject, SyncRequest, SyncServer,
  SYNC_EPOCH,
};
