//! Measure prove, verify, and serialised size for 1, 2, 4, and 8 inputs.
//!
//! Built only with `--features bench`. This binary is the only place a prove
//! duration is printed. The library does not log it.

use std::time::Instant;

use shear_fs1::{prove, verify, Fs1Params, OpenNote, Tree, DEPTH, NOTE_CHANGE, NOTE_PAYMENT};

fn note(leaf: u64, age: u64, set_size: u64, note_type: u8) -> OpenNote {
  OpenNote { leaf_index: leaf, note_age: age, set_size, note_type, anchor: [1; 32] }
}

fn main() {
  let params = Fs1Params::open(8).expect("test parameters");
  let size = 1u64 << 10;
  let tree = Tree::build(&params, size, DEPTH).expect("tree");
  let matrix = [note(0, 0, size, NOTE_PAYMENT), note(size - 1, 100_000, size, NOTE_CHANGE)];
  for (label, sample) in [("leaf0", matrix[0]), ("leaf-last-age-type", matrix[1])] {
    let started = Instant::now();
    let proved = prove(&params, &tree, &[sample]).expect("prove");
    let prove_ms = started.elapsed().as_millis();
    let started = Instant::now();
    verify(&params, &proved).expect("verify");
    let verify_ms = started.elapsed().as_millis();
    println!(
      "n=1 case={label} prove_ms={prove_ms} verify_ms={verify_ms} bytes={}",
      proved.bytes.len()
    );
  }

  for inputs in [2usize, 4, 8] {
    let notes: Vec<OpenNote> = (0 .. inputs)
      .map(|i| note(i as u64 * 101, i as u64, size, if i % 2 == 0 { NOTE_PAYMENT } else { NOTE_CHANGE }))
      .collect();
    let started = Instant::now();
    let proved = prove(&params, &tree, &notes).expect("prove");
    let prove_ms = started.elapsed().as_millis();
    let started = Instant::now();
    verify(&params, &proved).expect("verify");
    let verify_ms = started.elapsed().as_millis();
    println!("n={inputs} prove_ms={prove_ms} verify_ms={verify_ms} bytes={}", proved.bytes.len());
  }
}
