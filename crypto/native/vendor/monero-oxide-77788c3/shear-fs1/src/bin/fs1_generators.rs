//! Recompute the spend generator set and check `vectors/generators.txt`.
//!
//! The set is `spend_params`: `E(H)` as the commitment blind, `B` for spend
//! auth, Blake2b `T`/`U`/`V`, then the Selene and Helios points. Success
//! prints `pending PA+CA ratification` and the Blake2b-512 digest. A mismatch
//! exits 1. This does not mark the set ratified.

use shear_fs1::{generators_match_derivation, spend_params, vectors::hex};

fn main() {
  let params = spend_params().expect("spend generators");
  match generators_match_derivation(params) {
    Ok(digest) => {
      println!("pending PA+CA ratification");
      println!("digest {}", hex(&digest));
    }
    Err(err) => {
      eprintln!("generator mismatch: {err}");
      std::process::exit(1);
    }
  }
}
