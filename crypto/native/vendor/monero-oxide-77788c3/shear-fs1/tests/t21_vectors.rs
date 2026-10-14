//! `crypto/vectors/t21_voucher.txt` and `t21_splitlaw.json`, the files the JS tests read.

use curve25519_dalek::{
  ristretto::{CompressedRistretto, RistrettoPoint},
  Scalar,
};
use shear_fs1::{
  t21::{encrypt_limb, pedersen, split_law, t21_nonce, vault_blind, voucher_keys_ok, voucher_lambda, voucher_probe},
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

const PROVER: &str = include_str!("../../../../../vectors/t21_prover.txt");

fn unhex(text: &str) -> Vec<u8> {
  if text == "-" {
    return vec![];
  }
  (0 .. text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i .. i + 2], 16).expect("hex")).collect()
}

fn point(bytes: [u8; 32]) -> RistrettoPoint {
  CompressedRistretto(bytes).decompress().expect("point")
}

#[test]
fn prover_primitives_match_the_js_prover() {
  let mut h = None;
  let (mut nonces, mut vaults, mut limbs) = (0, 0, 0);
  for line in PROVER.lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
    let c: Vec<&str> = line.split('\t').collect();
    match c[0] {
      "H" => h = Some(point(h32(c[1]))),
      "nonce" => {
        let got = t21_nonce(&unhex(c[1]), c[2].as_bytes(), c[3].parse().unwrap(), c[4].parse().unwrap(), &unhex(c[5]));
        assert_eq!(hex(&got.to_bytes()), c[6], "{line}");
        nonces += 1;
      }
      "vault" => {
        let h = h.expect("H row first");
        let r = vault_blind(&unhex(c[2]), c[3].parse().unwrap(), &h32(c[4])).expect("blind");
        assert_eq!(hex(&r.to_bytes()), c[5], "{line}");
        let v = Scalar::from(c[1].parse::<u64>().unwrap());
        assert_eq!(hex(&pedersen(v, r, &h).compress().to_bytes()), c[6], "{line}");
        vaults += 1;
      }
      "limb" => {
        let h = h.expect("H row first");
        let t = Scalar::from_canonical_bytes(h32(c[3])).unwrap();
        let s = Scalar::from_canonical_bytes(h32(c[4])).unwrap();
        let got = encrypt_limb(c[1].parse().unwrap(), &point(h32(c[2])), t, s, &h);
        assert_eq!([hex(&got[0]), hex(&got[1]), hex(&got[2])], [c[5], c[6], c[7]], "{line}");
        limbs += 1;
      }
      other => panic!("row {other}"),
    }
  }
  assert!(nonces >= 72 && vaults >= 3 && limbs >= 4, "{nonces} {vaults} {limbs}");
}
