//! Measure prove, verify, size, and peak memory for 1, 2, 4, and 8 inputs.
//!
//! Built only with `--features bench`. This binary is the only place a prove
//! duration is printed. The library does not log it.
//!
//! `fs1_bench [threads] [runs]` runs each case in a child process, so each
//! peak-memory figure covers one case. A case is `fs1_bench case <inputs>
//! <threads> <runs>`. Every case proves against a depth-7 [`ChainTree`] of
//! 1,024 chain notes.

use std::time::Instant;

use shear_fs1::{
  prove_prepared, prove_threaded, verify, ChainNote, ChainTree, Fs1Params, OpenNote, PreparedBlinds,
  DEPTH, NOTE_CHANGE, NOTE_PAYMENT,
};

const TREE_NOTES: u64 = 1 << 10;

fn note(leaf: u64, age: u64, note_type: u8) -> OpenNote {
  OpenNote { leaf_index: leaf, note_age: age, set_size: TREE_NOTES, note_type, anchor: [1; 32] }
}

fn chain_note(seed: u64) -> ChainNote {
  use curve25519_dalek::{constants::RISTRETTO_BASEPOINT_POINT, Scalar};
  let p = RISTRETTO_BASEPOINT_POINT * Scalar::from(seed * 2 + 3);
  let c = RISTRETTO_BASEPOINT_POINT * Scalar::from(seed * 7 + 11);
  ChainNote { admit_pub: p.compress().to_bytes(), commit: c.compress().to_bytes() }
}

fn status_kib(field: &str) -> u64 {
  std::fs::read_to_string("/proc/self/status")
    .ok()
    .and_then(|s| {
      s.lines()
        .find(|l| l.starts_with(field))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse().ok())
    })
    .unwrap_or(0)
}

/// Linux: writing 5 to `clear_refs` resets the peak resident set to the current one.
fn reset_peak() {
  let _ = std::fs::write("/proc/self/clear_refs", "5");
}

fn median(mut v: Vec<f64>) -> f64 {
  v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
  v[v.len() / 2]
}

fn case(inputs: usize, threads: usize, runs: usize) {
  let started = Instant::now();
  let params = Fs1Params::fixed().expect("fixed generators");
  let params_ms = started.elapsed().as_secs_f64() * 1e3;
  let params_kib = status_kib("VmRSS:");

  let started = Instant::now();
  let mut tree = ChainTree::new(&params).expect("tree");
  let notes: Vec<ChainNote> = (0 .. TREE_NOTES).map(chain_note).collect();
  let mut parent = [0u8; 32];
  for (height, block) in notes.chunks(64).enumerate() {
    let mut id = [0u8; 32];
    id[.. 8].copy_from_slice(&(height as u64 + 1).to_le_bytes());
    tree.connect(&params, height as u64 + 1, id, parent, block).expect("connect");
    parent = id;
  }
  let tree_ms = started.elapsed().as_secs_f64() * 1e3;

  let spend: Vec<OpenNote> = (0 .. inputs as u64)
    .map(|i| note(i * 101 + 7, i, if i % 2 == 0 { NOTE_PAYMENT } else { NOTE_CHANGE }))
    .collect();

  let base_kib = status_kib("VmRSS:");
  reset_peak();
  let (mut full, mut prep, mut critical, mut ver) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
  let mut bytes = 0;
  for _ in 0 .. runs {
    let started = Instant::now();
    let proved = prove_threaded(&params, &tree, &spend, threads).expect("prove");
    full.push(started.elapsed().as_secs_f64() * 1e3);
    bytes = proved.bytes.len();
    let started = Instant::now();
    verify(&params, &proved).expect("verify");
    ver.push(started.elapsed().as_secs_f64() * 1e3);

    let started = Instant::now();
    let blinds = PreparedBlinds::prepare(&params, inputs, DEPTH, threads).expect("blinds");
    prep.push(started.elapsed().as_secs_f64() * 1e3);
    let started = Instant::now();
    let proved = prove_prepared(&params, &tree, &spend, blinds, threads).expect("prove");
    critical.push(started.elapsed().as_secs_f64() * 1e3);
    verify(&params, &proved).expect("verify");
  }
  let peak_kib = status_kib("VmHWM:");
  println!(
    "inputs={inputs} threads={threads} runs={runs} prove_ms={:.0} blinds_ms={:.0} prove_after_blinds_ms={:.0} \
     verify_ms={:.1} bytes={bytes} peak_rss_mib={:.1} prove_extra_mib={:.1} params_ms={params_ms:.0} \
     params_rss_mib={:.1} tree_ms={tree_ms:.0}",
    median(full),
    median(prep),
    median(critical),
    median(ver),
    peak_kib as f64 / 1024.0,
    peak_kib.saturating_sub(base_kib) as f64 / 1024.0,
    params_kib as f64 / 1024.0,
  );
}

fn main() {
  let args: Vec<String> = std::env::args().collect();
  if args.get(1).map(String::as_str) == Some("case") {
    let n = |i: usize| args.get(i).and_then(|v| v.parse().ok()).expect("case <inputs> <threads> <runs>");
    case(n(2), n(3), n(4));
    return;
  }
  let threads: usize = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(1);
  let runs: usize = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(3);
  let exe = std::env::current_exe().expect("own path");
  for inputs in [1usize, 2, 4, 8] {
    let status = std::process::Command::new(&exe)
      .args(["case", &inputs.to_string(), &threads.to_string(), &runs.to_string()])
      .status()
      .expect("run case");
    assert!(status.success());
  }
}
