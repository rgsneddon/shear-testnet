//! The T21 row prover `crypto/t21_native.js` drives: one request on stdin, one
//! reply on stdout. Built only with `--features t21-prove`. The protocol is
//! [`shear_fs1::t21_prove`].
//!
//! `t21_prove [--threads N]` serves a request. `t21_prove --bench ROWS SHARES
//! [--threads N]` times both phases on synthetic rows and prints one line.

use std::{
  io::{Read, Write},
  time::Instant,
};

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
use shear_fs1::{
  t21::{t21_nonce, voucher_lambda},
  t21_prove::{
    commit_row, note_h, par_map, prove_row, prove_tally, serve, BlockId, CommitRow, ProveRow, Share, MAX_REQUEST,
  },
};

fn threads(args: &[String]) -> usize {
  let from_arg = args.iter().position(|a| a == "--threads").and_then(|i| args.get(i + 1)).and_then(|v| v.parse().ok());
  let from_env = std::env::var("SHEAR_T21_PROVE_THREADS").ok().and_then(|v| v.parse().ok());
  from_arg
    .or(from_env)
    .filter(|n: &usize| *n > 0)
    .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
    .min(256)
}

fn bench(rows: usize, per_row: usize, threads: usize) {
  let seed = [5u8; 32];
  let block = BlockId { magic: b"shear-testnet-v12".to_vec(), height: 11, prev_hash: vec![1; 32] };
  let h = note_h();
  let key = |tag: &[u8], i: usize| (RISTRETTO_BASEPOINT_POINT * t21_nonce(&seed, tag, i as u32, 0, &[])).compress().to_bytes();
  let weights: Vec<Vec<u128>> =
    (0 .. rows).map(|i| (0 .. per_row).map(|k| 1000 + (i * per_row + k) as u128).collect()).collect();
  let w: u128 = weights.iter().flatten().sum();
  let rate: u128 = 50_000_000_000 + 7 + 3 * w;
  let commit_in: Vec<CommitRow> = (0 .. rows)
    .map(|i| {
      let wi: u128 = weights[i].iter().sum();
      let num = rate * wi;
      CommitRow {
        index: i as u32,
        no_leaf: false,
        v: (num / w) as u64,
        wi,
        rho: num % w,
        b: key(b"bench-b", i),
        y: key(b"bench-y", i),
      }
    })
    .collect();
  let t0 = Instant::now();
  let committed = par_map(rows, threads, |i| commit_row(&seed, &block, w, &commit_in[i])).expect("commit");
  let t1 = Instant::now();
  let stmt = [7u8; 32];
  let prove_in: Vec<ProveRow> = commit_in
    .iter()
    .zip(&committed)
    .map(|(c, k)| ProveRow {
      index: c.index,
      n: k.n,
      v: c.v,
      wi: c.wi,
      rho: c.rho,
      fin_eff: 0,
      y: c.y,
      lambda: voucher_lambda(&c.b, &c.y).to_bytes(),
    })
    .collect();
  let mut shares = vec![];
  for (i, ws) in weights.iter().enumerate() {
    let ell = voucher_lambda(&commit_in[i].b, &commit_in[i].y);
    for (k, wv) in ws.iter().enumerate() {
      let beta = t21_nonce(&seed, b"bench-beta", i as u32, k as u32, &[]);
      let e = (RISTRETTO_BASEPOINT_POINT * ell + h * beta).compress().to_bytes();
      shares.push(Share { w: *wv, e, ell, beta });
    }
  }
  let proved = par_map(rows, threads, |i| prove_row(&seed, &stmt, w, rate, &prove_in[i])).expect("prove");
  let t2 = Instant::now();
  let tally = prove_tally(&seed, &stmt, w, &prove_in, &shares, threads).expect("tally");
  let t3 = Instant::now();
  assert_eq!(proved.len(), rows);
  assert_eq!(tally.inv.len(), shares.len());
  println!(
    "rows={rows} shares={} threads={threads} commit={:.2}s prove={:.2}s tally={:.2}s total={:.2}s",
    shares.len(),
    (t1 - t0).as_secs_f64(),
    (t2 - t1).as_secs_f64(),
    (t3 - t2).as_secs_f64(),
    (t3 - t0).as_secs_f64(),
  );
}

fn main() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let threads = threads(&args);
  if let Some(at) = args.iter().position(|a| a == "--bench") {
    let num = |k: usize| args.get(at + k).and_then(|v| v.parse::<usize>().ok()).expect("--bench ROWS SHARES");
    bench(num(1), num(2), threads);
    return;
  }
  let mut buf = Vec::new();
  let read = std::io::stdin().lock().take(MAX_REQUEST as u64 + 1).read_to_end(&mut buf);
  let reply = match (read, String::from_utf8(buf)) {
    (Ok(n), _) if n > MAX_REQUEST => "error request_cap -\n".to_string(),
    (Ok(_), Ok(text)) => serve(&text, threads),
    _ => "error request -\n".to_string(),
  };
  let mut out = std::io::stdout().lock();
  if out.write_all(reply.as_bytes()).and_then(|()| out.flush()).is_err() {
    std::process::exit(1);
  }
}
