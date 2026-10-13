//! Shear adaptation of the vendored full-chain membership prover.
//!
//! This crate is not wired into consensus, the wallet, or `shear_admit`.
//! Curve parameters come only from the upstream insecure test generators,
//! behind `cfg(test)` or the `insecure-test-generators` feature. They are not
//! a consensus parameter set.

#![allow(non_snake_case)]
#![forbid(unsafe_code)]

pub mod ct;
pub mod membership;
pub mod rulings;
pub mod witness;

pub use membership::{
  proof_len, prove, root_bytes, tree_capacity, verify, Fs1Error, Fs1Params, OpenNote, Proved, Tree,
  DEPTH, NOTE_CHANGE, NOTE_PAYMENT,
};
pub use rulings::{
  consensus_accepts, reserve_wu, verify_weight, wallet_pad, INPUT_MAX, INPUT_MIN, PREFERRED_INPUTS,
  RESERVE_WU, W_FS1_BASE, W_FS1_PER_INPUT, W_OUT, W_TX,
};
pub use witness::{
  keyed_fetch_rejected, ClientIntent, SyncClient, SyncRange, SyncReject, SyncRequest, SyncServer,
  SYNC_EPOCH,
};
