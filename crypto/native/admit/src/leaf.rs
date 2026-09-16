//! Leaf hashes. Dest membership leaf is H_to_field("shear-admit-leaf-v2" || P) in Pallas Fp.

use pasta_curves::{pallas, vesta};
use sha2::{Digest, Sha512};
use ff::{FromUniformBytes, PrimeField};

pub const DST_LEAF: &[u8] = b"shear-admit-leaf-v2";
pub const DST_JROOT: &[u8] = b"shear-jroot-v2";
pub const DST_C_LEAF: &[u8] = b"shear-admit-c-leaf-v2";

pub fn sha512_64(parts: &[&[u8]]) -> [u8; 64] {
    let mut h = Sha512::new();
    for p in parts {
        h.update(p);
    }
    let d = h.finalize();
    let mut o = [0u8; 64];
    o.copy_from_slice(&d);
    o
}

pub fn dest_leaf_fp(p: &[u8; 32]) -> [u8; 32] {
    let wide = sha512_64(&[DST_LEAF, p]);
    let b = pallas::Base::from_uniform_bytes(&wide);
    let mut o = [0u8; 32];
    o.copy_from_slice(b.to_repr().as_ref());
    o
}

/// C-tree stores the ristretto C bytes as two Pallas-base limbs (16+16).
pub fn c_leaf_scalar(c: &[u8; 32]) -> [u8; 32] {
    let wide = sha512_64(&[DST_C_LEAF, c]);
    let b = pallas::Base::from_uniform_bytes(&wide);
    let mut o = [0u8; 32];
    o.copy_from_slice(b.to_repr().as_ref());
    o
}

pub fn pallas_base_from_bytes(b: &[u8; 32]) -> Option<pallas::Base> {
    pallas::Base::from_repr((*b).into()).into()
}

pub fn vesta_scalar_from_fp_bytes(b: &[u8; 32]) -> Option<vesta::Scalar> {
    // Pallas base = Vesta scalar.
    vesta::Scalar::from_repr((*b).into()).into()
}

pub fn jroot_hash(pasta_root: &[u8; 32], c_root: &[u8; 32]) -> [u8; 32] {
    let wide = sha512_64(&[DST_JROOT, pasta_root, c_root]);
    let mut o = [0u8; 32];
    o.copy_from_slice(&wide[..32]);
    o
}
