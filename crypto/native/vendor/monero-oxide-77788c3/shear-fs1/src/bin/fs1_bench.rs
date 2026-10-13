//! Measure prove, verify, and serialised size for 1, 2, 4, and 8 inputs.
//!
//! This binary is the only place a prove duration is printed. The library
//! does not log it.

use std::time::Instant;

use shear_fs1::{prove, verify, Fs1Params, OpenNote, DEPTH, NOTE_CHANGE, NOTE_PAYMENT};

fn note(leaf: u64, age: u64, set_size: u64, note_type: u8) -> OpenNote {
  OpenNote { leaf_index: leaf, note_age: age, set_size, note_type, anchor: [1; 32] }
}

fn main() {
  let params = Fs1Params::open(8).expect("test parameters");
  let matrix = [
    note(0, 0, 1, NOTE_PAYMENT),
    note(1 << 16, 100_000, 1 << 20, NOTE_CHANGE),
  ];
  for (label, sample) in [("leaf0", matrix[0]), ("leaf-age-type", matrix[1])] {
    let started = Instant::now();
    let proved = prove(&params, &[sample], DEPTH).expect("prove");
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
      .map(|i| note(i as u64, i as u64, 1 << 10, if i % 2 == 0 { NOTE_PAYMENT } else { NOTE_CHANGE }))
      .collect();
    let started = Instant::now();
    let proved = prove(&params, &notes, DEPTH).expect("prove");
    let prove_ms = started.elapsed().as_millis();
    let started = Instant::now();
    verify(&params, &proved).expect("verify");
    let verify_ms = started.elapsed().as_millis();
    println!("n={inputs} prove_ms={prove_ms} verify_ms={verify_ms} bytes={}", proved.bytes.len());
  }
}
