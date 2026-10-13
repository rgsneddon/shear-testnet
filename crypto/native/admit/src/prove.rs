//! ADMITv2 prove / verify. Version byte 2. ADMITv1 (linear r) fails.
//! Membership is D-ary CDS select-and-rerandomize. No d0 / nonce / XOR path
//! / dest_leaf of the spent note on the wire. C-tree leaves are ristretto C;
//! C̃ is a 1-of-D rerandomization of a tree C. Dest admitPub P is 1-of-D as
//! p_com = P_j + w U at the same hidden slot. Version 3 blinds every published
//! remainder so that slot is not a function of W. The arity-32 point bucket
//! stays on the wire. Version 3's first C fold commits those ristretto points
//! (r·U + Σ C_i). The dest-bind leaf opens the encoding commitment of that
//! same published bucket, and the trailer opens Q = C_i + ρ·U. The glue in
//! front of the buckets opens that point-commitment child. Internal paired
//! layers stay scalar openings. The domains are shear-admit-c-point-v3 and
//! shear-jroot-point-v3, not a patch on the v2 leaf domains.

use crate::leaf::{jroot_point_hash, sha512_64};
use crate::select::{
    leaf_prove_v3, leaf_qd, leaf_verify_v3, paired_prove, paired_qc_opens, paired_qd_opens,
    paired_verify, point_open_prove, point_open_verify, rs_rand, vs_rand, LEAF_V3_LEN, PAIRED_LEN,
    POINT_OPEN_LEN, V3_Y, V3_YX,
};
use crate::leaf::dest_leaf_fp;
use crate::tree::{
    commit_ristretto_encodings, commit_ristretto_points, commit_vesta, leaf_p_siblings, note_u,
    path_from_levels, rerand_c, root_of_levels, trees_point, ARITY,
};
use ff::PrimeField;
use pasta_curves::vesta;
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::IsIdentity;
use rand_core::{OsRng, RngCore};

pub const MAX_PROOF: usize = 32768;
/// Height-4 v3 proof: header + 3 paired layers + both published buckets
/// + the dest-bind leaf + the point-open trailer = 43490.
/// Height 5 does not fit. The v2 cap stays 32768.
pub const MAX_PROOF_V3: usize = 43490;
pub const VERSION: u8 = 2;
pub const VERSION_V3: u8 = 3;
const HDR: usize = 1 + 32 * 8 + 1; // version, tag, ct, dest_root, c_root, p_com, r_x, z_x, z_w, n_layers

pub struct Proof {
    pub bytes: Vec<u8>,
}

fn chal(parts: &[&[u8]]) -> Scalar {
    Scalar::from_bytes_mod_order_wide(&sha512_64(parts))
}

fn scalar_in(bytes: [u8; 32], v3: bool) -> Option<Scalar> {
    if !v3 {
        return Some(Scalar::from_bytes_mod_order(bytes));
    }
    Scalar::from_canonical_bytes(bytes).into()
}

fn os_rand32() -> Option<[u8; 32]> {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    if b == [0u8; 32] {
        return None;
    }
    Some(b)
}

fn hp(p: &RistrettoPoint) -> RistrettoPoint {
    let pb = p.compress().to_bytes();
    let w = sha512_64(&[b"shear-admit-Hp", &pb]);
    RistrettoPoint::from_uniform_bytes(&w)
}

fn decompress(b: &[u8; 32]) -> Option<RistrettoPoint> {
    CompressedRistretto(*b).decompress()
}

fn read32(p: &[u8], off: usize) -> Option<[u8; 32]> {
    p.get(off..off + 32)?.try_into().ok()
}

fn slots_of(index: usize, n_layers: usize) -> Vec<usize> {
    let mut idx = index;
    let mut s = Vec::with_capacity(n_layers);
    for _ in 0..n_layers {
        s.push(idx % ARITY);
        idx /= ARITY;
    }
    s
}

const ZERO_BIND: [u8; 32] = [0u8; 32];

pub fn admit_prove_v3(
    x: &[u8; 32],
    p: &[u8; 32],
    c: &[u8; 32],
    t: &[u8; 32],
    index: usize,
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
    ctx: &[u8],
) -> Option<([u8; 32], Vec<u8>)> {
    if ctx.len() != 64 {
        return None;
    }
    admit_prove_in(x, p, c, t, index, dest_leaves, c_leaves, n, &ZERO_BIND, ctx)
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
    ctx: &[u8],
) -> Option<([u8; 32], Vec<u8>)> {
    if n == 0 || index >= n {
        return None;
    }
    if ctx.len() != 64 {
        return None;
    }
    let v3 = true;
    let ts = scalar_in(*t, v3)?;
    if ts == Scalar::ZERO {
        return None;
    }
    let c_tilde = rerand_c(c, t)?;
    let xs = scalar_in(*x, v3)?;
    if xs == Scalar::ZERO {
        return None;
    }
    let p_pt = decompress(p)?;
    let i_pt = hp(&p_pt) * xs;
    if i_pt.is_identity() {
        return None;
    }
    let tag = i_pt.compress().to_bytes();
    let (dlevels, clev) = trees_point(dest_leaves, c_leaves, n)?;
    let dpath = path_from_levels(&dlevels, index)?;
    let cpath = path_from_levels(&clev, index)?;
    if dpath.len() != cpath.len() || dpath.is_empty() {
        return None;
    }
    let n_layers = dpath.len();
    if n_layers > 255 {
        return None;
    }
    let dest_root = root_of_levels(&dlevels);
    let c_root_b = root_of_levels(&clev);
    let jr = jroot_point_hash(&dest_root, &c_root_b);
    let slots = slots_of(index, n_layers);
    let ct_pt = decompress(&c_tilde)?;

    // Membership: paired CDS root→leaf-1, leaf dest CDS + C̃ 1-of-D.
    let mut mem = Vec::new();
    let mut t_d_prev: Option<vesta::Scalar> = None;
    let mut t_c_prev: Option<Scalar> = None;
    if n_layers > 1 {
        for layer in (1..n_layers).rev() {
            let td = vs_rand();
            let tc = rs_rand();
            let pr = paired_prove(&dpath[layer], &cpath[layer], slots[layer], &td, &tc, ctx)?;
            if layer + 1 < n_layers {
                let parent_d = commit_vesta(&dpath[layer]);
                let parent_c = commit_ristretto_encodings(&cpath[layer]);
                let td_b: [u8; 32] = t_d_prev?.to_repr().into();
                mem.extend_from_slice(&parent_d);
                mem.extend_from_slice(&td_b);
                mem.extend_from_slice(&parent_c);
                mem.extend_from_slice(&t_c_prev?.to_bytes());
            }
            mem.extend_from_slice(&pr);
            t_d_prev = Some(td);
            t_c_prev = Some(tc);
        }
        let parent_d = commit_vesta(&dpath[0]);
        // The glue child is the point commitment of the published bucket.
        // Internal parents above stay scalar encodings.
        let parent_c = commit_ristretto_points(&cpath[0])?;
        let td_b: [u8; 32] = t_d_prev?.to_repr().into();
        mem.extend_from_slice(&parent_d);
        mem.extend_from_slice(&td_b);
        mem.extend_from_slice(&parent_c);
        mem.extend_from_slice(&t_c_prev?.to_bytes());
    }
    // Point bucket for C̃ = C_i + t·H and p_com = P_i + w·U. The bytes stay.
    // Version 3 binds them by the point commitment, not by deleting them.
    let p_sib = leaf_p_siblings(dest_leaves, n, index)?;
    if p_sib[slots[0]] != *p {
        return None;
    }
    let u = note_u();
    let w = chal(&[b"w", x, p]);
    let p_com = p_pt + u * w;
    let td_leaf = vs_rand();
    for x in &p_sib {
        mem.extend_from_slice(x);
    }
    for x in &cpath[0] {
        mem.extend_from_slice(x);
    }
    if dpath[0][slots[0]] != dest_leaf_fp(p) {
        return None;
    }
    let leaf = leaf_prove_v3(
        &dpath[0],
        &cpath[0],
        &p_sib,
        slots[0],
        &td_leaf,
        &ts,
        &w,
        &ct_pt,
        &p_com,
        ctx,
    )?;
    mem.extend_from_slice(&leaf);
    let open = point_open_prove(&cpath[0], slots[0], ctx)?;
    mem.extend_from_slice(&open);
    let nonce_rand = os_rand32()?;
    let k = chal(&[b"k", ctx, x, t, &nonce_rand]);
    let a_w = chal(&[b"aw", ctx, x, t, &nonce_rand]);
    let r_x = G * k + u * a_w;
    let dest_q = leaf_qd(&leaf)?;
    let bind = forest_bind_v3(ctx, &[(tag, c_tilde)]);
    let _ = forest_bind;
    let rx_b = r_x.compress().to_bytes();
    let pc_b = p_com.compress().to_bytes();
    let e2 = chal(&[
        ctx,
        b"dleq",
        &rx_b,
        &pc_b,
        &tag,
        &c_tilde,
        &jr,
        &dest_q,
        &bind,
    ]);
    let z_x = k + e2 * xs;
    let z_w = a_w + e2 * w;

    let mut proof = Vec::new();
    proof.push(VERSION_V3);
    proof.extend_from_slice(&tag);
    proof.extend_from_slice(&c_tilde);
    proof.extend_from_slice(&dest_root);
    proof.extend_from_slice(&c_root_b);
    proof.extend_from_slice(&p_com.compress().to_bytes());
    proof.extend_from_slice(&r_x.compress().to_bytes());
    proof.extend_from_slice(&z_x.to_bytes());
    proof.extend_from_slice(&z_w.to_bytes());
    proof.push(n_layers as u8);
    proof.extend_from_slice(&mem);
    if proof.len() > MAX_PROOF_V3 {
        return None;
    }
    Some((c_tilde, proof))
}

/// One-bucket attack transcript. Opens the honest parents, then sets C̃ to a
/// fresh point and p_com to an attacker key. The slot proof opens the tree
/// scalar. The encode proof opens the fresh point. Consensus must reject it
/// because those openings are not the same published Y.
#[cfg(test)]
pub struct ForgedSpend {
    pub ct: [u8; 32],
    pub tag: [u8; 32],
    pub proof: Vec<u8>,
    pub e_bytes: [[u8; 32]; ARITY],
    pub s_bytes: [[u8; 64]; ARITY],
    pub kc_b: [u8; 32],
    pub kp_b: [u8; 32],
}

#[cfg(test)]
pub fn forge_fresh_spend_v3(
    index: usize,
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
    ctx: &[u8],
) -> Option<ForgedSpend> {
    if ctx.len() != 64 || n == 0 || index >= n {
        return None;
    }
    let (dlevels, clev) = trees_point(dest_leaves, c_leaves, n)?;
    let dpath = path_from_levels(&dlevels, index)?;
    let cpath = path_from_levels(&clev, index)?;
    if dpath.len() != 1 || cpath.len() != 1 {
        return None;
    }
    let slots = slots_of(index, 1);
    let p_sib = leaf_p_siblings(dest_leaves, n, index)?;
    let dest_root = root_of_levels(&dlevels);
    let c_root_b = root_of_levels(&clev);
    let jr = jroot_point_hash(&dest_root, &c_root_b);
    let t_fresh = rs_rand();
    let fresh = G * rs_rand();
    let ct_pt = fresh + crate::tree::ristretto_h_note() * t_fresh;
    let ax = rs_rand();
    let attacker_p = G * ax;
    let x_bytes = ax.to_bytes();
    let p_bytes = attacker_p.compress().to_bytes();
    let w = chal(&[b"w", &x_bytes, &p_bytes]);
    let u = note_u();
    let p_com = attacker_p + u * w;
    let delta_c = rs_rand();
    let delta_p = rs_rand();
    let h = crate::tree::ristretto_h_note();
    let kc = ct_pt - h * delta_c;
    let kp = p_com - u * delta_p;
    let td = vs_rand();
    let made = crate::select::leaf_prove_v3_unbound(
        &dpath[0],
        &cpath[0],
        &p_sib,
        slots[0],
        &td,
        &ct_pt,
        &p_com,
        ctx,
        kc,
        kp,
        delta_c,
        delta_p,
    )?;
    let y_b = take_at(&made.body, V3_Y)?;
    let yx_b = take_at(&made.body, V3_YX)?;
    let rho = t_fresh - delta_c;
    let kc_b = kc.compress().to_bytes();
    if kc_b != made.kc_b {
        return None;
    }
    let kp_b = kp.compress().to_bytes();
    if kp_b != made.kp_b {
        return None;
    }
    let y_fresh = Scalar::from_bytes_mod_order(fresh.compress().to_bytes());
    if y_fresh == made.y {
        return None;
    }
    let r_fresh = crate::select::vs_rand();
    eprintln!("PHASE forge-slot-prove");
    let slot = crate::gadget::prove_slot_opening(
        &made.y,
        &made.r_y,
        &y_b,
        &made.ky,
        &made.e_bytes,
        &made.s_bytes,
        made.index,
    )?;
    eprintln!("PHASE forge-encode-prove");
    let enc = crate::gadget::prove_encode_opening(&fresh, &rho, &kc_b, &y_fresh, &r_fresh)?;
    let rho_p = w - delta_p;
    let x_atk = crate::tree::vesta_x(&dest_leaf_fp(&p_bytes));
    let r_atk = vs_rand();
    eprintln!("PHASE forge-kp-prove");
    let kp_blob = crate::gadget::prove_kp_opening(&attacker_p, &rho_p, &kp_b, &x_atk, &r_atk)?;
    if slot.len() != crate::r1cs::SLOT_LINK_BLOB
        || enc.len() != crate::r1cs::ENCODE_LINK_BLOB
        || kp_blob.len() != crate::r1cs::ENCODE_LINK_BLOB
    {
        return None;
    }
    let slot_v = &slot[11 * 32..11 * 32 + 32];
    let enc_v = &enc[11 * 32..11 * 32 + 32];
    let kp_v = &kp_blob[11 * 32..11 * 32 + 32];
    if slot_v != y_b.as_slice() || enc_v == y_b.as_slice() || kp_v == yx_b.as_slice() {
        return None;
    }
    let mut leaf = made.body;
    leaf.extend_from_slice(&slot);
    leaf.extend_from_slice(&enc);
    leaf.extend_from_slice(&kp_blob);
    if leaf.len() != LEAF_V3_LEN {
        return None;
    }
    let e_bytes = made.e_bytes;
    let s_bytes = made.s_bytes;
    let ct = ct_pt.compress().to_bytes();
    let tag = (hp(&attacker_p) * ax).compress().to_bytes();
    let nonce = os_rand32()?;
    let t_bytes = t_fresh.to_bytes();
    let k = chal(&[b"k", ctx, &x_bytes, &t_bytes, &nonce]);
    let a_w = chal(&[b"aw", ctx, &x_bytes, &t_bytes, &nonce]);
    let r_x = G * k + u * a_w;
    let dest_q = leaf_qd(&leaf)?;
    let bind = forest_bind_v3(ctx, &[(tag, ct)]);
    let rx_b = r_x.compress().to_bytes();
    let pc_b = p_com.compress().to_bytes();
    let e2 = chal(&[
        ctx, b"dleq", &rx_b, &pc_b, &tag, &ct, &jr, &dest_q, &bind,
    ]);
    let z_x = k + e2 * ax;
    let z_w = a_w + e2 * w;
    let mut proof = Vec::new();
    proof.push(VERSION_V3);
    proof.extend_from_slice(&tag);
    proof.extend_from_slice(&ct);
    proof.extend_from_slice(&dest_root);
    proof.extend_from_slice(&c_root_b);
    proof.extend_from_slice(&pc_b);
    proof.extend_from_slice(&rx_b);
    proof.extend_from_slice(&z_x.to_bytes());
    proof.extend_from_slice(&z_w.to_bytes());
    proof.push(1u8);
    for x in &p_sib {
        proof.extend_from_slice(x);
    }
    for x in &cpath[0] {
        proof.extend_from_slice(x);
    }
    proof.extend_from_slice(&leaf);
    let open = point_open_prove(&cpath[0], slots[0], ctx)?;
    proof.extend_from_slice(&open);
    Some(ForgedSpend { ct, tag, proof, e_bytes, s_bytes, kc_b, kp_b })
}

#[cfg(test)]
fn take_at(buf: &[u8], off: usize) -> Option<[u8; 32]> {
    let end = off.checked_add(32)?;
    let s = buf.get(off..end)?;
    let mut o = [0u8; 32];
    o.copy_from_slice(s);
    Some(o)
}

/// Honest note, attacker dest. The slot and encode proofs open the published Y.
/// The dest-bind proof is valid for the attacker point and opens a different Yx.
#[cfg(test)]
pub fn forge_attacker_dest_v3(
    index: usize,
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
    ctx: &[u8],
) -> Option<ForgedSpend> {
    if ctx.len() != 64 || n == 0 || index >= n {
        return None;
    }
    let (dlevels, clev) = trees_point(dest_leaves, c_leaves, n)?;
    let dpath = path_from_levels(&dlevels, index)?;
    let cpath = path_from_levels(&clev, index)?;
    if dpath.len() != 1 || cpath.len() != 1 {
        return None;
    }
    let slots = slots_of(index, 1);
    let p_sib = leaf_p_siblings(dest_leaves, n, index)?;
    let dest_root = root_of_levels(&dlevels);
    let c_root_b = root_of_levels(&clev);
    let jr = jroot_point_hash(&dest_root, &c_root_b);
    let c_leaf = cpath[0][slots[0]];
    let ci = CompressedRistretto(c_leaf).decompress()?;
    let t_note = rs_rand();
    let rho_c = rs_rand();
    let h = crate::tree::ristretto_h_note();
    let ct_pt = ci + h * t_note;
    let kc = ci + h * rho_c;
    let delta_c = t_note - rho_c;
    let ax = rs_rand();
    let attacker_p = G * ax;
    let x_bytes = ax.to_bytes();
    let p_bytes = attacker_p.compress().to_bytes();
    let w = chal(&[b"w", &x_bytes, &p_bytes]);
    let u = note_u();
    let p_com = attacker_p + u * w;
    let delta_p = rs_rand();
    let rho_p = w - delta_p;
    let kp = attacker_p + u * rho_p;
    let td = vs_rand();
    let made = crate::select::leaf_prove_v3_unbound(
        &dpath[0],
        &cpath[0],
        &p_sib,
        slots[0],
        &td,
        &ct_pt,
        &p_com,
        ctx,
        kc,
        kp,
        delta_c,
        delta_p,
    )?;
    let y_b = take_at(&made.body, V3_Y)?;
    let yx_b = take_at(&made.body, V3_YX)?;
    let kc_b = kc.compress().to_bytes();
    let kp_b = kp.compress().to_bytes();
    if kc_b != made.kc_b || kp_b != made.kp_b {
        return None;
    }
    let x_atk = crate::tree::vesta_x(&dest_leaf_fp(&p_bytes));
    if x_atk == made.x {
        return None;
    }
    eprintln!("PHASE attacker-slot-prove");
    let slot = crate::gadget::prove_slot_opening(
        &made.y,
        &made.r_y,
        &y_b,
        &made.ky,
        &made.e_bytes,
        &made.s_bytes,
        made.index,
    )?;
    eprintln!("PHASE attacker-encode-prove");
    let enc = crate::gadget::prove_encode_opening(&ci, &rho_c, &kc_b, &made.y, &made.r_y)?;
    let r_atk = vs_rand();
    eprintln!("PHASE attacker-kp-prove");
    let kp_blob = crate::gadget::prove_kp_opening(&attacker_p, &rho_p, &kp_b, &x_atk, &r_atk)?;
    if slot.len() != crate::r1cs::SLOT_LINK_BLOB
        || enc.len() != crate::r1cs::ENCODE_LINK_BLOB
        || kp_blob.len() != crate::r1cs::ENCODE_LINK_BLOB
    {
        return None;
    }
    let slot_v = &slot[11 * 32..11 * 32 + 32];
    let enc_v = &enc[11 * 32..11 * 32 + 32];
    let kp_v = &kp_blob[11 * 32..11 * 32 + 32];
    if slot_v != y_b.as_slice() || enc_v != y_b.as_slice() || kp_v == yx_b.as_slice() {
        return None;
    }
    let mut leaf = made.body;
    leaf.extend_from_slice(&slot);
    leaf.extend_from_slice(&enc);
    leaf.extend_from_slice(&kp_blob);
    if leaf.len() != LEAF_V3_LEN {
        return None;
    }
    let e_bytes = made.e_bytes;
    let s_bytes = made.s_bytes;
    let ct = ct_pt.compress().to_bytes();
    let tag = (hp(&attacker_p) * ax).compress().to_bytes();
    let nonce = os_rand32()?;
    let t_bytes = t_note.to_bytes();
    let k = chal(&[b"k", ctx, &x_bytes, &t_bytes, &nonce]);
    let a_w = chal(&[b"aw", ctx, &x_bytes, &t_bytes, &nonce]);
    let r_x = G * k + u * a_w;
    let dest_q = leaf_qd(&leaf)?;
    let bind = forest_bind_v3(ctx, &[(tag, ct)]);
    let rx_b = r_x.compress().to_bytes();
    let pc_b = p_com.compress().to_bytes();
    let e2 = chal(&[
        ctx, b"dleq", &rx_b, &pc_b, &tag, &ct, &jr, &dest_q, &bind,
    ]);
    let z_x = k + e2 * ax;
    let z_w = a_w + e2 * w;
    let mut proof = Vec::new();
    proof.push(VERSION_V3);
    proof.extend_from_slice(&tag);
    proof.extend_from_slice(&ct);
    proof.extend_from_slice(&dest_root);
    proof.extend_from_slice(&c_root_b);
    proof.extend_from_slice(&pc_b);
    proof.extend_from_slice(&rx_b);
    proof.extend_from_slice(&z_x.to_bytes());
    proof.extend_from_slice(&z_w.to_bytes());
    proof.push(1u8);
    for x in &p_sib {
        proof.extend_from_slice(x);
    }
    for x in &cpath[0] {
        proof.extend_from_slice(x);
    }
    proof.extend_from_slice(&leaf);
    let open = point_open_prove(&cpath[0], slots[0], ctx)?;
    proof.extend_from_slice(&open);
    Some(ForgedSpend { ct, tag, proof, e_bytes, s_bytes, kc_b, kp_b })
}

pub fn spend_tag_of(proof: &[u8]) -> Option<[u8; 32]> {
    if proof.len() < 33 || (proof[0] != VERSION && proof[0] != VERSION_V3) {
        return None;
    }
    let mut t = [0u8; 32];
    t.copy_from_slice(&proof[1..33]);
    Some(t)
}

fn parse_c_siblings(p: &[u8], off: usize) -> Option<([[u8; 32]; ARITY], usize)> {
    if p.len() < off + ARITY * 32 {
        return None;
    }
    let mut xs = [[0u8; 32]; ARITY];
    for i in 0..ARITY {
        xs[i].copy_from_slice(&p[off + i * 32..off + i * 32 + 32]);
    }
    Some((xs, off + ARITY * 32))
}

pub fn admit_verify_v3(
    proof: &[u8],
    jr: &[u8; 32],
    c_tilde: &[u8; 32],
    spend_tag: &[u8; 32],
    ctx: &[u8],
) -> bool {
    if ctx.len() != 64 {
        return false;
    }
    admit_verify_in(proof, jr, c_tilde, spend_tag, &[], &[], 0, &ZERO_BIND, ctx)
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
    ctx: &[u8],
) -> bool {
    let _ = (dest_leaves, c_leaves, n, forest_bind);
    if ctx.len() != 64 {
        return false;
    }
    let v3 = true;
    if proof.is_empty() || proof[0] != VERSION_V3 {
        return false;
    }
    if proof.len() > MAX_PROOF_V3 {
        return false;
    }
    if n > 0 && proof.len() == 4 + 64 + n * 32 {
        return false;
    }
    if proof.len() < HDR {
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
    let dest_root = match read32(proof, 65) {
        Some(x) => x,
        None => return false,
    };
    let c_root_b = match read32(proof, 97) {
        Some(x) => x,
        None => return false,
    };
    let rooted = jroot_point_hash(&dest_root, &c_root_b) == *jr;
    if !rooted {
        return false;
    }
    let p_com_b = match read32(proof, 129) {
        Some(x) => x,
        None => return false,
    };
    let r_x_b = match read32(proof, 161) {
        Some(x) => x,
        None => return false,
    };
    let z_x = match scalar_in(match read32(proof, 193) {
        Some(b) => b,
        None => return false,
    }, v3) {
        Some(s) => s,
        None => return false,
    };
    let z_w = match scalar_in(match read32(proof, 225) {
        Some(b) => b,
        None => return false,
    }, v3) {
        Some(s) => s,
        None => return false,
    };
    let n_layers = *proof.get(257).unwrap_or(&0u8) as usize;
    if n_layers == 0 || n_layers > 8 {
        return false;
    }
    fn vesta_t(b: &[u8; 32]) -> Option<vesta::Scalar> {
        Option::<vesta::Scalar>::from(vesta::Scalar::from_repr((*b).into()))
    }
    let mut off = HDR;
    let mut dest_parent = dest_root;
    let mut c_parent = c_root_b;
    let mut prev_off: Option<usize> = None;
    if n_layers > 1 {
        for layer in 0..(n_layers - 1) {
            if layer > 0 {
                let pd = match read32(proof, off) {
                    Some(x) => x,
                    None => return false,
                };
                let td = match read32(proof, off + 32) {
                    Some(x) => x,
                    None => return false,
                };
                let pc = match read32(proof, off + 64) {
                    Some(x) => x,
                    None => return false,
                };
                let tc = match read32(proof, off + 96) {
                    Some(x) => x,
                    None => return false,
                };
                off += 128;
                let po = match prev_off {
                    Some(x) => x,
                    None => return false,
                };
                let prev = &proof[po..po + PAIRED_LEN];
                let tdv = match vesta_t(&td) {
                    Some(x) => x,
                    None => return false,
                };
                if !paired_qd_opens(prev, &pd, &tdv)
                    || !paired_qc_opens(prev, &pc, &Scalar::from_bytes_mod_order(tc))
                {
                    return false;
                }
                dest_parent = pd;
                c_parent = pc;
            }
            if proof.len() < off + PAIRED_LEN {
                return false;
            }
            let pr = &proof[off..off + PAIRED_LEN];
            if !paired_verify(&dest_parent, &c_parent, pr, ctx) {
                return false;
            }
            prev_off = Some(off);
            off += PAIRED_LEN;
        }
        let pd = match read32(proof, off) {
            Some(x) => x,
            None => return false,
        };
        let td = match read32(proof, off + 32) {
            Some(x) => x,
            None => return false,
        };
        let pc = match read32(proof, off + 64) {
            Some(x) => x,
            None => return false,
        };
        let tc = match read32(proof, off + 96) {
            Some(x) => x,
            None => return false,
        };
        off += 128;
        let po = match prev_off {
            Some(x) => x,
            None => return false,
        };
        let prev = &proof[po..po + PAIRED_LEN];
        let tdv = match vesta_t(&td) {
            Some(x) => x,
            None => return false,
        };
        if !paired_qd_opens(prev, &pd, &tdv)
            || !paired_qc_opens(prev, &pc, &Scalar::from_bytes_mod_order(tc))
        {
            return false;
        }
        dest_parent = pd;
        c_parent = pc;
    }
    let (p_sib, off_p) = match parse_c_siblings(proof, off) {
        Some(v) => v,
        None => return false,
    };
    off = off_p;
    let mut dest_from_p = [[0u8; 32]; ARITY];
    for j in 0..ARITY {
        dest_from_p[j] = if p_sib[j] == [0u8; 32] {
            [0u8; 32]
        } else {
            dest_leaf_fp(&p_sib[j])
        };
    }
    if commit_vesta(&dest_from_p) != dest_parent {
        return false;
    }
    let (siblings, off2) = match parse_c_siblings(proof, off) {
        Some(v) => v,
        None => return false,
    };
    off = off2;
    let ct = match decompress(c_tilde) {
        Some(p) => p,
        None => return false,
    };
    let p_com = match decompress(&p_com_b) {
        Some(p) => p,
        None => return false,
    };
    let point_parent = match commit_ristretto_points(&siblings) {
        Some(p) => p,
        None => return false,
    };
    if point_parent != c_parent {
        return false;
    }
    // The tree node is the point commitment. The dest-bind leaf opens the
    // encoding commitment of this same published bucket.
    let enc_parent = commit_ristretto_encodings(&siblings);
    let leaf_end = off + LEAF_V3_LEN;
    if proof.len() != leaf_end + POINT_OPEN_LEN {
        return false;
    }
    let leaf = &proof[off..leaf_end];
    if !leaf_verify_v3(&dest_parent, &enc_parent, &ct, &p_com, leaf, ctx) {
        return false;
    }
    if !point_open_verify(&siblings, &proof[leaf_end..leaf_end + POINT_OPEN_LEN], ctx) {
        return false;
    }
    let dest_q = match leaf_qd(leaf) {
        Some(x) => x,
        None => return false,
    };
    v3_dleq(
        &dest_q,
        &p_com,
        &p_com_b,
        &r_x_b,
        &tag,
        c_tilde,
        jr,
        ctx,
        z_x,
        z_w,
    )
}

fn v3_dleq(
    dest_q: &[u8; 32],
    p_com: &RistrettoPoint,
    p_com_b: &[u8; 32],
    r_x_b: &[u8; 32],
    tag: &[u8; 32],
    c_tilde: &[u8; 32],
    jr: &[u8; 32],
    ctx: &[u8],
    z_x: Scalar,
    z_w: Scalar,
) -> bool {
    let u = note_u();
    let r_x = match decompress(r_x_b) {
        Some(p) => p,
        None => return false,
    };
    let bind = forest_bind_v3(ctx, &[(*tag, *c_tilde)]);
    let e2 = chal(&[
        ctx,
        b"dleq",
        r_x_b,
        p_com_b,
        tag,
        c_tilde,
        jr,
        dest_q,
        &bind,
    ]);
    G * z_x + u * z_w == r_x + *p_com * e2
}

fn forest_bind_v3(ctx: &[u8], pairs: &[([u8; 32], [u8; 32])]) -> [u8; 32] {
    let mut parts: Vec<&[u8]> = Vec::with_capacity(2 + pairs.len() * 2);
    parts.push(ctx);
    parts.push(b"forest");
    for (tag, ct) in pairs {
        parts.push(tag);
        parts.push(ct);
    }
    chal(&parts).to_bytes()
}


#[cfg(test)]
mod cap_tests {
    use super::MAX_PROOF_V3;
    use crate::select::{LEAF_V3_LEN, PAIRED_LEN, POINT_OPEN_LEN};
    use crate::tree::ARITY;

    fn v3_proof_len(layers: usize) -> usize {
        let tail = 2 * ARITY * 32 + LEAF_V3_LEN + POINT_OPEN_LEN;
        if layers <= 1 {
            return super::HDR + tail;
        }
        super::HDR + (layers - 1) * (PAIRED_LEN + 128) + tail
    }

    #[test]
    fn v3_cap_fits_height_4_and_rejects_height_5() {
        assert_eq!(v3_proof_len(4), MAX_PROOF_V3);
        assert!(v3_proof_len(5) > MAX_PROOF_V3);
        assert_eq!(v3_proof_len(1), super::HDR + 2 * ARITY * 32 + LEAF_V3_LEN + POINT_OPEN_LEN);
    }

    /// A 23-round one-wire blob is 1920 bytes. Replacing only the raw C bucket
    /// makes height 4 44386 bytes. Replacing the bucket and the point-open
    /// seed and responses, and keeping Q, makes height 4 43330 bytes.
    /// The live verifier still requires the bucket and the trailer.
    /// `bind_slot_opens_one_note_of_the_parent` builds the note hash, the
    /// parent sum, one slot, and that note's committed scalar. The `r·U`
    /// windows are the hash remainder. It is 5630566 gates, inside the 2^23
    /// pad and outside the 2^22 pad.
    #[test]
    fn v3_hide_blob_fits_when_the_point_open_responses_leave() {
        let blob = crate::r1cs::r1cs_blob_len(23);
        assert_eq!(blob, 1920, "one committed wire, 23 rounds");
        let bucket = ARITY * 32;
        let responses = POINT_OPEN_LEN - 32;
        assert_eq!(bucket, 1024);
        assert_eq!(responses, 1056);
        let bucket_only = v3_proof_len(4) - bucket + blob;
        assert_eq!(bucket_only, 44386);
        assert!(bucket_only > MAX_PROOF_V3);
        let with_open = v3_proof_len(4) - bucket - responses + blob;
        assert_eq!(with_open, 43330);
        assert!(with_open <= MAX_PROOF_V3);
        let slot_gates = 5_630_566usize;
        assert!(slot_gates > (1 << 22) && slot_gates <= (1 << 23));
    }
}
