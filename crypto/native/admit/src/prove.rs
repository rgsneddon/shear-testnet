//! ADMITv2 prove / verify. Version byte 2. ADMITv1 (linear r) fails.
//! Membership is D-ary CDS select-and-rerandomize. No d0 / nonce / XOR path
//! / dest_leaf of the spent note on the wire. C-tree leaves are ristretto C;
//! C̃ is a 1-of-D rerandomization of a tree C. Dest admitPub P is 1-of-D as
//! p_com = P_j + w U at the same hidden slot (32-anonymity sibling bucket).

use crate::leaf::{jroot_hash, sha512_64};
use crate::select::{
    leaf_prove, leaf_qd, leaf_verify, paired_prove, paired_qc_opens, paired_qd_opens, paired_verify,
    rs_rand, vs_rand, LEAF_PAIRED_LEN, PAIRED_LEN,
};
use crate::leaf::dest_leaf_fp;
use crate::tree::{
    commit_ristretto_encodings, commit_vesta, leaf_p_siblings, note_u, path_from_levels, rerand_c,
    root_of_levels, trees, ARITY,
};
use ff::PrimeField;
use pasta_curves::vesta;
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::IsIdentity;

pub const MAX_PROOF: usize = 32768;
pub const VERSION: u8 = 2;
const HDR: usize = 1 + 32 * 8 + 1; // version, tag, ct, dest_root, c_root, p_com, r_x, z_x, z_w, n_layers

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
    let i_pt = hp(&p_pt) * xs;
    if i_pt.is_identity() {
        return None;
    }
    let tag = i_pt.compress().to_bytes();
    let (dlevels, clev) = trees(dest_leaves, c_leaves, n);
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
    let jr = jroot_hash(&dest_root, &c_root_b);
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
            let pr = paired_prove(&dpath[layer], &cpath[layer], slots[layer], &td, &tc)?;
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
        let parent_c = commit_ristretto_encodings(&cpath[0]);
        let td_b: [u8; 32] = t_d_prev?.to_repr().into();
        mem.extend_from_slice(&parent_d);
        mem.extend_from_slice(&td_b);
        mem.extend_from_slice(&parent_c);
        mem.extend_from_slice(&t_c_prev?.to_bytes());
    }
    let p_sib = leaf_p_siblings(dest_leaves, n, index)?;
    if p_sib[slots[0]] != *p {
        return None;
    }
    for x in &p_sib {
        mem.extend_from_slice(x);
    }
    for x in &cpath[0] {
        mem.extend_from_slice(x);
    }
    let u = note_u();
    let w = chal(&[b"w", x, p]);
    let p_com = p_pt + u * w;
    let td_leaf = vs_rand();
    let leaf = leaf_prove(
        &dpath[0],
        &cpath[0],
        &p_sib,
        slots[0],
        &td_leaf,
        &ts,
        &w,
        &ct_pt,
        &p_com,
    )?;
    mem.extend_from_slice(&leaf);
    let k = chal(&[b"k", x, t]);
    let a_w = chal(&[b"aw", x, t]);
    let r_x = G * k + u * a_w;
    let dest_q = leaf_qd(&leaf)?;
    let e2 = chal(&[
        b"dleq",
        &r_x.compress().to_bytes(),
        &p_com.compress().to_bytes(),
        &tag,
        &c_tilde,
        &jr,
        &dest_q,
        forest_bind,
    ]);
    let z_x = k + e2 * xs;
    let z_w = a_w + e2 * w;

    let mut proof = Vec::new();
    proof.push(VERSION);
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
    let _ = (dest_leaves, c_leaves, n);
    if proof.is_empty() || proof[0] != VERSION {
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
    if jroot_hash(&dest_root, &c_root_b) != *jr {
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
    let z_x = Scalar::from_bytes_mod_order(read32(proof, 193).unwrap_or([0u8; 32]));
    let z_w = Scalar::from_bytes_mod_order(read32(proof, 225).unwrap_or([0u8; 32]));
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
            if !paired_verify(&dest_parent, &c_parent, pr) {
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
    if !leaf_verify(&dest_parent, &siblings, &p_sib, &ct, &p_com, leaf) {
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
    let e2 = chal(&[
        b"dleq",
        &r_x_b,
        &p_com_b,
        &tag,
        c_tilde,
        jr,
        &dest_q,
        forest_bind,
    ]);
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
        if !admit_verify_in(pr, jr, ct, tag, dest_leaves, c_leaves, n, &bind) {
            return false;
        }
    }
    true
}
