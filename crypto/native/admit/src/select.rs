//! D-ary CDS select-and-rerandomize. No slot index on the wire.
//!
//! Parent `P = r U + Σ x_j G_j` (Pedersen VC). Selected `Q = x_i G_sel + t U`.
//! `W = Σ_{j≠i} x_j G_j` is the other-slot remainder (hiding).
//! Dest (Vesta) and C (ristretto) share one wrap-around so mixed indices fail.
//! C-tree leaves are ristretto C; C̃ = C_i + t H is a 1-of-D at the leaf.

use crate::leaf::sha512_64;
use crate::tree::{
    commit_ristretto_encodings, commit_vesta, ristretto_gens, ristretto_gsel, ristretto_h_note,
    vesta_gens, vesta_gsel, vesta_x, ARITY,
};
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar as RScalar;
use curve25519_dalek::traits::{Identity, IsIdentity};
use ff::{Field, FromUniformBytes, PrimeField};
use group::{Group, GroupEncoding};
use pasta_curves::vesta;
use rand_core::{OsRng, RngCore};

pub const CDS_LEN: usize = 32 + 32 + 32 + ARITY * 32 * 3; // W, Q, c0, z_x/z_r/z_t
pub const PAIRED_LEN: usize = 32 * 4 + 64 + ARITY * 32 * 6; // Wd Qd Wc Qc hv0 + 6 z per slot
pub const LEAF_PAIRED_LEN: usize = 32 * 2 + 64 + ARITY * 32 * 4; // Wd Qd hv0 + dest z*3 + c z_t

pub(crate) fn vs_rand() -> vesta::Scalar {
    let mut w = [0u8; 64];
    OsRng.fill_bytes(&mut w);
    vesta::Scalar::from_uniform_bytes(&w)
}

pub(crate) fn rs_rand() -> RScalar {
    let mut w = [0u8; 64];
    OsRng.fill_bytes(&mut w);
    RScalar::from_bytes_mod_order_wide(&w)
}

fn chal_v(parts: &[&[u8]]) -> vesta::Scalar {
    vesta::Scalar::from_uniform_bytes(&sha512_64(parts))
}

fn chal_r(parts: &[&[u8]]) -> RScalar {
    RScalar::from_bytes_mod_order_wide(&sha512_64(parts))
}

fn enc_v(p: &vesta::Point) -> [u8; 32] {
    let e = p.to_bytes();
    let mut o = [0u8; 32];
    o.copy_from_slice(e.as_ref());
    o
}

fn dec_v(b: &[u8; 32]) -> Option<vesta::Point> {
    Option::<vesta::Point>::from(vesta::Point::from_bytes(b.into()))
}

fn vs(b: &[u8; 32]) -> vesta::Scalar {
    Option::<vesta::Scalar>::from(vesta::Scalar::from_repr((*b).into())).unwrap_or(vesta::Scalar::ZERO)
}

fn enc_r(p: &RistrettoPoint) -> [u8; 32] {
    p.compress().to_bytes()
}

fn dec_r(b: &[u8; 32]) -> Option<RistrettoPoint> {
    curve25519_dalek::ristretto::CompressedRistretto(*b).decompress()
}

fn rsc(b: &[u8; 32]) -> RScalar {
    RScalar::from_bytes_mod_order(*b)
}

fn pack_cds(
    w: &[u8; 32],
    q: &[u8; 32],
    c0: &[u8; 32],
    zx: &[[u8; 32]; ARITY],
    zr: &[[u8; 32]; ARITY],
    zt: &[[u8; 32]; ARITY],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(CDS_LEN);
    out.extend_from_slice(w);
    out.extend_from_slice(q);
    out.extend_from_slice(c0);
    for j in 0..ARITY {
        out.extend_from_slice(&zx[j]);
        out.extend_from_slice(&zr[j]);
        out.extend_from_slice(&zt[j]);
    }
    out
}

fn take32(p: &[u8], off: usize) -> Option<[u8; 32]> {
    p.get(off..off + 32)?.try_into().ok()
}

/// Prove Q opens children[index] and parent = commit_vesta(children). No index in `out`.
pub fn cds_prove_vesta(children: &[[u8; 32]; ARITY], index: usize, t: &vesta::Scalar) -> Option<Vec<u8>> {
    if index >= ARITY {
        return None;
    }
    let x = vesta_x(&children[index]);
    if bool::from(x.is_zero()) {
        return None;
    }
    let (u, g) = vesta_gens();
    let gsel = vesta_gsel();
    let r = crate::tree::blind_fp(children);
    let parent_b = commit_vesta(children);
    let p = dec_v(&parent_b)?;
    let mut wpt = vesta::Point::identity();
    for k in 0..ARITY {
        if k == index {
            continue;
        }
        wpt += g[k] * vesta_x(&children[k]);
    }
    let q = gsel * x + *u * t;
    let pw = p - wpt;
    let mut z_x = [[0u8; 32]; ARITY];
    let mut z_r = [[0u8; 32]; ARITY];
    let mut z_t = [[0u8; 32]; ARITY];
    let kx = vs_rand();
    let kr = vs_rand();
    let kt = vs_rand();
    let rp_i = *u * kr + g[index] * kx;
    let rq_i = gsel * kx + *u * kt;
    let mut e = chal_v(&[
        &enc_v(&rp_i),
        &enc_v(&rq_i),
        &parent_b,
        &enc_v(&wpt),
        &enc_v(&q),
        b"cds-v",
    ]);
    let mut j = (index + 1) % ARITY;
    while j != index {
        let zx = vs_rand();
        let zr = vs_rand();
        let zt = vs_rand();
        z_x[j] = zx.to_repr().into();
        z_r[j] = zr.to_repr().into();
        z_t[j] = zt.to_repr().into();
        let rp = *u * zr + g[j] * zx - pw * e;
        let rq = gsel * zx + *u * zt - q * e;
        e = chal_v(&[
            &enc_v(&rp),
            &enc_v(&rq),
            &parent_b,
            &enc_v(&wpt),
            &enc_v(&q),
            b"cds-v",
        ]);
        j = (j + 1) % ARITY;
    }
    z_x[index] = (kx + e * x).to_repr().into();
    z_r[index] = (kr + e * r).to_repr().into();
    z_t[index] = (kt + e * *t).to_repr().into();
    let mut e0 = chal_v(&[
        &enc_v(&rp_i),
        &enc_v(&rq_i),
        &parent_b,
        &enc_v(&wpt),
        &enc_v(&q),
        b"cds-v",
    ]);
    let mut jj = (index + 1) % ARITY;
    while jj != 0 {
        let zx = vs(&z_x[jj]);
        let zr = vs(&z_r[jj]);
        let zt = vs(&z_t[jj]);
        let rp = *u * zr + g[jj] * zx - pw * e0;
        let rq = gsel * zx + *u * zt - q * e0;
        e0 = chal_v(&[
            &enc_v(&rp),
            &enc_v(&rq),
            &parent_b,
            &enc_v(&wpt),
            &enc_v(&q),
            b"cds-v",
        ]);
        jj = (jj + 1) % ARITY;
    }
    Some(pack_cds(
        &enc_v(&wpt),
        &enc_v(&q),
        &e0.to_repr().into(),
        &z_x,
        &z_r,
        &z_t,
    ))
}

pub fn cds_verify_vesta(parent: &[u8; 32], proof: &[u8]) -> bool {
    if proof.len() != CDS_LEN {
        return false;
    }
    let w_b: [u8; 32] = match take32(proof, 0) {
        Some(x) => x,
        None => return false,
    };
    let q_b: [u8; 32] = match take32(proof, 32) {
        Some(x) => x,
        None => return false,
    };
    let c0: [u8; 32] = match take32(proof, 64) {
        Some(x) => x,
        None => return false,
    };
    let p = match dec_v(parent) {
        Some(x) => x,
        None => return false,
    };
    let wpt = match dec_v(&w_b) {
        Some(x) => x,
        None => return false,
    };
    let q = match dec_v(&q_b) {
        Some(x) => x,
        None => return false,
    };
    if bool::from(q.is_identity()) {
        return false;
    }
    let (u, g) = vesta_gens();
    let gsel = vesta_gsel();
    let pw = p - wpt;
    let mut e = vs(&c0);
    let mut off = 96;
    for j in 0..ARITY {
        let zx = vs(&match take32(proof, off) {
            Some(x) => x,
            None => return false,
        });
        let zr = vs(&match take32(proof, off + 32) {
            Some(x) => x,
            None => return false,
        });
        let zt = vs(&match take32(proof, off + 64) {
            Some(x) => x,
            None => return false,
        });
        off += 96;
        let rp = *u * zr + g[j] * zx - pw * e;
        let rq = gsel * zx + *u * zt - q * e;
        e = chal_v(&[
            &enc_v(&rp),
            &enc_v(&rq),
            parent,
            &w_b,
            &q_b,
            b"cds-v",
        ]);
    }
    e == vs(&c0)
}

/// Ristretto CDS. Children are 32-byte encodings (C compress or parent encodings).
pub fn cds_prove_ristretto(children: &[[u8; 32]; ARITY], index: usize, t: &RScalar) -> Option<Vec<u8>> {
    if index >= ARITY {
        return None;
    }
    let x = rsc(&children[index]);
    if x == RScalar::ZERO {
        return None;
    }
    let (u, g, _) = ristretto_gens();
    let gsel = ristretto_gsel();
    let parent_b = commit_ristretto_encodings(children);
    let p = dec_r(&parent_b)?;
    let r = {
        let mut parts: Vec<&[u8]> = vec![b"shear-ct-c-blind"];
        for c in children {
            parts.push(c.as_ref());
        }
        RScalar::from_bytes_mod_order_wide(&sha512_64(&parts))
    };
    let mut wpt = RistrettoPoint::identity();
    for k in 0..ARITY {
        if k == index {
            continue;
        }
        wpt += g[k] * rsc(&children[k]);
    }
    let q = gsel * x + u * t;
    let pw = p - wpt;
    let mut z_x = [[0u8; 32]; ARITY];
    let mut z_r = [[0u8; 32]; ARITY];
    let mut z_t = [[0u8; 32]; ARITY];
    let kx = rs_rand();
    let kr = rs_rand();
    let kt = rs_rand();
    let rp_i = u * kr + g[index] * kx;
    let rq_i = gsel * kx + u * kt;
    let mut e = chal_r(&[
        &enc_r(&rp_i),
        &enc_r(&rq_i),
        &parent_b,
        &enc_r(&wpt),
        &enc_r(&q),
        b"cds-r",
    ]);
    let mut j = (index + 1) % ARITY;
    while j != index {
        let zx = rs_rand();
        let zr = rs_rand();
        let zt = rs_rand();
        z_x[j] = zx.to_bytes();
        z_r[j] = zr.to_bytes();
        z_t[j] = zt.to_bytes();
        let rp = u * zr + g[j] * zx - pw * e;
        let rq = gsel * zx + u * zt - q * e;
        e = chal_r(&[
            &enc_r(&rp),
            &enc_r(&rq),
            &parent_b,
            &enc_r(&wpt),
            &enc_r(&q),
            b"cds-r",
        ]);
        j = (j + 1) % ARITY;
    }
    z_x[index] = (kx + e * x).to_bytes();
    z_r[index] = (kr + e * r).to_bytes();
    z_t[index] = (kt + e * *t).to_bytes();
    let mut e0 = chal_r(&[
        &enc_r(&rp_i),
        &enc_r(&rq_i),
        &parent_b,
        &enc_r(&wpt),
        &enc_r(&q),
        b"cds-r",
    ]);
    let mut jj = (index + 1) % ARITY;
    while jj != 0 {
        let zx = rsc(&z_x[jj]);
        let zr = rsc(&z_r[jj]);
        let zt = rsc(&z_t[jj]);
        let rp = u * zr + g[jj] * zx - pw * e0;
        let rq = gsel * zx + u * zt - q * e0;
        e0 = chal_r(&[
            &enc_r(&rp),
            &enc_r(&rq),
            &parent_b,
            &enc_r(&wpt),
            &enc_r(&q),
            b"cds-r",
        ]);
        jj = (jj + 1) % ARITY;
    }
    Some(pack_cds(
        &enc_r(&wpt),
        &enc_r(&q),
        &e0.to_bytes(),
        &z_x,
        &z_r,
        &z_t,
    ))
}

pub fn cds_verify_ristretto(parent: &[u8; 32], proof: &[u8]) -> bool {
    if proof.len() != CDS_LEN {
        return false;
    }
    let w_b: [u8; 32] = match take32(proof, 0) {
        Some(x) => x,
        None => return false,
    };
    let q_b: [u8; 32] = match take32(proof, 32) {
        Some(x) => x,
        None => return false,
    };
    let c0: [u8; 32] = match take32(proof, 64) {
        Some(x) => x,
        None => return false,
    };
    let p = match dec_r(parent) {
        Some(x) => x,
        None => return false,
    };
    let wpt = match dec_r(&w_b) {
        Some(x) => x,
        None => return false,
    };
    let q = match dec_r(&q_b) {
        Some(x) => x,
        None => return false,
    };
    if q.is_identity() {
        return false;
    }
    let (u, g, _) = ristretto_gens();
    let gsel = ristretto_gsel();
    let pw = p - wpt;
    let mut e = rsc(&c0);
    let mut off = 96;
    for j in 0..ARITY {
        let zx = rsc(&match take32(proof, off) {
            Some(x) => x,
            None => return false,
        });
        let zr = rsc(&match take32(proof, off + 32) {
            Some(x) => x,
            None => return false,
        });
        let zt = rsc(&match take32(proof, off + 64) {
            Some(x) => x,
            None => return false,
        });
        off += 96;
        let rp = u * zr + g[j] * zx - pw * e;
        let rq = gsel * zx + u * zt - q * e;
        e = chal_r(&[
            &enc_r(&rp),
            &enc_r(&rq),
            parent,
            &w_b,
            &q_b,
            b"cds-r",
        ]);
    }
    e == rsc(&c0)
}

pub fn selected_q_bytes(proof: &[u8]) -> Option<[u8; 32]> {
    if proof.len() < 64 {
        return None;
    }
    proof[32..64].try_into().ok()
}

pub fn cds_q_opens_vesta(proof: &[u8], x_bytes: &[u8; 32], t: &vesta::Scalar) -> bool {
    let q_b = match selected_q_bytes(proof) {
        Some(x) => x,
        None => return false,
    };
    let q = match dec_v(&q_b) {
        Some(x) => x,
        None => return false,
    };
    let (u, _) = vesta_gens();
    let gsel = vesta_gsel();
    q == gsel * vesta_x(x_bytes) + *u * t
}

pub fn cds_q_opens_ristretto(proof: &[u8], x_bytes: &[u8; 32], t: &RScalar) -> bool {
    let q_b = match selected_q_bytes(proof) {
        Some(x) => x,
        None => return false,
    };
    let q = match dec_r(&q_b) {
        Some(x) => x,
        None => return false,
    };
    let (u, _, _) = ristretto_gens();
    let gsel = ristretto_gsel();
    q == gsel * rsc(x_bytes) + u * t
}

pub fn paired_qd(proof: &[u8]) -> Option<[u8; 32]> {
    if proof.len() != PAIRED_LEN {
        return None;
    }
    proof[32..64].try_into().ok()
}

pub fn paired_qc(proof: &[u8]) -> Option<[u8; 32]> {
    if proof.len() != PAIRED_LEN {
        return None;
    }
    proof[96..128].try_into().ok()
}

fn pair_chal(
    rpd: &[u8; 32],
    rqd: &[u8; 32],
    rpc: &[u8; 32],
    rqc: &[u8; 32],
    pd: &[u8; 32],
    wd: &[u8; 32],
    qd: &[u8; 32],
    pc: &[u8; 32],
    wc: &[u8; 32],
    qc: &[u8; 32],
) -> [u8; 64] {
    sha512_64(&[rpd, rqd, rpc, rqc, pd, wd, qd, pc, wc, qc, b"cds-pair"])
}

/// Dest + C CDS with one wrap-around. Same hidden slot for both trees.
pub fn paired_prove(
    dest_ch: &[[u8; 32]; ARITY],
    c_ch: &[[u8; 32]; ARITY],
    index: usize,
    t_d: &vesta::Scalar,
    t_c: &RScalar,
) -> Option<Vec<u8>> {
    if index >= ARITY {
        return None;
    }
    let xd = vesta_x(&dest_ch[index]);
    let xc = rsc(&c_ch[index]);
    if bool::from(xd.is_zero()) || xc == RScalar::ZERO {
        return None;
    }
    let (ud, gd) = vesta_gens();
    let gseld = vesta_gsel();
    let (uc, gc, _) = ristretto_gens();
    let gselc = ristretto_gsel();
    let pd_b = commit_vesta(dest_ch);
    let pc_b = commit_ristretto_encodings(c_ch);
    let pd = dec_v(&pd_b)?;
    let pc = dec_r(&pc_b)?;
    let rd = crate::tree::blind_fp(dest_ch);
    let rc = {
        let mut parts: Vec<&[u8]> = vec![b"shear-ct-c-blind"];
        for c in c_ch {
            parts.push(c.as_ref());
        }
        RScalar::from_bytes_mod_order_wide(&sha512_64(&parts))
    };
    let mut wd = vesta::Point::identity();
    let mut wc = RistrettoPoint::identity();
    for k in 0..ARITY {
        if k == index {
            continue;
        }
        wd += gd[k] * vesta_x(&dest_ch[k]);
        wc += gc[k] * rsc(&c_ch[k]);
    }
    let qd = gseld * xd + *ud * t_d;
    let qc = gselc * xc + uc * t_c;
    let pwd = pd - wd;
    let pwc = pc - wc;
    let wd_b = enc_v(&wd);
    let qd_b = enc_v(&qd);
    let wc_b = enc_r(&wc);
    let qc_b = enc_r(&qc);

    let mut zxd = [[0u8; 32]; ARITY];
    let mut zrd = [[0u8; 32]; ARITY];
    let mut ztd = [[0u8; 32]; ARITY];
    let mut zxc = [[0u8; 32]; ARITY];
    let mut zrc = [[0u8; 32]; ARITY];
    let mut ztc = [[0u8; 32]; ARITY];
    let kxd = vs_rand();
    let krd = vs_rand();
    let ktd = vs_rand();
    let kxc = rs_rand();
    let krc = rs_rand();
    let ktc = rs_rand();
    let rpd_i = *ud * krd + gd[index] * kxd;
    let rqd_i = gseld * kxd + *ud * ktd;
    let rpc_i = uc * krc + gc[index] * kxc;
    let rqc_i = gselc * kxc + uc * ktc;
    let hv = pair_chal(
        &enc_v(&rpd_i),
        &enc_v(&rqd_i),
        &enc_r(&rpc_i),
        &enc_r(&rqc_i),
        &pd_b,
        &wd_b,
        &qd_b,
        &pc_b,
        &wc_b,
        &qc_b,
    );
    let mut ed = vesta::Scalar::from_uniform_bytes(&hv);
    let mut ec = RScalar::from_bytes_mod_order_wide(&hv);
    let mut j = (index + 1) % ARITY;
    while j != index {
        let a = vs_rand();
        let b = vs_rand();
        let c = vs_rand();
        let d = rs_rand();
        let e = rs_rand();
        let f = rs_rand();
        zxd[j] = a.to_repr().into();
        zrd[j] = b.to_repr().into();
        ztd[j] = c.to_repr().into();
        zxc[j] = d.to_bytes();
        zrc[j] = e.to_bytes();
        ztc[j] = f.to_bytes();
        let rpd = *ud * b + gd[j] * a - pwd * ed;
        let rqd = gseld * a + *ud * c - qd * ed;
        let rpc = uc * e + gc[j] * d - pwc * ec;
        let rqc = gselc * d + uc * f - qc * ec;
        let hv = pair_chal(
            &enc_v(&rpd),
            &enc_v(&rqd),
            &enc_r(&rpc),
            &enc_r(&rqc),
            &pd_b,
            &wd_b,
            &qd_b,
            &pc_b,
            &wc_b,
            &qc_b,
        );
        ed = vesta::Scalar::from_uniform_bytes(&hv);
        ec = RScalar::from_bytes_mod_order_wide(&hv);
        j = (j + 1) % ARITY;
    }
    zxd[index] = (kxd + ed * xd).to_repr().into();
    zrd[index] = (krd + ed * rd).to_repr().into();
    ztd[index] = (ktd + ed * *t_d).to_repr().into();
    zxc[index] = (kxc + ec * xc).to_bytes();
    zrc[index] = (krc + ec * rc).to_bytes();
    ztc[index] = (ktc + ec * *t_c).to_bytes();

    let mut seed0 = pair_chal(
        &enc_v(&rpd_i),
        &enc_v(&rqd_i),
        &enc_r(&rpc_i),
        &enc_r(&rqc_i),
        &pd_b,
        &wd_b,
        &qd_b,
        &pc_b,
        &wc_b,
        &qc_b,
    );
    let mut e0d = vesta::Scalar::from_uniform_bytes(&seed0);
    let mut e0c = RScalar::from_bytes_mod_order_wide(&seed0);
    let mut jj = (index + 1) % ARITY;
    while jj != 0 {
        let a = vs(&zxd[jj]);
        let b = vs(&zrd[jj]);
        let c = vs(&ztd[jj]);
        let d = rsc(&zxc[jj]);
        let e = rsc(&zrc[jj]);
        let f = rsc(&ztc[jj]);
        let rpd = *ud * b + gd[jj] * a - pwd * e0d;
        let rqd = gseld * a + *ud * c - qd * e0d;
        let rpc = uc * e + gc[jj] * d - pwc * e0c;
        let rqc = gselc * d + uc * f - qc * e0c;
        seed0 = pair_chal(
            &enc_v(&rpd),
            &enc_v(&rqd),
            &enc_r(&rpc),
            &enc_r(&rqc),
            &pd_b,
            &wd_b,
            &qd_b,
            &pc_b,
            &wc_b,
            &qc_b,
        );
        e0d = vesta::Scalar::from_uniform_bytes(&seed0);
        e0c = RScalar::from_bytes_mod_order_wide(&seed0);
        jj = (jj + 1) % ARITY;
    }
    let mut out = Vec::with_capacity(PAIRED_LEN);
    out.extend_from_slice(&wd_b);
    out.extend_from_slice(&qd_b);
    out.extend_from_slice(&wc_b);
    out.extend_from_slice(&qc_b);
    out.extend_from_slice(&seed0);
    for j in 0..ARITY {
        out.extend_from_slice(&zxd[j]);
        out.extend_from_slice(&zrd[j]);
        out.extend_from_slice(&ztd[j]);
        out.extend_from_slice(&zxc[j]);
        out.extend_from_slice(&zrc[j]);
        out.extend_from_slice(&ztc[j]);
    }
    Some(out)
}

pub fn paired_verify(dest_parent: &[u8; 32], c_parent: &[u8; 32], proof: &[u8]) -> bool {
    if proof.len() != PAIRED_LEN {
        return false;
    }
    let wd_b = match take32(proof, 0) {
        Some(x) => x,
        None => return false,
    };
    let qd_b = match take32(proof, 32) {
        Some(x) => x,
        None => return false,
    };
    let wc_b = match take32(proof, 64) {
        Some(x) => x,
        None => return false,
    };
    let qc_b = match take32(proof, 96) {
        Some(x) => x,
        None => return false,
    };
    let hv0: [u8; 64] = match proof.get(128..192).and_then(|s| s.try_into().ok()) {
        Some(x) => x,
        None => return false,
    };
    let pd = match dec_v(dest_parent) {
        Some(x) => x,
        None => return false,
    };
    let pc = match dec_r(c_parent) {
        Some(x) => x,
        None => return false,
    };
    let wd = match dec_v(&wd_b) {
        Some(x) => x,
        None => return false,
    };
    let qd = match dec_v(&qd_b) {
        Some(x) => x,
        None => return false,
    };
    let wc = match dec_r(&wc_b) {
        Some(x) => x,
        None => return false,
    };
    let qc = match dec_r(&qc_b) {
        Some(x) => x,
        None => return false,
    };
    if bool::from(qd.is_identity()) || qc.is_identity() {
        return false;
    }
    let (ud, gd) = vesta_gens();
    let gseld = vesta_gsel();
    let (uc, gc, _) = ristretto_gens();
    let gselc = ristretto_gsel();
    let pwd = pd - wd;
    let pwc = pc - wc;
    let mut ed = vesta::Scalar::from_uniform_bytes(&hv0);
    let mut ec = RScalar::from_bytes_mod_order_wide(&hv0);
    let mut off = 192;
    let mut last = hv0;
    for j in 0..ARITY {
        let a = vs(&match take32(proof, off) {
            Some(x) => x,
            None => return false,
        });
        let b = vs(&match take32(proof, off + 32) {
            Some(x) => x,
            None => return false,
        });
        let c = vs(&match take32(proof, off + 64) {
            Some(x) => x,
            None => return false,
        });
        let d = rsc(&match take32(proof, off + 96) {
            Some(x) => x,
            None => return false,
        });
        let e = rsc(&match take32(proof, off + 128) {
            Some(x) => x,
            None => return false,
        });
        let f = rsc(&match take32(proof, off + 160) {
            Some(x) => x,
            None => return false,
        });
        off += 192;
        let rpd = *ud * b + gd[j] * a - pwd * ed;
        let rqd = gseld * a + *ud * c - qd * ed;
        let rpc = uc * e + gc[j] * d - pwc * ec;
        let rqc = gselc * d + uc * f - qc * ec;
        let hv = pair_chal(
            &enc_v(&rpd),
            &enc_v(&rqd),
            &enc_r(&rpc),
            &enc_r(&rqc),
            dest_parent,
            &wd_b,
            &qd_b,
            c_parent,
            &wc_b,
            &qc_b,
        );
        last = hv;
        ed = vesta::Scalar::from_uniform_bytes(&hv);
        ec = RScalar::from_bytes_mod_order_wide(&hv);
    }
    last == hv0
}

pub fn paired_qd_opens(proof: &[u8], x_bytes: &[u8; 32], t: &vesta::Scalar) -> bool {
    let q_b = match paired_qd(proof) {
        Some(x) => x,
        None => return false,
    };
    let q = match dec_v(&q_b) {
        Some(x) => x,
        None => return false,
    };
    let (u, _) = vesta_gens();
    q == vesta_gsel() * vesta_x(x_bytes) + *u * t
}

pub fn paired_qc_opens(proof: &[u8], x_bytes: &[u8; 32], t: &RScalar) -> bool {
    let q_b = match paired_qc(proof) {
        Some(x) => x,
        None => return false,
    };
    let q = match dec_r(&q_b) {
        Some(x) => x,
        None => return false,
    };
    let (u, _, _) = ristretto_gens();
    q == ristretto_gsel() * rsc(x_bytes) + u * t
}

fn leaf_chal(
    rpd: &[u8; 32],
    rqd: &[u8; 32],
    rc: &[u8; 32],
    pd: &[u8; 32],
    wd: &[u8; 32],
    qd: &[u8; 32],
    ct: &[u8; 32],
    siblings: &[u8],
) -> [u8; 64] {
    sha512_64(&[rpd, rqd, rc, pd, wd, qd, ct, siblings, b"cds-leaf"])
}

/// Leaf: dest CDS + C̃ = C_j + t H, same hidden slot. `c_ch` are compressed C.
pub fn leaf_prove(
    dest_ch: &[[u8; 32]; ARITY],
    c_ch: &[[u8; 32]; ARITY],
    index: usize,
    t_d: &vesta::Scalar,
    t_note: &RScalar,
    c_tilde: &RistrettoPoint,
) -> Option<Vec<u8>> {
    if index >= ARITY {
        return None;
    }
    let xd = vesta_x(&dest_ch[index]);
    if bool::from(xd.is_zero()) {
        return None;
    }
    let ci = dec_r(&c_ch[index])?;
    let h = ristretto_h_note();
    if *c_tilde != ci + h * t_note {
        return None;
    }
    let (ud, gd) = vesta_gens();
    let gseld = vesta_gsel();
    let pd_b = commit_vesta(dest_ch);
    let pd = dec_v(&pd_b)?;
    let rd = crate::tree::blind_fp(dest_ch);
    let mut wd = vesta::Point::identity();
    for k in 0..ARITY {
        if k == index {
            continue;
        }
        wd += gd[k] * vesta_x(&dest_ch[k]);
    }
    let qd = gseld * xd + *ud * t_d;
    let pwd = pd - wd;
    let wd_b = enc_v(&wd);
    let qd_b = enc_v(&qd);
    let ct_b = enc_r(c_tilde);
    let mut sib = Vec::with_capacity(ARITY * 32);
    for c in c_ch {
        sib.extend_from_slice(c);
    }

    let mut zxd = [[0u8; 32]; ARITY];
    let mut zrd = [[0u8; 32]; ARITY];
    let mut ztd = [[0u8; 32]; ARITY];
    let mut zct = [[0u8; 32]; ARITY];
    let kxd = vs_rand();
    let krd = vs_rand();
    let ktd = vs_rand();
    let kct = rs_rand();
    let rpd_i = *ud * krd + gd[index] * kxd;
    let rqd_i = gseld * kxd + *ud * ktd;
    let rc_i = h * kct;
    let hv = leaf_chal(
        &enc_v(&rpd_i),
        &enc_v(&rqd_i),
        &enc_r(&rc_i),
        &pd_b,
        &wd_b,
        &qd_b,
        &ct_b,
        &sib,
    );
    let mut ed = vesta::Scalar::from_uniform_bytes(&hv);
    let mut ec = RScalar::from_bytes_mod_order_wide(&hv);
    let mut j = (index + 1) % ARITY;
    while j != index {
        let a = vs_rand();
        let b = vs_rand();
        let c = vs_rand();
        let d = rs_rand();
        zxd[j] = a.to_repr().into();
        zrd[j] = b.to_repr().into();
        ztd[j] = c.to_repr().into();
        zct[j] = d.to_bytes();
        let cj = dec_r(&c_ch[j]).unwrap_or_else(RistrettoPoint::identity);
        let rpd = *ud * b + gd[j] * a - pwd * ed;
        let rqd = gseld * a + *ud * c - qd * ed;
        let rc = h * d - (*c_tilde - cj) * ec;
        let hv = leaf_chal(
            &enc_v(&rpd),
            &enc_v(&rqd),
            &enc_r(&rc),
            &pd_b,
            &wd_b,
            &qd_b,
            &ct_b,
            &sib,
        );
        ed = vesta::Scalar::from_uniform_bytes(&hv);
        ec = RScalar::from_bytes_mod_order_wide(&hv);
        j = (j + 1) % ARITY;
    }
    zxd[index] = (kxd + ed * xd).to_repr().into();
    zrd[index] = (krd + ed * rd).to_repr().into();
    ztd[index] = (ktd + ed * *t_d).to_repr().into();
    zct[index] = (kct + ec * *t_note).to_bytes();

    let mut seed0 = leaf_chal(
        &enc_v(&rpd_i),
        &enc_v(&rqd_i),
        &enc_r(&rc_i),
        &pd_b,
        &wd_b,
        &qd_b,
        &ct_b,
        &sib,
    );
    let mut e0d = vesta::Scalar::from_uniform_bytes(&seed0);
    let mut e0c = RScalar::from_bytes_mod_order_wide(&seed0);
    let mut jj = (index + 1) % ARITY;
    while jj != 0 {
        let a = vs(&zxd[jj]);
        let b = vs(&zrd[jj]);
        let c = vs(&ztd[jj]);
        let d = rsc(&zct[jj]);
        let cj = dec_r(&c_ch[jj]).unwrap_or_else(RistrettoPoint::identity);
        let rpd = *ud * b + gd[jj] * a - pwd * e0d;
        let rqd = gseld * a + *ud * c - qd * e0d;
        let rc = h * d - (*c_tilde - cj) * e0c;
        seed0 = leaf_chal(
            &enc_v(&rpd),
            &enc_v(&rqd),
            &enc_r(&rc),
            &pd_b,
            &wd_b,
            &qd_b,
            &ct_b,
            &sib,
        );
        e0d = vesta::Scalar::from_uniform_bytes(&seed0);
        e0c = RScalar::from_bytes_mod_order_wide(&seed0);
        jj = (jj + 1) % ARITY;
    }
    let mut out = Vec::with_capacity(LEAF_PAIRED_LEN);
    out.extend_from_slice(&wd_b);
    out.extend_from_slice(&qd_b);
    out.extend_from_slice(&seed0);
    for j in 0..ARITY {
        out.extend_from_slice(&zxd[j]);
        out.extend_from_slice(&zrd[j]);
        out.extend_from_slice(&ztd[j]);
        out.extend_from_slice(&zct[j]);
    }
    Some(out)
}

pub fn leaf_qd(proof: &[u8]) -> Option<[u8; 32]> {
    if proof.len() != LEAF_PAIRED_LEN {
        return None;
    }
    proof[32..64].try_into().ok()
}

pub fn leaf_verify(
    dest_parent: &[u8; 32],
    c_ch: &[[u8; 32]; ARITY],
    c_tilde: &RistrettoPoint,
    proof: &[u8],
) -> bool {
    if proof.len() != LEAF_PAIRED_LEN {
        return false;
    }
    let wd_b = match take32(proof, 0) {
        Some(x) => x,
        None => return false,
    };
    let qd_b = match take32(proof, 32) {
        Some(x) => x,
        None => return false,
    };
    let hv0: [u8; 64] = match proof.get(64..128).and_then(|s| s.try_into().ok()) {
        Some(x) => x,
        None => return false,
    };
    let pd = match dec_v(dest_parent) {
        Some(x) => x,
        None => return false,
    };
    let wd = match dec_v(&wd_b) {
        Some(x) => x,
        None => return false,
    };
    let qd = match dec_v(&qd_b) {
        Some(x) => x,
        None => return false,
    };
    if bool::from(qd.is_identity()) || c_tilde.is_identity() {
        return false;
    }
    let (ud, gd) = vesta_gens();
    let gseld = vesta_gsel();
    let h = ristretto_h_note();
    let pwd = pd - wd;
    let ct_b = enc_r(c_tilde);
    let mut sib = Vec::with_capacity(ARITY * 32);
    for c in c_ch {
        sib.extend_from_slice(c);
    }
    let mut ed = vesta::Scalar::from_uniform_bytes(&hv0);
    let mut ec = RScalar::from_bytes_mod_order_wide(&hv0);
    let mut off = 128;
    let mut last = hv0;
    for j in 0..ARITY {
        let a = vs(&match take32(proof, off) {
            Some(x) => x,
            None => return false,
        });
        let b = vs(&match take32(proof, off + 32) {
            Some(x) => x,
            None => return false,
        });
        let c = vs(&match take32(proof, off + 64) {
            Some(x) => x,
            None => return false,
        });
        let d = rsc(&match take32(proof, off + 96) {
            Some(x) => x,
            None => return false,
        });
        off += 128;
        let cj = dec_r(&c_ch[j]).unwrap_or_else(RistrettoPoint::identity);
        let rpd = *ud * b + gd[j] * a - pwd * ed;
        let rqd = gseld * a + *ud * c - qd * ed;
        let rc = h * d - (*c_tilde - cj) * ec;
        let hv = leaf_chal(
            &enc_v(&rpd),
            &enc_v(&rqd),
            &enc_r(&rc),
            dest_parent,
            &wd_b,
            &qd_b,
            &ct_b,
            &sib,
        );
        last = hv;
        ed = vesta::Scalar::from_uniform_bytes(&hv);
        ec = RScalar::from_bytes_mod_order_wide(&hv);
    }
    last == hv0
}

/// Proof bytes contain neither the slot index as a dedicated field nor any raw child 32-byte encoding.
pub fn cds_hides_index_and_child(proof: &[u8], children: &[[u8; 32]; ARITY], _index: usize) -> bool {
    if proof.is_empty() {
        return false;
    }
    for c in children {
        if proof.windows(32).any(|w| w == c) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::commit_vesta;

    fn kids(tag: u8) -> [[u8; 32]; ARITY] {
        let mut xs = [[0u8; 32]; ARITY];
        for i in 0..ARITY {
            xs[i][0] = tag;
            xs[i][1] = i as u8;
            xs[i][2] = 1;
        }
        xs
    }

    #[test]
    fn vesta_cds_honest_and_wrong_parent() {
        let ch = kids(7);
        let t = vs_rand();
        let pr = cds_prove_vesta(&ch, 5, &t).expect("prove");
        assert_eq!(pr.len(), CDS_LEN);
        let parent = commit_vesta(&ch);
        assert!(cds_verify_vesta(&parent, &pr));
        let mut bad = parent;
        bad[0] ^= 1;
        assert!(!cds_verify_vesta(&bad, &pr));
        assert!(cds_hides_index_and_child(&pr, &ch, 5));
        let q = selected_q_bytes(&pr).unwrap();
        assert!(!ch.iter().any(|c| c == &q));
        assert!(cds_q_opens_vesta(&pr, &ch[5], &t));
        assert!(!cds_q_opens_vesta(&pr, &ch[4], &t));
    }

    #[test]
    fn ristretto_cds_honest() {
        let mut ch = [[0u8; 32]; ARITY];
        for i in 0..ARITY {
            let t = rs_rand();
            let p = curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT * t;
            ch[i] = p.compress().to_bytes();
        }
        let t = rs_rand();
        let pr = cds_prove_ristretto(&ch, 9, &t).expect("prove");
        let parent = commit_ristretto_encodings(&ch);
        assert!(cds_verify_ristretto(&parent, &pr));
        assert!(cds_hides_index_and_child(&pr, &ch, 9));
    }

    #[test]
    fn paired_same_slot_and_mixed_fails() {
        let d = kids(3);
        let mut c = [[0u8; 32]; ARITY];
        for i in 0..ARITY {
            c[i] = kids(9)[i];
            c[i][3] = 2;
        }
        let td = vs_rand();
        let tc = rs_rand();
        let pr = paired_prove(&d, &c, 4, &td, &tc).expect("pair");
        assert_eq!(pr.len(), PAIRED_LEN);
        let pd = commit_vesta(&d);
        let pc = commit_ristretto_encodings(&c);
        assert!(paired_verify(&pd, &pc, &pr));
        assert!(!paired_verify(&pc, &pd, &pr));
        let pr_m = paired_prove(&d, &c, 4, &td, &tc).expect("p2");
        // swapping C parent (mixed trees) fails
        let mut c2 = c;
        c2[0][0] ^= 1;
        let pc2 = commit_ristretto_encodings(&c2);
        assert!(!paired_verify(&pd, &pc2, &pr_m));
    }

    #[test]
    fn leaf_rerand_binds_c_tilde() {
        let d = kids(1);
        let mut c = [[0u8; 32]; ARITY];
        let mut pts = Vec::new();
        for i in 0..ARITY {
            let r = rs_rand();
            let p = curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT
                * RScalar::from((i as u64) + 1)
                + ristretto_h_note() * r;
            pts.push(p);
            c[i] = p.compress().to_bytes();
        }
        let t = rs_rand();
        let ct = pts[6] + ristretto_h_note() * t;
        let td = vs_rand();
        let pr = leaf_prove(&d, &c, 6, &td, &t, &ct).expect("leaf");
        let pd = commit_vesta(&d);
        assert!(leaf_verify(&pd, &c, &ct, &pr));
        let fake = ct + ristretto_h_note() * rs_rand();
        assert!(!leaf_verify(&pd, &c, &fake, &pr));
        let mut c2 = c;
        c2.swap(6, 7);
        assert!(!leaf_verify(&pd, &c2, &ct, &pr));
        assert!(!pr.windows(32).any(|w| w == &d[6]));
    }
}
