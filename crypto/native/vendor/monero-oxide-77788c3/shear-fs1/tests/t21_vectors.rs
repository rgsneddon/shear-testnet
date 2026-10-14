//! `crypto/vectors/t21_voucher.txt` and `t21_splitlaw.json`, the files the JS tests read.

use shear_fs1::{
  t21::{split_law, voucher_keys_ok, voucher_lambda, voucher_probe},
  vectors::{hex, unhex_n},
};

const VOUCHERS: &str = include_str!("../../../../../vectors/t21_voucher.txt");
const SPLIT_LAW: &str = include_str!("../../../../../vectors/t21_splitlaw.json");

fn h32(text: &str) -> [u8; 32] {
  unhex_n::<32>(text).expect("32 bytes of hex")
}

#[test]
fn voucher_vector_matches_the_js_check() {
  let mut rows = 0;
  let mut accepted = 0;
  for line in VOUCHERS.lines() {
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    let cols: Vec<&str> = line.split('\t').collect();
    assert_eq!(cols.len(), 7, "{line}");
    let (b, y, lambda) = (h32(cols[1]), h32(cols[2]), h32(cols[3]));
    let ok = voucher_keys_ok(&b, &y, &lambda);
    assert_eq!(ok, cols[6] == "ok", "{}", cols[0]);
    if ok {
      assert_eq!(voucher_lambda(&b, &y).to_bytes(), lambda, "{} lambda", cols[0]);
      let (probe_c, p) = voucher_probe(&b).expect("probe");
      assert_eq!(hex(&probe_c), cols[4], "{} probeC", cols[0]);
      assert_eq!(hex(&p), cols[5], "{} P", cols[0]);
      accepted += 1;
    }
    rows += 1;
  }
  assert!(rows >= 12 && accepted >= 4, "{rows} {accepted}");
}

fn field(obj: &str, key: &str) -> u128 {
  let tag = format!("\"{key}\": \"");
  let at = obj.find(&tag).unwrap_or_else(|| panic!("{key} in {obj}")) + tag.len();
  let end = obj[at ..].find('"').expect("closing quote") + at;
  obj[at .. end].parse().expect("decimal")
}

#[test]
fn split_law_vector_matches_the_js_law() {
  let mut rows = 0;
  for line in SPLIT_LAW.lines().filter(|l| l.contains("\"Wi\"")) {
    let got = split_law(field(line, "R"), field(line, "W"), field(line, "Wi"), field(line, "u"), field(line, "fin"));
    assert_eq!(got, Some((field(line, "v"), field(line, "rho"))), "{line}");
    rows += 1;
  }
  assert!(rows >= 5, "{rows}");
  assert_eq!(split_law(1, 0, 0, 0, 0), None);
  assert_eq!(split_law(1, 2, 3, 0, 0), None);
}
