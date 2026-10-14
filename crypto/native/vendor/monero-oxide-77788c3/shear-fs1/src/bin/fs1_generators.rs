//! Recompute every FS-1 generator and check `vectors/generators.txt`.
//!
//! Success prints `pending PA+CA ratification` and the Blake2b-512 digest.
//! A mismatch exits 1. This does not mark the set ratified.

use shear_fs1::{generators_match_derivation, vectors::hex, Fs1Params};

fn main() {
  let params = Fs1Params::fixed().expect("fixed generators");
  match generators_match_derivation(&params) {
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
