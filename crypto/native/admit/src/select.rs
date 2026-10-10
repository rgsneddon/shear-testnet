//! D-ary CDS select-and-rerandomize. No slot index on the wire.
//!
//! Parent `P = r U + Σ x_j G_j` (Pedersen VC). Selected `Q = x_i G_sel + t U`.
//! `W = Σ_{j≠i} x_j G_j` is the other-slot remainder (hiding).
//! Dest (Vesta) and C (ristretto) share one wrap-around so mixed indices fail.
//! C-tree leaves are ristretto C; C̃ = C_i + t H is a 1-of-D at the leaf.
//! Dest admitPub P_i is 1-of-D as p_com = P_i + w U at the same slot.

use crate::leaf::{dest_leaf_fp, sha512_64};
use crate::tree::{
    commit_ristretto_encodings, commit_vesta, ristretto_gens, ristretto_gsel, ristretto_h_note,
    vesta_gens, vesta_gsel, vesta_mul_g, vesta_mul_gsel, vesta_mul_u, vesta_x, VestaVar, ARITY,
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
pub const LEAF_PAIRED_LEN: usize = 32 * 2 + 64 + ARITY * 32 * 5; // Wd Qd hv0 + dest z*3 + c z_t + p z_w
/// W' Q Wc' Kc Kp | A_d zrd A_c zrc | zxd[32] zyc[32] | seed | 9 responses × 32.
/// 9 = dest (x, r, t) + C (y, r) + slot link (dest, C) + note (t, w).
pub const LEAF_V3_LEN: usize = 32 * 5 + 32 * 4 + ARITY * 32 * 2 + 64 + ARITY * 32 * 9;

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
    ctx: &[u8],
) -> [u8; 64] {
    // An empty ctx is the v2 transcript. Do not absorb a prefix.
    if ctx.is_empty() {
        sha512_64(&[rpd, rqd, rpc, rqc, pd, wd, qd, pc, wc, qc, b"cds-pair"])
    } else {
        sha512_64(&[ctx, rpd, rqd, rpc, rqc, pd, wd, qd, pc, wc, qc, b"cds-pair"])
    }
}

/// Dest + C CDS with one wrap-around. Same hidden slot for both trees.
pub fn paired_prove(
    dest_ch: &[[u8; 32]; ARITY],
    c_ch: &[[u8; 32]; ARITY],
    index: usize,
    t_d: &vesta::Scalar,
    t_c: &RScalar,
    ctx: &[u8],
) -> Option<Vec<u8>> {
    if index >= ARITY {
        return None;
    }
    let xd = vesta_x(&dest_ch[index]);
    let xc = rsc(&c_ch[index]);
    if bool::from(xd.is_zero()) || xc == RScalar::ZERO {
        return None;
    }
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
        wd += vesta_mul_g(k, &vesta_x(&dest_ch[k]));
        wc += gc[k] * rsc(&c_ch[k]);
    }
    let qd = vesta_mul_gsel(&xd) + vesta_mul_u(t_d);
    let qc = gselc * xc + uc * t_c;
    let pwd = pd - wd;
    let pwc = pc - wc;
    let pwd_t = VestaVar::new(pwd);
    let qd_t = VestaVar::new(qd);
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
    let rpd_i = vesta_mul_u(&krd) + vesta_mul_g(index, &kxd);
    let rqd_i = vesta_mul_gsel(&kxd) + vesta_mul_u(&ktd);
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
        ctx,
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
        let rpd = vesta_mul_u(&b) + vesta_mul_g(j, &a) - pwd_t.mul(&ed);
        let rqd = vesta_mul_gsel(&a) + vesta_mul_u(&c) - qd_t.mul(&ed);
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
            ctx,
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
        ctx,
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
        let rpd = vesta_mul_u(&b) + vesta_mul_g(jj, &a) - pwd_t.mul(&e0d);
        let rqd = vesta_mul_gsel(&a) + vesta_mul_u(&c) - qd_t.mul(&e0d);
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
            ctx,
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

pub fn paired_verify(dest_parent: &[u8; 32], c_parent: &[u8; 32], proof: &[u8], ctx: &[u8]) -> bool {
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
    let (uc, gc, _) = ristretto_gens();
    let gselc = ristretto_gsel();
    let pwd = pd - wd;
    let pwc = pc - wc;
    let pwd_t = VestaVar::new(pwd);
    let qd_t = VestaVar::new(qd);
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
        let rpd = vesta_mul_u(&b) + vesta_mul_g(j, &a) - pwd_t.mul(&ed);
        let rqd = vesta_mul_gsel(&a) + vesta_mul_u(&c) - qd_t.mul(&ed);
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
            ctx,
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
    rp: &[u8; 32],
    pd: &[u8; 32],
    wd: &[u8; 32],
    qd: &[u8; 32],
    ct: &[u8; 32],
    pcom: &[u8; 32],
    siblings_c: &[u8],
    siblings_p: &[u8],
    ctx: &[u8],
) -> [u8; 64] {
    if ctx.is_empty() {
        sha512_64(&[
            rpd,
            rqd,
            rc,
            rp,
            pd,
            wd,
            qd,
            ct,
            pcom,
            siblings_c,
            siblings_p,
            b"cds-leaf",
        ])
    } else {
        sha512_64(&[
            ctx,
            rpd,
            rqd,
            rc,
            rp,
            pd,
            wd,
            qd,
            ct,
            pcom,
            siblings_c,
            siblings_p,
            b"cds-leaf",
        ])
    }
}

/// Leaf: dest CDS + C̃ = C_j + t H + P̃ = P_j + w U, same hidden slot.
/// `c_ch` are compressed C; `p_ch` are compressed dest P (admitPub).
pub fn leaf_prove(
    dest_ch: &[[u8; 32]; ARITY],
    c_ch: &[[u8; 32]; ARITY],
    p_ch: &[[u8; 32]; ARITY],
    index: usize,
    t_d: &vesta::Scalar,
    t_note: &RScalar,
    w_p: &RScalar,
    c_tilde: &RistrettoPoint,
    p_com: &RistrettoPoint,
    ctx: &[u8],
) -> Option<Vec<u8>> {
    if index >= ARITY {
        return None;
    }
    let xd = vesta_x(&dest_ch[index]);
    if bool::from(xd.is_zero()) {
        return None;
    }
    let ci = dec_r(&c_ch[index])?;
    let pj = dec_r(&p_ch[index])?;
    if bool::from(pj.is_identity()) {
        return None;
    }
    let h = ristretto_h_note();
    let (u_r, _, _) = ristretto_gens();
    if *c_tilde != ci + h * t_note {
        return None;
    }
    if *p_com != pj + *u_r * w_p {
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
    let pcom_b = enc_r(p_com);
    let mut sib_c = Vec::with_capacity(ARITY * 32);
    let mut sib_p = Vec::with_capacity(ARITY * 32);
    for c in c_ch {
        sib_c.extend_from_slice(c);
    }
    for p in p_ch {
        sib_p.extend_from_slice(p);
    }

    let mut zxd = [[0u8; 32]; ARITY];
    let mut zrd = [[0u8; 32]; ARITY];
    let mut ztd = [[0u8; 32]; ARITY];
    let mut zct = [[0u8; 32]; ARITY];
    let mut zpt = [[0u8; 32]; ARITY];
    let kxd = vs_rand();
    let krd = vs_rand();
    let ktd = vs_rand();
    let kct = rs_rand();
    let kpt = rs_rand();
    let rpd_i = *ud * krd + gd[index] * kxd;
    let rqd_i = gseld * kxd + *ud * ktd;
    let rc_i = h * kct;
    let rp_i = *u_r * kpt;
    let hv = leaf_chal(
        &enc_v(&rpd_i),
        &enc_v(&rqd_i),
        &enc_r(&rc_i),
        &enc_r(&rp_i),
        &pd_b,
        &wd_b,
        &qd_b,
        &ct_b,
        &pcom_b,
        &sib_c,
        &sib_p,
        ctx,
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
        zxd[j] = a.to_repr().into();
        zrd[j] = b.to_repr().into();
        ztd[j] = c.to_repr().into();
        zct[j] = d.to_bytes();
        zpt[j] = e.to_bytes();
        let cj = dec_r(&c_ch[j]).unwrap_or_else(RistrettoPoint::identity);
        let ppj = dec_r(&p_ch[j]).unwrap_or_else(RistrettoPoint::identity);
        let rpd = *ud * b + gd[j] * a - pwd * ed;
        let rqd = gseld * a + *ud * c - qd * ed;
        let rc = h * d - (*c_tilde - cj) * ec;
        let rp = *u_r * e - (*p_com - ppj) * ec;
        let hv = leaf_chal(
            &enc_v(&rpd),
            &enc_v(&rqd),
            &enc_r(&rc),
            &enc_r(&rp),
            &pd_b,
            &wd_b,
            &qd_b,
            &ct_b,
            &pcom_b,
            &sib_c,
            &sib_p,
            ctx,
        );
        ed = vesta::Scalar::from_uniform_bytes(&hv);
        ec = RScalar::from_bytes_mod_order_wide(&hv);
        j = (j + 1) % ARITY;
    }
    zxd[index] = (kxd + ed * xd).to_repr().into();
    zrd[index] = (krd + ed * rd).to_repr().into();
    ztd[index] = (ktd + ed * *t_d).to_repr().into();
    zct[index] = (kct + ec * *t_note).to_bytes();
    zpt[index] = (kpt + ec * *w_p).to_bytes();

    let mut seed0 = leaf_chal(
        &enc_v(&rpd_i),
        &enc_v(&rqd_i),
        &enc_r(&rc_i),
        &enc_r(&rp_i),
        &pd_b,
        &wd_b,
        &qd_b,
        &ct_b,
        &pcom_b,
        &sib_c,
        &sib_p,
        ctx,
    );
    let mut e0d = vesta::Scalar::from_uniform_bytes(&seed0);
    let mut e0c = RScalar::from_bytes_mod_order_wide(&seed0);
    let mut jj = (index + 1) % ARITY;
    while jj != 0 {
        let a = vs(&zxd[jj]);
        let b = vs(&zrd[jj]);
        let c = vs(&ztd[jj]);
        let d = rsc(&zct[jj]);
        let e = rsc(&zpt[jj]);
        let cj = dec_r(&c_ch[jj]).unwrap_or_else(RistrettoPoint::identity);
        let ppj = dec_r(&p_ch[jj]).unwrap_or_else(RistrettoPoint::identity);
        let rpd = *ud * b + gd[jj] * a - pwd * e0d;
        let rqd = gseld * a + *ud * c - qd * e0d;
        let rc = h * d - (*c_tilde - cj) * e0c;
        let rp = *u_r * e - (*p_com - ppj) * e0c;
        seed0 = leaf_chal(
            &enc_v(&rpd),
            &enc_v(&rqd),
            &enc_r(&rc),
            &enc_r(&rp),
            &pd_b,
            &wd_b,
            &qd_b,
            &ct_b,
            &pcom_b,
            &sib_c,
            &sib_p,
            ctx,
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
        out.extend_from_slice(&zpt[j]);
    }
    Some(out)
}

pub fn leaf_qd(proof: &[u8]) -> Option<[u8; 32]> {
    if proof.len() != LEAF_PAIRED_LEN && proof.len() != LEAF_V3_LEN {
        return None;
    }
    proof.get(32..64)?.try_into().ok()
}

pub fn leaf_verify(
    dest_parent: &[u8; 32],
    c_ch: &[[u8; 32]; ARITY],
    p_ch: &[[u8; 32]; ARITY],
    c_tilde: &RistrettoPoint,
    p_com: &RistrettoPoint,
    proof: &[u8],
    ctx: &[u8],
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
    if bool::from(qd.is_identity()) || c_tilde.is_identity() || p_com.is_identity() {
        return false;
    }
    let h = ristretto_h_note();
    let (u_r, _, _) = ristretto_gens();
    let pwd = pd - wd;
    let pwd_t = VestaVar::new(pwd);
    let qd_t = VestaVar::new(qd);
    let ct_b = enc_r(c_tilde);
    let pcom_b = enc_r(p_com);
    let mut sib_c = Vec::with_capacity(ARITY * 32);
    let mut sib_p = Vec::with_capacity(ARITY * 32);
    for c in c_ch {
        sib_c.extend_from_slice(c);
    }
    for p in p_ch {
        sib_p.extend_from_slice(p);
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
        let e = rsc(&match take32(proof, off + 128) {
            Some(x) => x,
            None => return false,
        });
        off += 160;
        let cj = dec_r(&c_ch[j]).unwrap_or_else(RistrettoPoint::identity);
        let ppj = dec_r(&p_ch[j]).unwrap_or_else(RistrettoPoint::identity);
        let rpd = vesta_mul_u(&b) + vesta_mul_g(j, &a) - pwd_t.mul(&ed);
        let rqd = vesta_mul_gsel(&a) + vesta_mul_u(&c) - qd_t.mul(&ed);
        let rc = h * d - (*c_tilde - cj) * ec;
        let rp = *u_r * e - (*p_com - ppj) * ec;
        let hv = leaf_chal(
            &enc_v(&rpd),
            &enc_v(&rqd),
            &enc_r(&rc),
            &enc_r(&rp),
            dest_parent,
            &wd_b,
            &qd_b,
            &ct_b,
            &pcom_b,
            &sib_c,
            &sib_p,
            ctx,
        );
        last = hv;
        ed = vesta::Scalar::from_uniform_bytes(&hv);
        ec = RScalar::from_bytes_mod_order_wide(&hv);
    }
    last == hv0
}

const V3_ZXD: usize = 224;
const V3_AC: usize = V3_ZXD + ARITY * 32;
const V3_ZRC: usize = V3_AC + 32;
const V3_ZYC: usize = V3_ZRC + 32;
const V3_SEED: usize = V3_ZYC + ARITY * 32;
const V3_RESP: usize = V3_SEED + 64;
const V3_STRIDE: usize = 32 * 9;

#[derive(Clone, Copy, PartialEq, Eq)]
struct OrAnn {
    rpd: [u8; 32],
    rqd: [u8; 32],
    rpc: [u8; 32],
    rc: [u8; 32],
    rp: [u8; 32],
    asd: [u8; 32],
    asc: [u8; 32],
}

fn v3_chal(
    ctx: &[u8],
    ann: &OrAnn,
    dest_parent: &[u8; 32],
    c_parent: &[u8; 32],
    wp: &[u8; 32],
    q: &[u8; 32],
    wc: &[u8; 32],
    kc: &[u8; 32],
    kp: &[u8; 32],
    ct: &[u8; 32],
    pcom: &[u8; 32],
    e1: &[u8; 64],
    zv: &[u8; 64],
) -> [u8; 64] {
    sha512_64(&[
        ctx,
        &ann.rpd,
        &ann.rqd,
        &ann.rpc,
        &ann.rc,
        &ann.rp,
        &ann.asd,
        &ann.asc,
        dest_parent,
        c_parent,
        wp,
        q,
        wc,
        kc,
        kp,
        ct,
        pcom,
        e1,
        zv,
        b"admit-v3-leaf",
    ])
}

fn v3_e1(
    ctx: &[u8],
    dest_parent: &[u8; 32],
    c_parent: &[u8; 32],
    ct: &[u8; 32],
    pcom: &[u8; 32],
    wp: &[u8; 32],
    q: &[u8; 32],
    wc: &[u8; 32],
    kc: &[u8; 32],
    kp: &[u8; 32],
    ad: &[u8; 32],
    ac: &[u8; 32],
) -> [u8; 64] {
    sha512_64(&[
        ctx,
        dest_parent,
        c_parent,
        ct,
        pcom,
        wp,
        q,
        wc,
        kc,
        kp,
        ad,
        ac,
        b"admit-v3-leaf",
    ])
}

fn v3_zdigest(
    zrd: &[u8; 32],
    zxd: &[[u8; 32]; ARITY],
    zrc: &[u8; 32],
    zyc: &[[u8; 32]; ARITY],
) -> [u8; 64] {
    let mut parts: Vec<&[u8]> = Vec::with_capacity(2 + ARITY * 2);
    parts.push(zrd);
    parts.push(zrc);
    for z in zxd {
        parts.push(z);
    }
    for z in zyc {
        parts.push(z);
    }
    sha512_64(&parts)
}

struct V3Open<'a> {
    pwd: VestaVar,
    q: VestaVar,
    pc: RistrettoPoint,
    wc: RistrettoPoint,
    ct: RistrettoPoint,
    kc: RistrettoPoint,
    pcom: RistrettoPoint,
    kp: RistrettoPoint,
    e1d: vesta::Scalar,
    e1c: RScalar,
    zxd: &'a [vesta::Scalar; ARITY],
    zyc: &'a [RScalar; ARITY],
}

fn v3_ann_eval(j: usize, eh: &[u8; 64], o: &V3Open<'_>, zx: &vesta::Scalar, zr: &vesta::Scalar, zt: &vesta::Scalar, zy: &RScalar, zrc: &RScalar, zsd: &vesta::Scalar, zsc: &RScalar, zct: &RScalar, zpt: &RScalar) -> OrAnn {
    let ed = vesta::Scalar::from_uniform_bytes(eh);
    let ec = RScalar::from_bytes_mod_order_wide(eh);
    let (uc, gc, h) = ristretto_gens();
    let rpd = vesta_mul_u(zr) + vesta_mul_g(j, zx) - o.pwd.mul(&ed);
    let rqd = vesta_mul_gsel(zx) + vesta_mul_u(zt) - o.q.mul(&ed);
    let rpc = *uc * zrc + gc[j] * zy - (o.pc - o.wc) * ec;
    let rc = *h * zct - (o.ct - o.kc) * ec;
    let rp = *uc * zpt - (o.pcom - o.kp) * ec;
    let asd = *zsd + o.e1d * zx - ed * o.zxd[j];
    let asc = *zsc + o.e1c * zy - ec * o.zyc[j];
    OrAnn {
        rpd: enc_v(&rpd),
        rqd: enc_v(&rqd),
        rpc: enc_r(&rpc),
        rc: enc_r(&rc),
        rp: enc_r(&rp),
        asd: asd.to_repr().into(),
        asc: asc.to_bytes(),
    }
}

fn v3_ann_open(j: usize, o: &V3Open<'_>, kx: &vesta::Scalar, kr: &vesta::Scalar, kt: &vesta::Scalar, ky: &RScalar, krc: &RScalar, ksd: &vesta::Scalar, ksc: &RScalar, kct: &RScalar, kpt: &RScalar) -> OrAnn {
    let (uc, gc, h) = ristretto_gens();
    let rpd = vesta_mul_u(kr) + vesta_mul_g(j, kx);
    let rqd = vesta_mul_gsel(kx) + vesta_mul_u(kt);
    let rpc = *uc * krc + gc[j] * ky;
    let rc = *h * kct;
    let rp = *uc * kpt;
    let asd = *ksd + o.e1d * kx;
    let asc = *ksc + o.e1c * ky;
    OrAnn {
        rpd: enc_v(&rpd),
        rqd: enc_v(&rqd),
        rpc: enc_r(&rpc),
        rc: enc_r(&rc),
        rp: enc_r(&rp),
        asd: asd.to_repr().into(),
        asc: asc.to_bytes(),
    }
}

fn read_z_bytes(proof: &[u8], off: usize) -> Option<[[u8; 32]; ARITY]> {
    let mut o = [[0u8; 32]; ARITY];
    for i in 0..ARITY {
        o[i] = take32(proof, off + i * 32)?;
    }
    Some(o)
}

/// v3 leaf. Children stay witnesses. The blob is a blinded generator CDS:
/// `W' = W + r_w U`, with `r_w` absorbed into the dest r-response, plus the
/// same hidden slot on the C parent, the note rerandomizations, and the
/// opening of both parents. Domain is `admit-v3-leaf`.
pub fn leaf_prove_v3(
    dest_ch: &[[u8; 32]; ARITY],
    c_ch: &[[u8; 32]; ARITY],
    p_ch: &[[u8; 32]; ARITY],
    index: usize,
    t_d: &vesta::Scalar,
    t_note: &RScalar,
    w_p: &RScalar,
    c_tilde: &RistrettoPoint,
    p_com: &RistrettoPoint,
    ctx: &[u8],
) -> Option<Vec<u8>> {
    if index >= ARITY || *t_note == RScalar::ZERO {
        return None;
    }
    if dest_ch[index] != dest_leaf_fp(&p_ch[index]) {
        return None;
    }
    let x = vesta_x(&dest_ch[index]);
    if bool::from(x.is_zero()) {
        return None;
    }
    let ci = dec_r(&c_ch[index])?;
    let pi = dec_r(&p_ch[index])?;
    if bool::from(pi.is_identity()) {
        return None;
    }
    let h = ristretto_h_note();
    let (u_r, gc, _) = ristretto_gens();
    if *c_tilde != ci + h * t_note || *p_com != pi + *u_r * w_p {
        return None;
    }
    let y = rsc(&c_ch[index]);
    if y == RScalar::ZERO {
        return None;
    }
    let pd_b = commit_vesta(dest_ch);
    let pc_b = commit_ristretto_encodings(c_ch);
    let pd = dec_v(&pd_b)?;
    let pc = dec_r(&pc_b)?;
    let rd = crate::tree::blind_fp(dest_ch);
    let rc_full = {
        let mut parts: Vec<&[u8]> = vec![b"shear-ct-c-blind"];
        for c in c_ch {
            parts.push(c.as_ref());
        }
        RScalar::from_bytes_mod_order_wide(&sha512_64(&parts))
    };
    let mut xs = [vesta::Scalar::ZERO; ARITY];
    let mut ys = [RScalar::ZERO; ARITY];
    let mut wd = vesta::Point::identity();
    let mut wc = RistrettoPoint::identity();
    for k in 0..ARITY {
        xs[k] = vesta_x(&dest_ch[k]);
        ys[k] = rsc(&c_ch[k]);
        if k == index {
            continue;
        }
        wd += vesta_mul_g(k, &xs[k]);
        wc += gc[k] * ys[k];
    }
    let r_w = vs_rand();
    let r_wc = rs_rand();
    let wp = wd + vesta_mul_u(&r_w);
    let wcp = wc + *u_r * r_wc;
    let qd = vesta_mul_gsel(&x) + vesta_mul_u(t_d);
    let rho_c = rs_rand();
    let rho_p = rs_rand();
    let kc = ci + h * rho_c;
    let kp = pi + *u_r * rho_p;
    let delta_c = *t_note - rho_c;
    let delta_p = *w_p - rho_p;
    let rd_eff = rd - r_w;
    let rc_eff = rc_full - r_wc;
    let wp_b = enc_v(&wp);
    let q_b = enc_v(&qd);
    let wc_b = enc_r(&wcp);
    let kc_b = enc_r(&kc);
    let kp_b = enc_r(&kp);
    let ct_b = enc_r(c_tilde);
    let pcom_b = enc_r(p_com);

    let s_rd = vs_rand();
    let mut s_xd = [vesta::Scalar::ZERO; ARITY];
    let mut ad = vesta_mul_u(&s_rd);
    for k in 0..ARITY {
        s_xd[k] = vs_rand();
        ad += vesta_mul_g(k, &s_xd[k]);
    }
    let s_rc = rs_rand();
    let mut s_yc = [RScalar::ZERO; ARITY];
    let mut ac = *u_r * s_rc;
    for k in 0..ARITY {
        s_yc[k] = rs_rand();
        ac += gc[k] * s_yc[k];
    }
    let ad_b = enc_v(&ad);
    let ac_b = enc_r(&ac);
    let e1 = v3_e1(ctx, &pd_b, &pc_b, &ct_b, &pcom_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ad_b, &ac_b);
    let e1d = vesta::Scalar::from_uniform_bytes(&e1);
    let e1c = RScalar::from_bytes_mod_order_wide(&e1);
    let zrd = s_rd + e1d * rd;
    let zrc = s_rc + e1c * rc_full;
    let mut zxd = [vesta::Scalar::ZERO; ARITY];
    let mut zyc = [RScalar::ZERO; ARITY];
    let mut zxd_b = [[0u8; 32]; ARITY];
    let mut zyc_b = [[0u8; 32]; ARITY];
    for k in 0..ARITY {
        zxd[k] = s_xd[k] + e1d * xs[k];
        zyc[k] = s_yc[k] + e1c * ys[k];
        zxd_b[k] = zxd[k].to_repr().into();
        zyc_b[k] = zyc[k].to_bytes();
    }
    let zrd_b: [u8; 32] = zrd.to_repr().into();
    let zrc_b = zrc.to_bytes();
    let zv = v3_zdigest(&zrd_b, &zxd_b, &zrc_b, &zyc_b);
    let open = V3Open {
        pwd: VestaVar::new(pd - wp),
        q: VestaVar::new(qd),
        pc,
        wc: wcp,
        ct: *c_tilde,
        kc,
        pcom: *p_com,
        kp,
        e1d,
        e1c,
        zxd: &zxd,
        zyc: &zyc,
    };
    let kx = vs_rand();
    let kr = vs_rand();
    let kt = vs_rand();
    let ky = rs_rand();
    let krc = rs_rand();
    let ksd = vs_rand();
    let ksc = rs_rand();
    let kct = rs_rand();
    let kpt = rs_rand();
    let open_ann = v3_ann_open(index, &open, &kx, &kr, &kt, &ky, &krc, &ksd, &ksc, &kct, &kpt);
    let mut zx_b = [[0u8; 32]; ARITY];
    let mut zr_b = [[0u8; 32]; ARITY];
    let mut zt_b = [[0u8; 32]; ARITY];
    let mut zy_b = [[0u8; 32]; ARITY];
    let mut zrc_s = [[0u8; 32]; ARITY];
    let mut zsd_b = [[0u8; 32]; ARITY];
    let mut zsc_b = [[0u8; 32]; ARITY];
    let mut zct_b = [[0u8; 32]; ARITY];
    let mut zpt_b = [[0u8; 32]; ARITY];
    let mut hv = v3_chal(ctx, &open_ann, &pd_b, &pc_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &e1, &zv);
    let mut j = (index + 1) % ARITY;
    while j != index {
        let a = vs_rand();
        let b = vs_rand();
        let c = vs_rand();
        let d = rs_rand();
        let e = rs_rand();
        let f = vs_rand();
        let g = rs_rand();
        let hc = rs_rand();
        let hp = rs_rand();
        zx_b[j] = a.to_repr().into();
        zr_b[j] = b.to_repr().into();
        zt_b[j] = c.to_repr().into();
        zy_b[j] = d.to_bytes();
        zrc_s[j] = e.to_bytes();
        zsd_b[j] = f.to_repr().into();
        zsc_b[j] = g.to_bytes();
        zct_b[j] = hc.to_bytes();
        zpt_b[j] = hp.to_bytes();
        let ann = v3_ann_eval(j, &hv, &open, &a, &b, &c, &d, &e, &f, &g, &hc, &hp);
        hv = v3_chal(ctx, &ann, &pd_b, &pc_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &e1, &zv);
        j = (j + 1) % ARITY;
    }
    let ed = vesta::Scalar::from_uniform_bytes(&hv);
    let ec = RScalar::from_bytes_mod_order_wide(&hv);
    let zx_i = kx + ed * x;
    let zr_i = kr + ed * rd_eff;
    let zt_i = kt + ed * *t_d;
    let zy_i = ky + ec * y;
    let zrc_i = krc + ec * rc_eff;
    let zsd_i = ksd + ed * s_xd[index];
    let zsc_i = ksc + ec * s_yc[index];
    let zct_i = kct + ec * delta_c;
    let zpt_i = kpt + ec * delta_p;
    let back = v3_ann_eval(index, &hv, &open, &zx_i, &zr_i, &zt_i, &zy_i, &zrc_i, &zsd_i, &zsc_i, &zct_i, &zpt_i);
    if back != open_ann {
        return None;
    }
    zx_b[index] = zx_i.to_repr().into();
    zr_b[index] = zr_i.to_repr().into();
    zt_b[index] = zt_i.to_repr().into();
    zy_b[index] = zy_i.to_bytes();
    zrc_s[index] = zrc_i.to_bytes();
    zsd_b[index] = zsd_i.to_repr().into();
    zsc_b[index] = zsc_i.to_bytes();
    zct_b[index] = zct_i.to_bytes();
    zpt_b[index] = zpt_i.to_bytes();

    let mut seed0 = v3_chal(ctx, &open_ann, &pd_b, &pc_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &e1, &zv);
    let mut jj = (index + 1) % ARITY;
    while jj != 0 {
        let ann = v3_ann_eval(
            jj,
            &seed0,
            &open,
            &vs(&zx_b[jj]),
            &vs(&zr_b[jj]),
            &vs(&zt_b[jj]),
            &rsc(&zy_b[jj]),
            &rsc(&zrc_s[jj]),
            &vs(&zsd_b[jj]),
            &rsc(&zsc_b[jj]),
            &rsc(&zct_b[jj]),
            &rsc(&zpt_b[jj]),
        );
        seed0 = v3_chal(ctx, &ann, &pd_b, &pc_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &e1, &zv);
        jj = (jj + 1) % ARITY;
    }
    let mut out = Vec::with_capacity(LEAF_V3_LEN);
    out.extend_from_slice(&wp_b);
    out.extend_from_slice(&q_b);
    out.extend_from_slice(&wc_b);
    out.extend_from_slice(&kc_b);
    out.extend_from_slice(&kp_b);
    out.extend_from_slice(&ad_b);
    out.extend_from_slice(&zrd_b);
    for z in &zxd_b {
        out.extend_from_slice(z);
    }
    out.extend_from_slice(&ac_b);
    out.extend_from_slice(&zrc_b);
    for z in &zyc_b {
        out.extend_from_slice(z);
    }
    out.extend_from_slice(&seed0);
    for j in 0..ARITY {
        out.extend_from_slice(&zx_b[j]);
        out.extend_from_slice(&zr_b[j]);
        out.extend_from_slice(&zt_b[j]);
        out.extend_from_slice(&zy_b[j]);
        out.extend_from_slice(&zrc_s[j]);
        out.extend_from_slice(&zsd_b[j]);
        out.extend_from_slice(&zsc_b[j]);
        out.extend_from_slice(&zct_b[j]);
        out.extend_from_slice(&zpt_b[j]);
    }
    if out.len() != LEAF_V3_LEN {
        return None;
    }
    Some(out)
}

pub fn leaf_verify_v3(
    dest_parent: &[u8; 32],
    c_parent: &[u8; 32],
    c_tilde: &RistrettoPoint,
    p_com: &RistrettoPoint,
    proof: &[u8],
    ctx: &[u8],
) -> bool {
    if proof.len() != LEAF_V3_LEN {
        return false;
    }
    let wp_b = match take32(proof, 0) {
        Some(x) => x,
        None => return false,
    };
    let q_b = match take32(proof, 32) {
        Some(x) => x,
        None => return false,
    };
    let wc_b = match take32(proof, 64) {
        Some(x) => x,
        None => return false,
    };
    let kc_b = match take32(proof, 96) {
        Some(x) => x,
        None => return false,
    };
    let kp_b = match take32(proof, 128) {
        Some(x) => x,
        None => return false,
    };
    let ad_b = match take32(proof, 160) {
        Some(x) => x,
        None => return false,
    };
    let zrd_b = match take32(proof, 192) {
        Some(x) => x,
        None => return false,
    };
    let zxd_b = match read_z_bytes(proof, V3_ZXD) {
        Some(x) => x,
        None => return false,
    };
    let ac_b = match take32(proof, V3_AC) {
        Some(x) => x,
        None => return false,
    };
    let zrc_b = match take32(proof, V3_ZRC) {
        Some(x) => x,
        None => return false,
    };
    let zyc_b = match read_z_bytes(proof, V3_ZYC) {
        Some(x) => x,
        None => return false,
    };
    let seed = match proof.get(V3_SEED..V3_SEED + 64).and_then(|s| s.try_into().ok()) {
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
    let wp = match dec_v(&wp_b) {
        Some(x) => x,
        None => return false,
    };
    let qd = match dec_v(&q_b) {
        Some(x) => x,
        None => return false,
    };
    let wcp = match dec_r(&wc_b) {
        Some(x) => x,
        None => return false,
    };
    let kc = match dec_r(&kc_b) {
        Some(x) => x,
        None => return false,
    };
    let kp = match dec_r(&kp_b) {
        Some(x) => x,
        None => return false,
    };
    let ad = match dec_v(&ad_b) {
        Some(x) => x,
        None => return false,
    };
    let ac = match dec_r(&ac_b) {
        Some(x) => x,
        None => return false,
    };
    if bool::from(qd.is_identity()) || c_tilde.is_identity() || p_com.is_identity() || kc.is_identity() || kp.is_identity() {
        return false;
    }
    let ct_b = enc_r(c_tilde);
    let pcom_b = enc_r(p_com);
    let e1 = v3_e1(ctx, dest_parent, c_parent, &ct_b, &pcom_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ad_b, &ac_b);
    let e1d = vesta::Scalar::from_uniform_bytes(&e1);
    let e1c = RScalar::from_bytes_mod_order_wide(&e1);
    let (uc, gc, _) = ristretto_gens();
    let mut lhs_d = vesta_mul_u(&vs(&zrd_b));
    let mut zxd = [vesta::Scalar::ZERO; ARITY];
    for k in 0..ARITY {
        zxd[k] = vs(&zxd_b[k]);
        lhs_d += vesta_mul_g(k, &zxd[k]);
    }
    let pd_e = VestaVar::new(pd);
    if lhs_d != ad + pd_e.mul(&e1d) {
        return false;
    }
    let mut lhs_c = *uc * rsc(&zrc_b);
    let mut zyc = [RScalar::ZERO; ARITY];
    for k in 0..ARITY {
        zyc[k] = rsc(&zyc_b[k]);
        lhs_c += gc[k] * zyc[k];
    }
    if lhs_c != ac + pc * e1c {
        return false;
    }
    let zv = v3_zdigest(&zrd_b, &zxd_b, &zrc_b, &zyc_b);
    let open = V3Open {
        pwd: VestaVar::new(pd - wp),
        q: VestaVar::new(qd),
        pc,
        wc: wcp,
        ct: *c_tilde,
        kc,
        pcom: *p_com,
        kp,
        e1d,
        e1c,
        zxd: &zxd,
        zyc: &zyc,
    };
    let mut hv = seed;
    let mut last = seed;
    if proof.len() < V3_RESP + ARITY * V3_STRIDE {
        return false;
    }
    for j in 0..ARITY {
        let off = V3_RESP + j * V3_STRIDE;
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
        let zy = rsc(&match take32(proof, off + 96) {
            Some(x) => x,
            None => return false,
        });
        let zrc = rsc(&match take32(proof, off + 128) {
            Some(x) => x,
            None => return false,
        });
        let zsd = vs(&match take32(proof, off + 160) {
            Some(x) => x,
            None => return false,
        });
        let zsc = rsc(&match take32(proof, off + 192) {
            Some(x) => x,
            None => return false,
        });
        let zct = rsc(&match take32(proof, off + 224) {
            Some(x) => x,
            None => return false,
        });
        let zpt = rsc(&match take32(proof, off + 256) {
            Some(x) => x,
            None => return false,
        });
        let ann = v3_ann_eval(j, &hv, &open, &zx, &zr, &zt, &zy, &zrc, &zsd, &zsc, &zct, &zpt);
        last = v3_chal(ctx, &ann, dest_parent, c_parent, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &e1, &zv);
        hv = last;
    }
    last == seed
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
        let pr = paired_prove(&d, &c, 4, &td, &tc, &[]).expect("pair");
        assert_eq!(pr.len(), PAIRED_LEN);
        let pd = commit_vesta(&d);
        let pc = commit_ristretto_encodings(&c);
        assert!(paired_verify(&pd, &pc, &pr, &[]));
        assert!(!paired_verify(&pc, &pd, &pr, &[]));
        let pr_m = paired_prove(&d, &c, 4, &td, &tc, &[]).expect("p2");
        // swapping C parent (mixed trees) fails
        let mut c2 = c;
        c2[0][0] ^= 1;
        let pc2 = commit_ristretto_encodings(&c2);
        assert!(!paired_verify(&pd, &pc2, &pr_m, &[]));
    }

    #[test]
    fn leaf_rerand_binds_c_tilde() {
        let d = kids(1);
        let mut c = [[0u8; 32]; ARITY];
        let mut p_ch = [[0u8; 32]; ARITY];
        let mut pts = Vec::new();
        let mut dest_p = Vec::new();
        let g = curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
        let (u, _, _) = ristretto_gens();
        for i in 0..ARITY {
            let r = rs_rand();
            let p = g * RScalar::from((i as u64) + 1) + ristretto_h_note() * r;
            pts.push(p);
            c[i] = p.compress().to_bytes();
            let dp = g * RScalar::from((i as u64) + 7);
            dest_p.push(dp);
            p_ch[i] = dp.compress().to_bytes();
        }
        let t = rs_rand();
        let w = rs_rand();
        let ct = pts[6] + ristretto_h_note() * t;
        let pcom = dest_p[6] + u * w;
        let td = vs_rand();
        let pr = leaf_prove(&d, &c, &p_ch, 6, &td, &t, &w, &ct, &pcom, &[]).expect("leaf");
        let pd = commit_vesta(&d);
        assert!(leaf_verify(&pd, &c, &p_ch, &ct, &pcom, &pr, &[]));
        let fake = ct + ristretto_h_note() * rs_rand();
        assert!(!leaf_verify(&pd, &c, &p_ch, &fake, &pcom, &pr, &[]));
        let fake_p = pcom + u * rs_rand();
        assert!(!leaf_verify(&pd, &c, &p_ch, &ct, &fake_p, &pr, &[]));
        let mut c2 = c;
        c2.swap(6, 7);
        assert!(!leaf_verify(&pd, &c2, &p_ch, &ct, &pcom, &pr, &[]));
        assert!(!pr.windows(32).any(|w| w == &d[6]));
        assert!(
            leaf_prove(&d, &c, &p_ch, 6, &td, &t, &w, &ct, &(dest_p[0] + u * w), &[]).is_none(),
            "p_com must be the selected dest P"
        );
    }

    #[test]
    fn leaf_rerand_v3_blinds_remainder_and_rejects_v2() {
        use group::Group;
        let g = curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
        let (u, _, _) = ristretto_gens();
        let mut c = [[0u8; 32]; ARITY];
        let mut p_ch = [[0u8; 32]; ARITY];
        let mut d = [[0u8; 32]; ARITY];
        let mut pts = Vec::new();
        let mut dest_p = Vec::new();
        for i in 0..ARITY {
            let r = rs_rand();
            let cp = g * RScalar::from((i as u64) + 1) + ristretto_h_note() * r;
            pts.push(cp);
            c[i] = cp.compress().to_bytes();
            let dp = g * RScalar::from((i as u64) + 11);
            dest_p.push(dp);
            p_ch[i] = dp.compress().to_bytes();
            d[i] = crate::leaf::dest_leaf_fp(&p_ch[i]);
        }
        let ctx = [9u8; 64];
        let t = rs_rand();
        let w = rs_rand();
        let ct = pts[6] + ristretto_h_note() * t;
        let pcom = dest_p[6] + u * w;
        let td = vs_rand();
        let pr = leaf_prove_v3(&d, &c, &p_ch, 6, &td, &t, &w, &ct, &pcom, &ctx).expect("v3");
        assert_eq!(pr.len(), LEAF_V3_LEN);
        let pd = commit_vesta(&d);
        let pc = crate::tree::commit_ristretto_encodings(&c);
        assert!(leaf_verify_v3(&pd, &pc, &ct, &pcom, &pr, &ctx));
        assert!(!leaf_verify_v3(&pd, &pc, &ct, &pcom, &pr, &[3u8; 64]));
        let fake = ct + ristretto_h_note() * rs_rand();
        assert!(!leaf_verify_v3(&pd, &pc, &fake, &pcom, &pr, &ctx));
        let pr2 = leaf_prove(&d, &c, &p_ch, 6, &td, &t, &w, &ct, &pcom, &[]).expect("v2");
        assert!(!leaf_verify_v3(&pd, &pc, &ct, &pcom, &pr2, &[]));
        assert!(!leaf_verify_v3(&pd, &pc, &ct, &pcom, &pr2, &ctx));
        let mut wd = pasta_curves::vesta::Point::identity();
        for k in 0..ARITY {
            if k == 6 {
                continue;
            }
            wd += crate::tree::vesta_mul_g(k, &crate::tree::vesta_x(&d[k]));
        }
        assert_ne!(&pr[..32], &super::enc_v(&wd));
        let t2 = rs_rand();
        let w2 = rs_rand();
        let ct2 = pts[9] + ristretto_h_note() * t2;
        let pcom2 = dest_p[9] + u * w2;
        let pr_b = leaf_prove_v3(&d, &c, &p_ch, 9, &vs_rand(), &t2, &w2, &ct2, &pcom2, &ctx).expect("b");
        assert!(leaf_verify_v3(&pd, &pc, &ct2, &pcom2, &pr_b, &ctx));
        assert!(!leaf_verify_v3(&pd, &pc, &ct, &pcom, &pr_b, &ctx));
        assert!(!leaf_verify_v3(&pd, &pc, &ct2, &pcom2, &pr, &ctx));
        assert!(leaf_prove_v3(&d, &c, &p_ch, 6, &td, &t, &w, &ct, &(dest_p[1] + u * w), &ctx).is_none());
    }
}
