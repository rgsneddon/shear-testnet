//! ADMITv2 prove / verify. Version byte 2. ADMITv1 (linear r) fails.
//! Membership is D-ary CDS select-and-rerandomize. No d0 / nonce / XOR path
//! / dest_leaf of the spent note on the wire. C-tree leaves are ristretto C;
//! C̃ is a 1-of-D rerandomization of a tree C. Dest admitPub P is 1-of-D as
//! p_com = P_j + w U at the same hidden slot.
//! Version 2 still carries the 32-note sibling bucket. Version 3 does not:
//! the leaf opens the parents, and the remainder is blinded.

use crate::leaf::{jroot_hash, jroot_hash_point, sha512_64};
use crate::select::{
    leaf_prove, leaf_qd, leaf_verify, leaf_verify_v3, paired_prove, paired_qc_opens,
    paired_qd_opens, paired_verify, rs_rand, vs_rand, LEAF_PAIRED_LEN, LEAF_V3_LEN, PAIRED_LEN,
};
#[cfg(test)]
use crate::select::{V3_Y, V3_YX};
use crate::leaf::dest_leaf_fp;
use crate::tree::{
    commit_ristretto_encodings, commit_ristretto_points, commit_vesta, leaf_p_siblings, note_u,
    path_from_levels, rerand_c, ristretto_gens, root_of_levels, trees, trees_v3, ARITY,
};
use ff::PrimeField;
use pasta_curves::vesta;
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::IsIdentity;
use rand_core::{OsRng, RngCore};

pub const MAX_PROOF: usize = 32768;
/// Raw dest bucket, its blind, raw C bucket, its blind, then Q‖A‖zᵤ‖zₕ.
/// This replaces the 128-byte parent link in front of a v3 leaf when n > 32.
pub const V3_RAW_LINK: usize = 1024 + 32 + 1024 + 32 + 128;
/// Height-4 v3 proof. The leaf gap carries the raw 32-note bucket, not the
/// scalar parent commitments. Height 5 does not fit. The v2 cap stays 32768.
pub const MAX_PROOF_V3: usize = 42466;
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

/// Q = C_i + ρ·U, bound to Kc = C_i + ρ_c·H. Q is not C_i.
fn v3_note_trailer(
    ctx: &[u8],
    ci: &RistrettoPoint,
    rho_c: &Scalar,
    kc: &[u8; 32],
) -> Option<[u8; 128]> {
    let gens = ristretto_gens();
    let u = gens.0;
    let h = gens.2;
    let mut rho = rs_rand();
    if rho == Scalar::ZERO {
        rho = Scalar::from(1u64);
    }
    let q = ci + u * rho;
    let k_u = rs_rand();
    let k_h = rs_rand();
    let a = u * k_u - h * k_h;
    let q_b = q.compress().to_bytes();
    let a_b = a.compress().to_bytes();
    let e = Scalar::from_bytes_mod_order_wide(&sha512_64(&[ctx, b"c-point-q", &q_b, &a_b, kc]));
    let z_u = (k_u + e * rho).to_bytes();
    let z_h = (k_h + e * rho_c).to_bytes();
    let mut out = [0u8; 128];
    out[..32].copy_from_slice(&q_b);
    out[32..64].copy_from_slice(&a_b);
    out[64..96].copy_from_slice(&z_u);
    out[96..].copy_from_slice(&z_h);
    Some(out)
}

fn v3_trailer_ok(ctx: &[u8], trailer: &[u8], kc: &[u8; 32]) -> bool {
    if trailer.len() != 128 || ctx.len() != 64 {
        return false;
    }
    let q_b = match read32(trailer, 0) {
        Some(x) => x,
        None => return false,
    };
    let a_b = match read32(trailer, 32) {
        Some(x) => x,
        None => return false,
    };
    let z_u = Scalar::from_bytes_mod_order(match read32(trailer, 64) {
        Some(x) => x,
        None => return false,
    });
    let z_h = Scalar::from_bytes_mod_order(match read32(trailer, 96) {
        Some(x) => x,
        None => return false,
    });
    let q = match decompress(&q_b) {
        Some(p) => p,
        None => return false,
    };
    let a = match decompress(&a_b) {
        Some(p) => p,
        None => return false,
    };
    let kc_pt = match decompress(kc) {
        Some(p) => p,
        None => return false,
    };
    let gens = ristretto_gens();
    let u = gens.0;
    let h = gens.2;
    let e = Scalar::from_bytes_mod_order_wide(&sha512_64(&[ctx, b"c-point-q", &q_b, &a_b, kc]));
    u * z_u - h * z_h == a + (q - kc_pt) * e
}

fn read_bucket(proof: &[u8], off: usize) -> Option<[[u8; 32]; ARITY]> {
    let mut xs = [[0u8; 32]; ARITY];
    for i in 0..ARITY {
        xs[i] = read32(proof, off + i * 32)?;
    }
    Some(xs)
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
    admit_prove_in(x, p, c, t, index, dest_leaves, c_leaves, n, &ZERO_BIND, &[])
}

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
    let v3 = !ctx.is_empty();
    if v3 && ctx.len() != 64 {
        return None;
    }
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
    let (dlevels, clev) = if v3 {
        match trees_v3(dest_leaves, c_leaves, n) {
            Some(t) => t,
            None => return None,
        }
    } else {
        trees(dest_leaves, c_leaves, n)
    };
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
    let jr = if v3 {
        jroot_hash_point(&dest_root, &c_root_b)
    } else {
        jroot_hash(&dest_root, &c_root_b)
    };
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
        let td_b: [u8; 32] = t_d_prev?.to_repr().into();
        let tc_b = t_c_prev?.to_bytes();
        if !v3 {
            let parent_d = commit_vesta(&dpath[0]);
            let parent_c = commit_ristretto_encodings(&cpath[0]);
            mem.extend_from_slice(&parent_d);
            mem.extend_from_slice(&td_b);
            mem.extend_from_slice(&parent_c);
            mem.extend_from_slice(&tc_b);
        } else {
            // The raw 32-note bucket stays on the wire. The scalar parent
            // commitments are not. The verifier recomputes both openings.
            for row in &dpath[0] {
                mem.extend_from_slice(row);
            }
            mem.extend_from_slice(&td_b);
            for row in &cpath[0] {
                mem.extend_from_slice(row);
            }
            mem.extend_from_slice(&tc_b);
        }
    }
    let p_sib = leaf_p_siblings(dest_leaves, n, index)?;
    if p_sib[slots[0]] != *p {
        return None;
    }
    let u = note_u();
    let w = chal(&[b"w", x, p]);
    let p_com = p_pt + u * w;
    let td_leaf = vs_rand();
    let mut v3_trail: Option<[u8; 128]> = None;
    let leaf = if v3 {
        if dpath[0][slots[0]] != dest_leaf_fp(p) {
            return None;
        }
        let opened = crate::select::leaf_prove_v3_out(
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
        if n_layers > 1 {
            v3_trail = Some(v3_note_trailer(ctx, &opened.ci, &opened.rho_c, &opened.kc)?);
        }
        opened.proof
    } else {
        for x in &p_sib {
            mem.extend_from_slice(x);
        }
        for x in &cpath[0] {
            mem.extend_from_slice(x);
        }
        leaf_prove(
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
        )?
    };
    if let Some(tr) = v3_trail {
        mem.extend_from_slice(&tr);
    }
    mem.extend_from_slice(&leaf);
    let nonce_rand = if v3 { os_rand32()? } else { [0u8; 32] };
    let k = if v3 {
        chal(&[b"k", ctx, x, t, &nonce_rand])
    } else {
        chal(&[b"k", x, t])
    };
    let a_w = if v3 {
        chal(&[b"aw", ctx, x, t, &nonce_rand])
    } else {
        chal(&[b"aw", x, t])
    };
    let r_x = G * k + u * a_w;
    let dest_q = leaf_qd(&leaf)?;
    let bind = if v3 {
        forest_bind_v3(ctx, &[(tag, c_tilde)])
    } else {
        *forest_bind
    };
    let rx_b = r_x.compress().to_bytes();
    let pc_b = p_com.compress().to_bytes();
    let e2 = if v3 {
        chal(&[
            ctx,
            b"dleq",
            &rx_b,
            &pc_b,
            &tag,
            &c_tilde,
            &jr,
            &dest_q,
            &bind,
        ])
    } else {
        chal(&[
            b"dleq",
            &rx_b,
            &pc_b,
            &tag,
            &c_tilde,
            &jr,
            &dest_q,
            &bind,
        ])
    };
    let z_x = k + e2 * xs;
    let z_w = a_w + e2 * w;

    let mut proof = Vec::new();
    proof.push(if v3 { VERSION_V3 } else { VERSION });
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
    let cap = if v3 { MAX_PROOF_V3 } else { MAX_PROOF };
    if proof.len() > cap {
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
    let (dlevels, clev) = trees_v3(dest_leaves, c_leaves, n)?;
    let dpath = path_from_levels(&dlevels, index)?;
    let cpath = path_from_levels(&clev, index)?;
    if dpath.len() != 1 || cpath.len() != 1 {
        return None;
    }
    let slots = slots_of(index, 1);
    let p_sib = leaf_p_siblings(dest_leaves, n, index)?;
    let dest_root = root_of_levels(&dlevels);
    let c_root_b = root_of_levels(&clev);
    let jr = jroot_hash_point(&dest_root, &c_root_b);
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
    proof.extend_from_slice(&leaf);
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
    let (dlevels, clev) = trees_v3(dest_leaves, c_leaves, n)?;
    let dpath = path_from_levels(&dlevels, index)?;
    let cpath = path_from_levels(&clev, index)?;
    if dpath.len() != 1 || cpath.len() != 1 {
        return None;
    }
    let slots = slots_of(index, 1);
    let p_sib = leaf_p_siblings(dest_leaves, n, index)?;
    let dest_root = root_of_levels(&dlevels);
    let c_root_b = root_of_levels(&clev);
    let jr = jroot_hash_point(&dest_root, &c_root_b);
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
    proof.extend_from_slice(&leaf);
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

pub fn admit_verify(
    proof: &[u8],
    jr: &[u8; 32],
    c_tilde: &[u8; 32],
    spend_tag: &[u8; 32],
    dest_leaves: &[u8],
    c_leaves: &[u8],
    n: usize,
) -> bool {
    admit_verify_in(proof, jr, c_tilde, spend_tag, dest_leaves, c_leaves, n, &ZERO_BIND, &[])
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
    let _ = (dest_leaves, c_leaves, n);
    let v3 = !ctx.is_empty();
    if v3 && ctx.len() != 64 {
        return false;
    }
    let want_ver = if v3 { VERSION_V3 } else { VERSION };
    if proof.is_empty() || proof[0] != want_ver {
        return false;
    }
    let cap = if v3 { MAX_PROOF_V3 } else { MAX_PROOF };
    if proof.len() > cap {
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
    let rooted = if v3 {
        jroot_hash_point(&dest_root, &c_root_b) == *jr
    } else {
        jroot_hash(&dest_root, &c_root_b) == *jr
    };
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
        let po = match prev_off {
            Some(x) => x,
            None => return false,
        };
        let prev = &proof[po..po + PAIRED_LEN];
        if v3 {
            if proof.len() < off + V3_RAW_LINK {
                return false;
            }
            let d_bucket = match read_bucket(proof, off) {
                Some(x) => x,
                None => return false,
            };
            let td = match read32(proof, off + 1024) {
                Some(x) => x,
                None => return false,
            };
            let c_bucket = match read_bucket(proof, off + 1056) {
                Some(x) => x,
                None => return false,
            };
            let tc = match read32(proof, off + 2080) {
                Some(x) => x,
                None => return false,
            };
            let trail_at = off + 2112;
            let trailer = match proof.get(trail_at..trail_at + 128) {
                Some(x) => x,
                None => return false,
            };
            off += V3_RAW_LINK;
            let pd = commit_vesta(&d_bucket);
            let pc_point = match commit_ristretto_points(&c_bucket) {
                Some(x) => x,
                None => return false,
            };
            let pc_scalar = commit_ristretto_encodings(&c_bucket);
            let tdv = match vesta_t(&td) {
                Some(x) => x,
                None => return false,
            };
            if !paired_qd_opens(prev, &pd, &tdv)
                || !paired_qc_opens(prev, &pc_point, &Scalar::from_bytes_mod_order(tc))
            {
                return false;
            }
            let leaf_len = LEAF_V3_LEN;
            if proof.len() < off + leaf_len {
                return false;
            }
            let kc = match read32(proof, off + 96) {
                Some(x) => x,
                None => return false,
            };
            if !v3_trailer_ok(ctx, trailer, &kc) {
                return false;
            }
            dest_parent = pd;
            c_parent = pc_scalar;
        } else {
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
    }
    let ct = match decompress(c_tilde) {
        Some(p) => p,
        None => return false,
    };
    let p_com = match decompress(&p_com_b) {
        Some(p) => p,
        None => return false,
    };
    let leaf_len = if v3 { LEAF_V3_LEN } else { LEAF_PAIRED_LEN };
    if v3 {
        if proof.len() != off + leaf_len {
            return false;
        }
        let leaf = &proof[off..off + leaf_len];
        if !leaf_verify_v3(&dest_parent, &c_parent, &ct, &p_com, leaf, ctx) {
            return false;
        }
        let dest_q = match leaf_qd(leaf) {
            Some(x) => x,
            None => return false,
        };
        return v3_dleq(
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
        );
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
    if commit_ristretto_encodings(&siblings) != c_parent {
        return false;
    }
    if proof.len() < off + LEAF_PAIRED_LEN {
        return false;
    }
    let leaf = &proof[off..off + LEAF_PAIRED_LEN];
    let ct = match decompress(c_tilde) {
        Some(p) => p,
        None => return false,
    };
    let p_com = match decompress(&p_com_b) {
        Some(p) => p,
        None => return false,
    };
    if !leaf_verify(&dest_parent, &siblings, &p_sib, &ct, &p_com, leaf, ctx) {
        return false;
    }
    let dest_q = match leaf_qd(leaf) {
        Some(x) => x,
        None => return false,
    };
    let u = note_u();
    let r_x = match decompress(&r_x_b) {
        Some(p) => p,
        None => return false,
    };
    let bind = if v3 {
        forest_bind_v3(ctx, &[(*spend_tag, *c_tilde)])
    } else {
        *forest_bind
    };
    let e2 = if v3 {
        chal(&[
            ctx,
            b"dleq",
            &r_x_b,
            &p_com_b,
            &tag,
            c_tilde,
            jr,
            &dest_q,
            &bind,
        ])
    } else {
        chal(&[
            b"dleq",
            &r_x_b,
            &p_com_b,
            &tag,
            c_tilde,
            jr,
            &dest_q,
            &bind,
        ])
    };
    if G * z_x + u * z_w != r_x + p_com * e2 {
        return false;
    }
    true
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

fn forest_bind_of(pre: &[([u8; 32], [u8; 32])]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(16 + pre.len() * 64);
    buf.extend_from_slice(b"forest-ct");
    for (tag, ct) in pre {
        buf.extend_from_slice(tag);
        buf.extend_from_slice(ct);
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
) -> Option<Vec<([u8; 32], Vec<u8>)>> {
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
        pre.push((tag, ct));
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
            &[],
        )?);
    }
    Some(out)
}

fn proof_ct_tag(proof: &[u8]) -> Option<([u8; 32], [u8; 32])> {
    let tag = read32(proof, 1)?;
    let ct = read32(proof, 33)?;
    Some((ct, tag))
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
        let (ct_p, tag_p) = match proof_ct_tag(pr) {
            Some(v) => v,
            None => return false,
        };
        if ct_p != *ct || tag_p != *tag {
            return false;
        }
        pre.push((*tag, *ct));
    }
    let bind = forest_bind_of(&pre);
    for (pr, ct, tag) in proofs {
        if !admit_verify_in(pr, jr, ct, tag, dest_leaves, c_leaves, n, &bind, &[]) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod cap_tests {
    use super::{LEAF_V3_LEN, MAX_PROOF_V3, PAIRED_LEN};

    fn v3_proof_len(layers: usize) -> usize {
        if layers <= 1 {
            return super::HDR + LEAF_V3_LEN;
        }
        super::HDR + (layers - 2) * (PAIRED_LEN + 128) + PAIRED_LEN + super::V3_RAW_LINK + LEAF_V3_LEN
    }

    #[test]
    fn v3_cap_fits_height_4_and_rejects_height_5() {
        assert_eq!(v3_proof_len(4), MAX_PROOF_V3);
        assert!(v3_proof_len(5) > MAX_PROOF_V3);
    }
}
