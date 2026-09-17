//! ADMITv2 prove / verify. Version byte 2. ADMITv1 (linear r) fails.

use crate::leaf::{c_leaf_scalar, dest_leaf_fp, jroot_hash, sha512_64};
use crate::tree::{
    c_path_slots, c_paths_and_root, dest_path_slots, dest_paths_and_root, note_u,
    path_selected_leaf, rerand_c, ristretto_h_note, ARITY,
};
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::{Identity, IsIdentity};

pub const MAX_PROOF: usize = 16384;
pub const VERSION: u8 = 2;

pub struct Proof {
    pub bytes: Vec<u8>,
}

fn chal(parts: &[&[u8]]) -> Scalar {
    Scalar::from_bytes_mod_order_wide(&sha512_64(parts))
}

fn hp(p: &RistrettoPoint) -> RistrettoPoint {
    let pb = p.compress().to_bytes();
    let w = sha512_64(&[b"shear-admit-Hp", &pb]);
    RistrettoPoint::from_uniform_bytes(&w)
}

fn decompress(b: &[u8; 32]) -> Option<RistrettoPoint> {
    CompressedRistretto(*b).decompress()
}

fn enc_path(path: &[[[u8; 32]; ARITY]]) -> Vec<u8> {
    let mut o = Vec::with_capacity(path.len() * ARITY * 32);
    for lvl in path {
        for x in lvl {
            o.extend_from_slice(x);
        }
    }
    o
}

/// Blind a path so wire bytes do not match public tree nodes (index hide vs casual match).
fn blind_path(path: &[[[u8; 32]; ARITY]], nonce: &[u8; 32]) -> Vec<u8> {
    let raw = enc_path(path);
    let mut out = raw.clone();
    for (i, b) in out.iter_mut().enumerate() {
        let w = sha512_64(&[b"shear-path-blind", nonce, &(i as u64).to_le_bytes()]);
        *b ^= w[i % 32];
    }
    out
}

pub(crate) fn unblind_path(blinded: &[u8], nonce: &[u8; 32]) -> Vec<u8> {
    let mut out = blinded.to_vec();
    for (i, b) in out.iter_mut().enumerate() {
        let w = sha512_64(&[b"shear-path-blind", nonce, &(i as u64).to_le_bytes()]);
        *b ^= w[i % 32];
    }
    out
}

const ZERO_BIND: [u8; 32] = [0u8; 32];

pub fn admit_prove(
    x: &[u8; 32],
    p: &[u8; 32],
    c: &[u8; 32],
    t: &[u8; 32],
    index: usize,
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
) -> Option<([u8; 32], Vec<u8>)> {
    admit_prove_in(x, p, c, t, index, dest_leaves, c_leaves, n, &ZERO_BIND)
}

pub fn admit_prove_in(
    x: &[u8; 32],
    p: &[u8; 32],
    c: &[u8; 32],
    t: &[u8; 32],
    index: usize,
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
    forest_bind: &[u8; 32],
) -> Option<([u8; 32], Vec<u8>)> {
    if n == 0 || index >= n {
        return None;
    }
    let ts = Scalar::from_bytes_mod_order(*t);
    if ts == Scalar::ZERO {
        return None;
    }
    let c_tilde = rerand_c(c, t)?;
    let xs = Scalar::from_bytes_mod_order(*x);
    if xs == Scalar::ZERO {
        return None;
    }
    let p_pt = decompress(p)?;
    let c_pt = decompress(c)?;
    let i_pt = hp(&p_pt) * xs;
    if i_pt.is_identity() {
        return None;
    }
    let tag = i_pt.compress().to_bytes();
    let (dpath, dest_r) = dest_paths_and_root(dest_leaves, n, index)?;
    let (cpath, c_r) = c_paths_and_root(c_leaves, n, index)?;
    let jr = jroot_hash(&dest_r, &c_r);
    let d0 = (index % ARITY) as u8;
    let dest_l = dest_leaf_fp(p);
    let c_l = c_leaf_scalar(c);
    if dpath.first()?.get(d0 as usize) != Some(&dest_l) {
        return None;
    }
    if cpath.first()?.get(d0 as usize) != Some(&c_l) {
        return None;
    }

    // Com_C = C + s U, U independent of H
    let s = chal(&[b"s", x, t, c]);
    let u = note_u();
    let h = ristretto_h_note();
    let com_c = c_pt + u * s;
    let com_b = com_c.compress().to_bytes();

    // Representation: C̃ - Com_C = t H - s U. Also C̃ = C + t H (select-and-rerandomize).
    let a_t = chal(&[b"at", t, x]);
    let a_s = chal(&[b"as", t, x, c]);
    let r_rep = h * a_t - u * a_s;
    let e = chal(&[
        b"rep",
        &r_rep.compress().to_bytes(),
        &c_tilde,
        &com_b,
        &jr,
        &tag,
        &[d0],
        &dest_l,
        &c_l,
        forest_bind,
    ]);
    let z_t = a_t + e * ts;
    let z_s = a_s + e * s;

    let w = chal(&[b"w", x, p]);
    let p_com = p_pt + u * w;
    let k = chal(&[b"k", x, t]);
    let a_w = chal(&[b"aw", x, t]);
    let r_x = G * k + u * a_w;
    let e2 = chal(&[
        b"dleq",
        &r_x.compress().to_bytes(),
        &p_com.compress().to_bytes(),
        &tag,
        &c_tilde,
        &jr,
        &[d0],
        &dest_l,
        &c_l,
        forest_bind,
    ]);
    let z_x = k + e2 * xs;
    let z_w = a_w + e2 * w;

    let nonce = chal(&[b"nonce", x, t, &jr]).to_bytes();
    let bdest = blind_path(&dpath, &nonce);
    let bc = blind_path(&cpath, &nonce);

    // Wire blob names neither P nor original C. Index bit d0 is committed in
    // FS with the selected dest_leaf and c_leaf taken from the paths.
    let mut proof = Vec::new();
    proof.push(VERSION);
    proof.extend_from_slice(&tag);
    proof.extend_from_slice(&c_tilde);
    proof.extend_from_slice(&com_b);
    proof.extend_from_slice(&p_com.compress().to_bytes());
    proof.extend_from_slice(&r_rep.compress().to_bytes());
    proof.extend_from_slice(&r_x.compress().to_bytes());
    proof.extend_from_slice(&z_t.to_bytes());
    proof.extend_from_slice(&z_s.to_bytes());
    proof.extend_from_slice(&z_x.to_bytes());
    proof.extend_from_slice(&z_w.to_bytes());
    proof.extend_from_slice(&nonce);
    proof.push(d0);
    proof.extend_from_slice(&(bdest.len() as u32).to_le_bytes());
    proof.extend_from_slice(&(bc.len() as u32).to_le_bytes());
    proof.extend_from_slice(&bdest);
    proof.extend_from_slice(&bc);
    if proof.len() > MAX_PROOF {
        return None;
    }
    Some((c_tilde, proof))
}

pub fn spend_tag_of(proof: &[u8]) -> Option<[u8; 32]> {
    if proof.len() < 33 || proof[0] != VERSION {
        return None;
    }
    let mut t = [0u8; 32];
    t.copy_from_slice(&proof[1..33]);
    Some(t)
}

fn read32(p: &[u8], off: usize) -> Option<[u8; 32]> {
    p.get(off..off + 32)?.try_into().ok()
}

pub fn admit_verify(
    proof: &[u8],
    jr: &[u8; 32],
    c_tilde: &[u8; 32],
    spend_tag: &[u8; 32],
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
) -> bool {
    admit_verify_in(proof, jr, c_tilde, spend_tag, dest_leaves, c_leaves, n, &ZERO_BIND)
}

pub fn admit_verify_in(
    proof: &[u8],
    jr: &[u8; 32],
    c_tilde: &[u8; 32],
    spend_tag: &[u8; 32],
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
    forest_bind: &[u8; 32],
) -> bool {
    let _ = (dest_leaves, c_leaves);
    if proof.is_empty() || proof[0] != VERSION {
        return false;
    }
    // ADMITv1 linear blob: often has r.length === |J| as a long vector and no version 2
    if n > 0 && proof.len() == 4 + 64 + n * 32 {
        return false;
    }
    // version + 11×32 + d0 + ld + lc
    if proof.len() < 1 + 32 * 11 + 1 + 8 {
        return false;
    }
    let tag = match read32(proof, 1) {
        Some(x) => x,
        None => return false,
    };
    if tag != *spend_tag {
        return false;
    }
    let ct_p = match read32(proof, 33) {
        Some(x) => x,
        None => return false,
    };
    if ct_p != *c_tilde {
        return false;
    }
    if decompress(c_tilde).is_none() || decompress(&tag).map(|p| p.is_identity()).unwrap_or(true) {
        return false;
    }
    let com_b = match read32(proof, 65) {
        Some(x) => x,
        None => return false,
    };
    let p_com_b = match read32(proof, 97) {
        Some(x) => x,
        None => return false,
    };
    let r_rep_b = match read32(proof, 129) {
        Some(x) => x,
        None => return false,
    };
    let r_x_b = match read32(proof, 161) {
        Some(x) => x,
        None => return false,
    };
    let z_t = Scalar::from_bytes_mod_order(read32(proof, 193).unwrap_or([0u8; 32]));
    let z_s = Scalar::from_bytes_mod_order(read32(proof, 225).unwrap_or([0u8; 32]));
    let z_x = Scalar::from_bytes_mod_order(read32(proof, 257).unwrap_or([0u8; 32]));
    let z_w = Scalar::from_bytes_mod_order(read32(proof, 289).unwrap_or([0u8; 32]));
    let nonce = match read32(proof, 321) {
        Some(x) => x,
        None => return false,
    };
    let d0 = *proof.get(353).unwrap_or(&255u8);
    if (d0 as usize) >= ARITY {
        return false;
    }
    let ld = u32::from_le_bytes(proof.get(354..358).and_then(|s| s.try_into().ok()).unwrap_or([0; 4]))
        as usize;
    let lc = u32::from_le_bytes(proof.get(358..362).and_then(|s| s.try_into().ok()).unwrap_or([0; 4]))
        as usize;
    if proof.len() < 362 + ld + lc {
        return false;
    }
    let bdest = &proof[362..362 + ld];
    let bc = &proof[362 + ld..362 + ld + lc];

    // Membership first: unblind D-ary paths, same index digits, selected
    // dest_leaf / c_leaf at d0. P and original C are not on the wire.
    let raw_d = unblind_path(bdest, &nonce);
    let raw_c = unblind_path(bc, &nonce);
    let (dest_r, dest_digits) = match dest_path_slots(&raw_d) {
        Some(v) => v,
        None => return false,
    };
    let (c_r, c_digits) = match c_path_slots(&raw_c) {
        Some(v) => v,
        None => return false,
    };
    if dest_digits != c_digits {
        return false;
    }
    if jroot_hash(&dest_r, &c_r) != *jr {
        return false;
    }
    let dest_l = match path_selected_leaf(&raw_d, d0) {
        Some(v) => v,
        None => return false,
    };
    let c_l = match path_selected_leaf(&raw_c, d0) {
        Some(v) => v,
        None => return false,
    };

    let h = ristretto_h_note();
    let u = note_u();
    let r_rep = match decompress(&r_rep_b) {
        Some(p) => p,
        None => return false,
    };
    let com_c = match decompress(&com_b) {
        Some(p) => p,
        None => return false,
    };
    let ct = match decompress(c_tilde) {
        Some(p) => p,
        None => return false,
    };
    let e = chal(&[
        b"rep",
        &r_rep_b,
        c_tilde,
        &com_b,
        jr,
        &tag,
        &[d0],
        &dest_l,
        &c_l,
        forest_bind,
    ]);
    // z_t H - z_s U  ?==  R + e (C̃ - Com_C). C̃ is in e with the selected
    // c_leaf so a self-minted C̃ cannot keep the honest path's z values.
    let left = h * z_t - u * z_s;
    let right = r_rep + (ct - com_c) * e;
    if left != right {
        return false;
    }

    let p_com = match decompress(&p_com_b) {
        Some(p) => p,
        None => return false,
    };
    let r_x = match decompress(&r_x_b) {
        Some(p) => p,
        None => return false,
    };
    let e2 = chal(&[
        b"dleq",
        &r_x_b,
        &p_com_b,
        &tag,
        c_tilde,
        jr,
        &[d0],
        &dest_l,
        &c_l,
        forest_bind,
    ]);
    // z_x G + z_w U  ?== R + e2 P_com. e2 binds spendTag and P_com to the
    // selected dest_leaf — attacker x on a victim path gets the wrong e2.
    if G * z_x + u * z_w != r_x + p_com * e2 {
        return false;
    }
    true
}

pub fn admit_verify_batch(
    items: &[(&[u8], [u8; 32], [u8; 32])],
    jr: &[u8; 32],
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
) -> bool {
    if items.is_empty() {
        return false;
    }
    for (pr, ct, tag) in items {
        if !admit_verify(pr, jr, ct, tag, dest_leaves, c_leaves, n) {
            return false;
        }
    }
    true
}

fn forest_bind_of(pre: &[([u8; 32], [u8; 32], u8)]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(16 + pre.len() * 65);
    buf.extend_from_slice(b"forest-idx");
    for (tag, ct, d0) in pre {
        buf.extend_from_slice(tag);
        buf.extend_from_slice(ct);
        buf.push(*d0);
    }
    chal(&[&buf]).to_bytes()
}

pub fn forest_prove(
    spends: &[(
        [u8; 32],
        [u8; 32],
        [u8; 32],
        [u8; 32],
        usize,
    )],
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
) -> Option<Vec<( [u8; 32], Vec<u8>)>> {
    if spends.len() < 2 {
        return None;
    }
    let mut pre = Vec::with_capacity(spends.len());
    for (x, p, c, t, idx) in spends {
        if *idx >= n {
            return None;
        }
        let xs = Scalar::from_bytes_mod_order(*x);
        let p_pt = decompress(p)?;
        let i_pt = hp(&p_pt) * xs;
        if i_pt.is_identity() {
            return None;
        }
        let tag = i_pt.compress().to_bytes();
        let ct = rerand_c(c, t)?;
        pre.push((tag, ct, (*idx % ARITY) as u8));
    }
    let bind = forest_bind_of(&pre);
    let mut out = Vec::new();
    for (x, p, c, t, idx) in spends {
        out.push(admit_prove_in(
            x,
            p,
            c,
            t,
            *idx,
            dest_leaves,
            c_leaves,
            n,
            &bind,
        )?);
    }
    Some(out)
}

fn proof_d0(proof: &[u8]) -> Option<u8> {
    let d0 = *proof.get(353)?;
    if (d0 as usize) >= ARITY {
        return None;
    }
    Some(d0)
}

pub fn forest_verify(
    proofs: &[(&[u8], [u8; 32], [u8; 32])],
    jr: &[u8; 32],
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
) -> bool {
    if proofs.len() < 2 {
        return false;
    }
    let mut pre = Vec::with_capacity(proofs.len());
    for (pr, ct, tag) in proofs {
        let d0 = match proof_d0(pr) {
            Some(d) => d,
            None => return false,
        };
        pre.push((*tag, *ct, d0));
    }
    let bind = forest_bind_of(&pre);
    for (pr, ct, tag) in proofs {
        if !admit_verify_in(pr, jr, ct, tag, dest_leaves, c_leaves, n, &bind) {
            return false;
        }
    }
    true
}
