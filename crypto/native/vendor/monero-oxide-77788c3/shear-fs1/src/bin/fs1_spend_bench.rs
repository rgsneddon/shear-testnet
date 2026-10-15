//! Phone and desktop timing for the transaction-bound FS-1 spend the wallet
//! sends with (`spend::prove_spend` / `spend::verify_spend`, the same calls
//! libshear_admit's `shear_fs1_prove` makes).
//!
//! Built only with `--features bench`. This binary is the only place a spend
//! prove duration is printed. The library does not log it.
//!
//! `fs1_spend_bench [leaves] [runs] [threads] [inputs,...]`
//!
//! * `leaves`  admit-set size the tree is built over (default 4096)
//! * `runs`    proves per input count; the median is printed (default 3)
//! * `threads` prover threads, 0 for every core (default 0)
//! * `inputs`  comma list of input counts (default 1,2,5,8)
//!
//! One JSON line per measurement, then a `done` line.

use std::time::Instant;

use curve25519_dalek::{constants::RISTRETTO_BASEPOINT_POINT, Scalar};
use shear_fs1::{prove_spend, spend_blob_len, spend_root, tree_of_notes, verify_spend, ChainNote, SpendIn};

fn scalar(seed: u64, salt: u8) -> Scalar {
  let mut wide = [0u8; 64];
  wide[.. 8].copy_from_slice(&seed.to_le_bytes());
  wide[8] = salt;
  wide[9] = 0x5a;
  Scalar::from_bytes_mod_order_wide(&wide)
}

fn note_of(seed: u64) -> (ChainNote, Scalar) {
  let x = scalar(seed, 1);
  let r = scalar(seed, 2);
  let p = RISTRETTO_BASEPOINT_POINT * x;
  let c = RISTRETTO_BASEPOINT_POINT * Scalar::from(seed + 1) + shear_fs1::spend::note_h() * r;
  (ChainNote { admit_pub: p.compress().to_bytes(), commit: c.compress().to_bytes() }, x)
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

fn median(mut v: Vec<f64>) -> f64 {
  v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
  v[v.len() / 2]
}

fn ms(started: Instant) -> f64 {
  (started.elapsed().as_secs_f64() * 1e4).round() / 10.0
}

fn main() {
  let args: Vec<String> = std::env::args().collect();
  let leaves: u64 = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(4096).max(8);
  let runs: usize = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(3).max(1);
  let threads: usize = match args.get(3).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0) {
    0 => std::thread::available_parallelism().map(|p| p.get()).unwrap_or(1),
    t => t,
  };
  let counts: Vec<usize> = args
    .get(4)
    .map(|s| s.split(',').filter_map(|v| v.trim().parse().ok()).collect())
    .unwrap_or_else(|| vec![1, 2, 5, 8]);
  let cores = std::thread::available_parallelism().map(|p| p.get()).unwrap_or(1);

  let started = Instant::now();
  let params = shear_fs1::spend_params().expect("spend generators");
  let _ = params;
  println!("{{\"phase\":\"params\",\"ms\":{},\"rssKib\":{}}}", ms(started), status_kib("VmRSS:"));

  let started = Instant::now();
  let book: Vec<(ChainNote, Scalar)> = (0 .. leaves).map(note_of).collect();
  let notes: Vec<ChainNote> = book.iter().map(|(n, _)| n.clone()).collect();
  let notes_ms = ms(started);
  let started = Instant::now();
  let tree = tree_of_notes(&notes).expect("tree");
  let root = tree.root_bytes();
  println!(
    "{{\"phase\":\"tree\",\"leaves\":{leaves},\"ms\":{},\"perLeafUs\":{:.1},\"notesMs\":{notes_ms},\"cores\":{cores},\"rssKib\":{}}}",
    ms(started),
    started.elapsed().as_secs_f64() * 1e6 / leaves as f64,
    status_kib("VmRSS:"),
  );

  let digest = [7u8; 32];
  let anchor = 4096u64;
  for &n in &counts {
    if spend_blob_len(n).is_none() {
      println!("{{\"phase\":\"skip\",\"inputs\":{n},\"why\":\"consensus allows 1..8\"}}");
      continue;
    }
    let inputs: Vec<SpendIn> = (0 .. n as u64)
      .map(|i| {
        let index = (i * 977 + 13) % leaves;
        SpendIn { index, x: book[index as usize].1 }
      })
      .collect();
    let (mut prove, mut verify) = (Vec::new(), Vec::new());
    let (mut fs1_bytes, mut record_bytes) = (0, 0);
    for _ in 0 .. runs {
      let started = Instant::now();
      let out = prove_spend(&tree, &notes, &inputs, &digest, anchor, threads).expect("prove");
      prove.push(started.elapsed().as_secs_f64() * 1e3);
      assert_eq!(spend_root(&out.fs1), Some(root));
      fs1_bytes = out.fs1.len();
      record_bytes = out.records.len() * out.records.first().map(|r| r.len()).unwrap_or(0);
      let started = Instant::now();
      verify_spend(&out.fs1, &out.records, &root, &digest, anchor).expect("verify");
      verify.push(started.elapsed().as_secs_f64() * 1e3);
    }
    println!(
      "{{\"phase\":\"spend\",\"inputs\":{n},\"threads\":{threads},\"runs\":{runs},\"proveMs\":{:.0},\"verifyMs\":{:.1},\"fs1Bytes\":{fs1_bytes},\"recordBytes\":{record_bytes},\"peakKib\":{}}}",
      median(prove),
      median(verify),
      status_kib("VmHWM:"),
    );
  }
  println!("{{\"phase\":\"done\"}}");
}
