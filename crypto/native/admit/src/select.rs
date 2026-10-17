//! D-ary CDS select-and-rerandomize. No slot index on the wire.
//!
//! Parent `P = r U + Σ x_j G_j` (Pedersen VC). Selected `Q = x_i G_sel + t U`.
//! `W = Σ_{j≠i} x_j G_j` is the other-slot remainder. A non-empty ctx (version 3)
//! publishes `W' = W + r_w U` and opens `r - r_w`, so `W'` is not a function of
//! the spent slot. An empty ctx keeps the unblinded remainder.
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

fn r_is_id(p: &RistrettoPoint) -> bool {
    IsIdentity::is_identity(p)
}

pub const CDS_LEN: usize = 32 + 32 + 32 + ARITY * 32 * 3; // W, Q, c0, z_x/z_r/z_t
pub const PAIRED_LEN: usize = 32 * 4 + 64 + ARITY * 32 * 6; // Wd Qd Wc Qc hv0 + 6 z per slot
pub const LEAF_PAIRED_LEN: usize = 32 * 2 + 64 + ARITY * 32 * 5; // Wd Qd hv0 + dest z*3 + c z_t + p z_w
/// W' Q Wc' Kc Kp | A_d zrd A_c zrc | zxd[32] zyc[32] | seed | 13 responses × 32 | Y Yx
/// | slot-link proof | encode proof | dest-bind proof.
/// 13 = dest (x, r, t) + zy + S_lo + S_hi + z_lr + C r + slot links + note (t, w) + zry.
/// Y opens the spent C-scalar. Yx opens the dest-leaf fingerprint.
/// The dest-bind proof opens that same Yx: `kp = pi + rho·U` and the fingerprint.
pub const LEAF_V3_BODY: usize = 32 * 5 + 32 * 4 + ARITY * 32 * 2 + 64 + ARITY * 32 * 13 + 64;
pub const LEAF_V3_LEN: usize = LEAF_V3_BODY
    + crate::r1cs::SLOT_LINK_BLOB
    + crate::r1cs::ENCODE_LINK_BLOB
    + crate::r1cs::ENCODE_LINK_BLOB;
/// Q || challenge seed || one response scalar per slot. Appended after the dest-bind leaf on version 3.
pub const POINT_OPEN_LEN: usize = 32 + 32 + ARITY * 32;

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
    let mut wpt = <RistrettoPoint as Identity>::identity();
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
    if r_is_id(&q) {
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
    let mut wc = <RistrettoPoint as Identity>::identity();
    for k in 0..ARITY {
        if k == index {
            continue;
        }
        wd += vesta_mul_g(k, &vesta_x(&dest_ch[k]));
        wc += gc[k] * rsc(&c_ch[k]);
    }
    // Version 3: blind the remainder. P - W' = (r - r_w) U + x_i G_i.
    let (rwd, rwc) = if ctx.is_empty() {
        (vesta::Scalar::ZERO, RScalar::ZERO)
    } else {
        let rwd = vs_rand();
        let rwc = rs_rand();
        wd += vesta_mul_u(&rwd);
        wc += uc * rwc;
        (rwd, rwc)
    };
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
    zrd[index] = (krd + ed * (rd - rwd)).to_repr().into();
    ztd[index] = (ktd + ed * *t_d).to_repr().into();
    zxc[index] = (kxc + ec * xc).to_bytes();
    zrc[index] = (krc + ec * (rc - rwc)).to_bytes();
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
    if bool::from(qd.is_identity()) || r_is_id(&qc) {
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
    if bool::from(r_is_id(&pj)) {
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
    // Version 3: same remainder blind as the paired layers. P - W' opens r - r_w.
    let rwd = if ctx.is_empty() {
        vesta::Scalar::ZERO
    } else {
        let rwd = vs_rand();
        wd += *ud * rwd;
        rwd
    };
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
        let cj = dec_r(&c_ch[j]).unwrap_or_else(<RistrettoPoint as Identity>::identity);
        let ppj = dec_r(&p_ch[j]).unwrap_or_else(<RistrettoPoint as Identity>::identity);
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
    zrd[index] = (krd + ed * (rd - rwd)).to_repr().into();
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
        let cj = dec_r(&c_ch[jj]).unwrap_or_else(<RistrettoPoint as Identity>::identity);
        let ppj = dec_r(&p_ch[jj]).unwrap_or_else(<RistrettoPoint as Identity>::identity);
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
    if bool::from(qd.is_identity()) || r_is_id(&c_tilde) || r_is_id(&p_com) {
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
        let cj = dec_r(&c_ch[j]).unwrap_or_else(<RistrettoPoint as Identity>::identity);
        let ppj = dec_r(&p_ch[j]).unwrap_or_else(<RistrettoPoint as Identity>::identity);
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
/// zx zr zt zy | S_lo S_hi z_lr | zrc zsd zsc zct zpt zry.
const V3_STRIDE: usize = 32 * 13;
pub(crate) const V3_Y: usize = V3_RESP + ARITY * V3_STRIDE;
pub(crate) const V3_YX: usize = V3_Y + 32;
const V3_LINKS: usize = V3_YX + 32;
const _: () = assert!(V3_LINKS == LEAF_V3_BODY);
const _: () = assert!(
    V3_LINKS
        + crate::r1cs::SLOT_LINK_BLOB
        + crate::r1cs::ENCODE_LINK_BLOB
        + crate::r1cs::ENCODE_LINK_BLOB
        == LEAF_V3_LEN
);

fn limbs4(b: &[u8; 32]) -> [u64; 4] {
    let mut o = [0u64; 4];
    for i in 0..4 {
        let mut limb = [0u8; 8];
        limb.copy_from_slice(&b[i * 8..i * 8 + 8]);
        o[i] = u64::from_le_bytes(limb);
    }
    o
}

/// Schoolbook `S = k + e*y` as 64 little-endian bytes.
/// Each input is a canonical ristretto scalar, so an honest `S` is below 2^507.
pub(crate) fn mul_add_wide(k: &RScalar, e: &RScalar, y: &RScalar) -> Option<[u8; 64]> {
    let eu = limbs4(&e.to_bytes());
    let yu = limbs4(&y.to_bytes());
    let ku = limbs4(&k.to_bytes());
    let mut acc = [0u64; 12];
    for i in 0..4 {
        let mut carry = 0u128;
        for j in 0..4 {
            let idx = i + j;
            let sum = acc[idx] as u128 + (eu[i] as u128) * (yu[j] as u128) + carry;
            acc[idx] = sum as u64;
            carry = sum >> 64;
        }
        let mut idx = i + 4;
        while carry > 0 {
            if idx >= acc.len() {
                return None;
            }
            let sum = acc[idx] as u128 + carry;
            acc[idx] = sum as u64;
            carry = sum >> 64;
            idx += 1;
        }
    }
    let mut carry = 0u128;
    for i in 0..4 {
        let sum = acc[i] as u128 + ku[i] as u128 + carry;
        acc[i] = sum as u64;
        carry = sum >> 64;
    }
    let mut idx = 4usize;
    while carry > 0 {
        if idx >= acc.len() {
            return None;
        }
        let sum = acc[idx] as u128 + carry;
        acc[idx] = sum as u64;
        carry = sum >> 64;
        idx += 1;
    }
    if acc[8..].iter().any(|limb| *limb != 0) {
        return None;
    }
    let mut out = [0u8; 64];
    for i in 0..8 {
        out[i * 8..i * 8 + 8].copy_from_slice(&acc[i].to_le_bytes());
    }
    if out[63] >= 16 {
        return None;
    }
    Some(out)
}

fn embed_r(s: &RScalar) -> Option<vesta::Scalar> {
    Option::<vesta::Scalar>::from(vesta::Scalar::from_repr(s.to_bytes().into()))
}

/// Same generators as the R1CS value commitment, without building the IPA set.
fn link_bases() -> (vesta::Point, vesta::Point) {
    use std::sync::OnceLock;
    static BASES: OnceLock<(vesta::Point, vesta::Point)> = OnceLock::new();
    *BASES.get_or_init(|| {
        (
            crate::ipa::hash_to_vesta(0, b"shear-admit-v3-r1cs-B"),
            crate::ipa::hash_to_vesta(0, b"shear-admit-v3-r1cs-Bblind"),
        )
    })
}

fn link_commit(y: &RScalar, r: &vesta::Scalar) -> Option<vesta::Point> {
    let yv = embed_r(y)?;
    let (b, blind) = link_bases();
    Some(b * yv + blind * r)
}

fn s_join(lo: &[u8; 32], hi: &[u8; 32]) -> [u8; 64] {
    let mut s = [0u8; 64];
    s[..32].copy_from_slice(lo);
    s[32..].copy_from_slice(hi);
    s
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct OrAnn {
    rpd: [u8; 32],
    rqd: [u8; 32],
    rpc: [u8; 32],
    rc: [u8; 32],
    rp: [u8; 32],
    asd: [u8; 32],
    asc: [u8; 32],
    alk: [u8; 32],
    ax: [u8; 32],
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
    ycom: &[u8; 32],
    yx: &[u8; 32],
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
        &ann.alk,
        &ann.ax,
        dest_parent,
        c_parent,
        wp,
        q,
        wc,
        kc,
        kp,
        ct,
        pcom,
        ycom,
        yx,
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
    ycom: &[u8; 32],
    yx: &[u8; 32],
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
        ycom,
        yx,
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
    ycom: vesta::Point,
    yx: vesta::Point,
}

fn v3_ann_eval(
    j: usize,
    eh: &[u8; 64],
    o: &V3Open<'_>,
    zx: &vesta::Scalar,
    zr: &vesta::Scalar,
    zt: &vesta::Scalar,
    s: &[u8; 64],
    z_lr: &vesta::Scalar,
    zrc: &RScalar,
    zsd: &vesta::Scalar,
    zsc: &RScalar,
    zct: &RScalar,
    zpt: &RScalar,
    zry: &vesta::Scalar,
) -> Option<OrAnn> {
    if s[63] >= 16 {
        return None;
    }
    let ed = vesta::Scalar::from_uniform_bytes(eh);
    let ec = RScalar::from_bytes_mod_order_wide(eh);
    let ev = embed_r(&ec)?;
    let zy = RScalar::from_bytes_mod_order_wide(s);
    let zv = vesta::Scalar::from_uniform_bytes(s);
    let (uc, gc, h) = ristretto_gens();
    let rpd = vesta_mul_u(zr) + vesta_mul_g(j, zx) - o.pwd.mul(&ed);
    let rqd = vesta_mul_gsel(zx) + vesta_mul_u(zt) - o.q.mul(&ed);
    let rpc = *uc * zrc + gc[j] * zy - (o.pc - o.wc) * ec;
    let rc = *h * zct - (o.ct - o.kc) * ec;
    let rp = *uc * zpt - (o.pcom - o.kp) * ec;
    let asd = *zsd + o.e1d * zx - ed * o.zxd[j];
    let asc = *zsc + o.e1c * zy - ec * o.zyc[j];
    let (b, blind) = link_bases();
    let alk = b * zv + blind * *z_lr - o.ycom * ev;
    let ax = b * *zx + blind * *zry - o.yx * ed;
    Some(OrAnn {
        rpd: enc_v(&rpd),
        rqd: enc_v(&rqd),
        rpc: enc_r(&rpc),
        rc: enc_r(&rc),
        rp: enc_r(&rp),
        asd: asd.to_repr().into(),
        asc: asc.to_bytes(),
        alk: enc_v(&alk),
        ax: enc_v(&ax),
    })
}

fn v3_ann_open(
    j: usize,
    o: &V3Open<'_>,
    kx: &vesta::Scalar,
    kr: &vesta::Scalar,
    kt: &vesta::Scalar,
    ky: &RScalar,
    klr: &vesta::Scalar,
    krc: &RScalar,
    ksd: &vesta::Scalar,
    ksc: &RScalar,
    kct: &RScalar,
    kpt: &RScalar,
    krx: &vesta::Scalar,
) -> Option<OrAnn> {
    let kv = embed_r(ky)?;
    let (uc, gc, h) = ristretto_gens();
    let (b, blind) = link_bases();
    let alk = b * kv + blind * *klr;
    let ax = b * kx + blind * krx;
    let rpd = vesta_mul_u(kr) + vesta_mul_g(j, kx);
    let rqd = vesta_mul_gsel(kx) + vesta_mul_u(kt);
    let rpc = *uc * krc + gc[j] * ky;
    let rc = *h * kct;
    let rp = *uc * kpt;
    let asd = *ksd + o.e1d * kx;
    let asc = *ksc + o.e1c * ky;
    Some(OrAnn {
        rpd: enc_v(&rpd),
        rqd: enc_v(&rqd),
        rpc: enc_r(&rpc),
        rc: enc_r(&rc),
        rp: enc_r(&rp),
        asd: asd.to_repr().into(),
        asc: asc.to_bytes(),
        alk: enc_v(&alk),
        ax: enc_v(&ax),
    })
}

fn read_z_bytes(proof: &[u8], off: usize) -> Option<[[u8; 32]; ARITY]> {
    let mut o = [[0u8; 32]; ARITY];
    for i in 0..ARITY {
        o[i] = take32(proof, off + i * 32)?;
    }
    Some(o)
}

pub(crate) struct V3Made {
    pub body: Vec<u8>,
    pub y: RScalar,
    pub r_y: vesta::Scalar,
    pub ky: RScalar,
    pub index: usize,
    pub e_bytes: [[u8; 32]; ARITY],
    pub s_bytes: [[u8; 64]; ARITY],
    pub kc_b: [u8; 32],
    pub kp_b: [u8; 32],
    pub ci: RistrettoPoint,
    pub pi: RistrettoPoint,
    pub rho_c: Option<RScalar>,
    pub rho_p: Option<RScalar>,
    pub x: vesta::Scalar,
    pub r_x: vesta::Scalar,
}

fn seal_v3(made: V3Made) -> Option<Vec<u8>> {
    let rho = made.rho_c?;
    let rho_p = made.rho_p?;
    let y_b = take32(&made.body, V3_Y)?;
    let yx_b = take32(&made.body, V3_YX)?;
    let slot = crate::gadget::prove_slot_opening(
        &made.y,
        &made.r_y,
        &y_b,
        &made.ky,
        &made.e_bytes,
        &made.s_bytes,
        made.index,
    )?;
    let enc = crate::gadget::prove_encode_opening(&made.ci, &rho, &made.kc_b, &made.y, &made.r_y)?;
    let kp_blob = crate::gadget::prove_kp_opening(&made.pi, &rho_p, &made.kp_b, &made.x, &made.r_x)?;
    if slot.len() != crate::r1cs::SLOT_LINK_BLOB
        || enc.len() != crate::r1cs::ENCODE_LINK_BLOB
        || kp_blob.len() != crate::r1cs::ENCODE_LINK_BLOB
    {
        return None;
    }
    let kp_v = take32(&kp_blob, 11 * 32)?;
    if kp_v != yx_b {
        return None;
    }
    let mut out = made.body;
    out.extend_from_slice(&slot);
    out.extend_from_slice(&enc);
    out.extend_from_slice(&kp_blob);
    if out.len() != LEAF_V3_LEN {
        return None;
    }
    Some(out)
}

/// v3 leaf. Children stay witnesses. The blob is a blinded generator CDS:
/// `W' = W + r_w U`, with `r_w` absorbed into the dest r-response, plus the
/// same hidden slot on the C parent, the note rerandomizations, and the
/// opening of both parents. Domain is `admit-v3-leaf`.
/// The trailer proves the slot integer and the note encoding open one Y,
/// and the dest-bind proof opens the same Yx as the dest Schnorr.
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
    seal_v3(leaf_prove_v3_inner(
        dest_ch, c_ch, p_ch, index, t_d, t_note, w_p, c_tilde, p_com, ctx, None,
    )?)
}

/// Hand-built leaf body: open a real arity-32 set, but set `Kc`/`Kp` from the caller.
/// The body has no link trailer. The forge attaches a slot opening of the tree
/// scalar and an encode opening of the fresh point.
#[cfg(test)]
pub fn leaf_prove_v3_unbound(
    dest_ch: &[[u8; 32]; ARITY],
    c_ch: &[[u8; 32]; ARITY],
    p_ch: &[[u8; 32]; ARITY],
    index: usize,
    t_d: &vesta::Scalar,
    c_tilde: &RistrettoPoint,
    p_com: &RistrettoPoint,
    ctx: &[u8],
    kc: RistrettoPoint,
    kp: RistrettoPoint,
    delta_c: RScalar,
    delta_p: RScalar,
) -> Option<V3Made> {
    let dummy = RScalar::from(1u64);
    leaf_prove_v3_inner(
        dest_ch,
        c_ch,
        p_ch,
        index,
        t_d,
        &dummy,
        &dummy,
        c_tilde,
        p_com,
        ctx,
        Some((kc, kp, delta_c, delta_p)),
    )
}

fn leaf_prove_v3_inner(
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
    forced: Option<(RistrettoPoint, RistrettoPoint, RScalar, RScalar)>,
) -> Option<V3Made> {
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
    if bool::from(r_is_id(&pi)) {
        return None;
    }
    let h = ristretto_h_note();
    let (u_r, gc, _) = ristretto_gens();
    let (kc, kp, delta_c, delta_p, rho_c, rho_p) = if let Some(forced) = forced {
        (forced.0, forced.1, forced.2, forced.3, None, None)
    } else {
        if *c_tilde != ci + h * t_note || *p_com != pi + *u_r * w_p {
            return None;
        }
        let rho_c = rs_rand();
        let rho_p = rs_rand();
        (
            ci + h * rho_c,
            pi + *u_r * rho_p,
            *t_note - rho_c,
            *w_p - rho_p,
            Some(rho_c),
            Some(rho_p),
        )
    };
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
    let mut wc = <RistrettoPoint as Identity>::identity();
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
    let rd_eff = rd - r_w;
    let rc_eff = rc_full - r_wc;
    let wp_b = enc_v(&wp);
    let q_b = enc_v(&qd);
    let wc_b = enc_r(&wcp);
    let kc_b = enc_r(&kc);
    let kp_b = enc_r(&kp);
    let ct_b = enc_r(c_tilde);
    let pcom_b = enc_r(p_com);
    let r_y = vs_rand();
    let ycom = link_commit(&y, &r_y)?;
    let y_b = enc_v(&ycom);
    let r_x = vs_rand();
    let (bx, blind_x) = link_bases();
    let yx = bx * x + blind_x * r_x;
    let yx_b = enc_v(&yx);

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
    let e1 = v3_e1(ctx, &pd_b, &pc_b, &ct_b, &pcom_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ad_b, &ac_b, &y_b, &yx_b);
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
        ycom,
        yx,
    };
    let kx = vs_rand();
    let kr = vs_rand();
    let kt = vs_rand();
    let ky = rs_rand();
    let klr = vs_rand();
    let krc = rs_rand();
    let ksd = vs_rand();
    let ksc = rs_rand();
    let kct = rs_rand();
    let kpt = rs_rand();
    let krx = vs_rand();
    let open_ann = v3_ann_open(index, &open, &kx, &kr, &kt, &ky, &klr, &krc, &ksd, &ksc, &kct, &kpt, &krx)?;
    let mut zx_b = [[0u8; 32]; ARITY];
    let mut zr_b = [[0u8; 32]; ARITY];
    let mut zt_b = [[0u8; 32]; ARITY];
    let mut zy_b = [[0u8; 32]; ARITY];
    let mut slo_b = [[0u8; 32]; ARITY];
    let mut shi_b = [[0u8; 32]; ARITY];
    let mut zlr_b = [[0u8; 32]; ARITY];
    let mut zrc_s = [[0u8; 32]; ARITY];
    let mut zsd_b = [[0u8; 32]; ARITY];
    let mut zsc_b = [[0u8; 32]; ARITY];
    let mut zct_b = [[0u8; 32]; ARITY];
    let mut zpt_b = [[0u8; 32]; ARITY];
    let mut zry_b = [[0u8; 32]; ARITY];
    let mut e_bytes = [[0u8; 32]; ARITY];
    let mut s_bytes = [[0u8; 64]; ARITY];
    let mut hv = v3_chal(ctx, &open_ann, &pd_b, &pc_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &y_b, &yx_b, &e1, &zv);
    let mut j = (index + 1) % ARITY;
    while j != index {
        let a = vs_rand();
        let b = vs_rand();
        let c = vs_rand();
        let mut s = [0u8; 64];
        OsRng.fill_bytes(&mut s);
        s[63] = 0;
        e_bytes[j] = RScalar::from_bytes_mod_order_wide(&hv).to_bytes();
        s_bytes[j] = s;
        let zlr = vs_rand();
        let e = rs_rand();
        let f = vs_rand();
        let g = rs_rand();
        let hc = rs_rand();
        let hp = rs_rand();
        zx_b[j] = a.to_repr().into();
        zr_b[j] = b.to_repr().into();
        zt_b[j] = c.to_repr().into();
        zy_b[j] = RScalar::from_bytes_mod_order_wide(&s).to_bytes();
        slo_b[j].copy_from_slice(&s[..32]);
        shi_b[j].copy_from_slice(&s[32..]);
        zlr_b[j] = zlr.to_repr().into();
        zrc_s[j] = e.to_bytes();
        zsd_b[j] = f.to_repr().into();
        zsc_b[j] = g.to_bytes();
        zct_b[j] = hc.to_bytes();
        zpt_b[j] = hp.to_bytes();
        let zry = vs_rand();
        zry_b[j] = zry.to_repr().into();
        let ann = v3_ann_eval(j, &hv, &open, &a, &b, &c, &s, &zlr, &e, &f, &g, &hc, &hp, &zry)?;
        hv = v3_chal(ctx, &ann, &pd_b, &pc_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &y_b, &yx_b, &e1, &zv);
        j = (j + 1) % ARITY;
    }
    let ed = vesta::Scalar::from_uniform_bytes(&hv);
    let ec = RScalar::from_bytes_mod_order_wide(&hv);
    let ev = embed_r(&ec)?;
    e_bytes[index] = ec.to_bytes();
    let s_i = mul_add_wide(&ky, &ec, &y)?;
    s_bytes[index] = s_i;
    let zy_i = RScalar::from_bytes_mod_order_wide(&s_i);
    if zy_i != ky + ec * y {
        return None;
    }
    let zv_i = vesta::Scalar::from_uniform_bytes(&s_i);
    let kv = embed_r(&ky)?;
    let yv = embed_r(&y)?;
    if zv_i != kv + ev * yv {
        return None;
    }
    let zx_i = kx + ed * x;
    let zr_i = kr + ed * rd_eff;
    let zt_i = kt + ed * *t_d;
    let zlr_i = klr + ev * r_y;
    let zrc_i = krc + ec * rc_eff;
    let zsd_i = ksd + ed * s_xd[index];
    let zsc_i = ksc + ec * s_yc[index];
    let zct_i = kct + ec * delta_c;
    let zpt_i = kpt + ec * delta_p;
    let zry_i = krx + ed * r_x;
    let back = v3_ann_eval(
        index, &hv, &open, &zx_i, &zr_i, &zt_i, &s_i, &zlr_i, &zrc_i, &zsd_i, &zsc_i, &zct_i, &zpt_i, &zry_i,
    )?;
    if back != open_ann {
        return None;
    }
    zx_b[index] = zx_i.to_repr().into();
    zr_b[index] = zr_i.to_repr().into();
    zt_b[index] = zt_i.to_repr().into();
    zy_b[index] = zy_i.to_bytes();
    slo_b[index].copy_from_slice(&s_i[..32]);
    shi_b[index].copy_from_slice(&s_i[32..]);
    zlr_b[index] = zlr_i.to_repr().into();
    zrc_s[index] = zrc_i.to_bytes();
    zsd_b[index] = zsd_i.to_repr().into();
    zsc_b[index] = zsc_i.to_bytes();
    zct_b[index] = zct_i.to_bytes();
    zpt_b[index] = zpt_i.to_bytes();
    zry_b[index] = zry_i.to_repr().into();

    let mut seed0 = v3_chal(ctx, &open_ann, &pd_b, &pc_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &y_b, &yx_b, &e1, &zv);
    let mut jj = (index + 1) % ARITY;
    while jj != 0 {
        let s_jj = s_join(&slo_b[jj], &shi_b[jj]);
        let zlr_jj = vs(&zlr_b[jj]);
        let zry_jj = vs(&zry_b[jj]);
        let ann = v3_ann_eval(
            jj,
            &seed0,
            &open,
            &vs(&zx_b[jj]),
            &vs(&zr_b[jj]),
            &vs(&zt_b[jj]),
            &s_jj,
            &zlr_jj,
            &rsc(&zrc_s[jj]),
            &vs(&zsd_b[jj]),
            &rsc(&zsc_b[jj]),
            &rsc(&zct_b[jj]),
            &rsc(&zpt_b[jj]),
            &zry_jj,
        )?;
        seed0 = v3_chal(ctx, &ann, &pd_b, &pc_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &y_b, &yx_b, &e1, &zv);
        jj = (jj + 1) % ARITY;
    }
    let mut out = Vec::with_capacity(LEAF_V3_BODY);
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
        out.extend_from_slice(&slo_b[j]);
        out.extend_from_slice(&shi_b[j]);
        out.extend_from_slice(&zlr_b[j]);
        out.extend_from_slice(&zrc_s[j]);
        out.extend_from_slice(&zsd_b[j]);
        out.extend_from_slice(&zsc_b[j]);
        out.extend_from_slice(&zct_b[j]);
        out.extend_from_slice(&zpt_b[j]);
        out.extend_from_slice(&zry_b[j]);
    }
    out.extend_from_slice(&y_b);
    out.extend_from_slice(&yx_b);
    if out.len() != LEAF_V3_BODY {
        return None;
    }
    Some(V3Made {
        body: out,
        y,
        r_y,
        ky,
        index,
        e_bytes,
        s_bytes,
        kc_b,
        kp_b,
        ci,
        pi,
        rho_c,
        rho_p,
        x,
        r_x,
    })
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
    if bool::from(qd.is_identity()) || r_is_id(&c_tilde) || r_is_id(&p_com) || r_is_id(&kc) || r_is_id(&kp) {
        return false;
    }
    let y_b = match take32(proof, V3_Y) {
        Some(x) => x,
        None => return false,
    };
    let ycom = match dec_v(&y_b) {
        Some(x) => x,
        None => return false,
    };
    if bool::from(ycom.is_identity()) {
        return false;
    }
    let yx_b = match take32(proof, V3_YX) {
        Some(x) => x,
        None => return false,
    };
    let yx = match dec_v(&yx_b) {
        Some(x) => x,
        None => return false,
    };
    if bool::from(yx.is_identity()) {
        return false;
    }
    let ct_b = enc_r(c_tilde);
    let pcom_b = enc_r(p_com);
    let e1 = v3_e1(
        ctx, dest_parent, c_parent, &ct_b, &pcom_b, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ad_b, &ac_b, &y_b, &yx_b,
    );
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
        ycom,
        yx,
    };
    let mut hv = seed;
    let mut last = seed;
    if proof.len() < V3_RESP + ARITY * V3_STRIDE {
        return false;
    }
    let mut e_bytes = [[0u8; 32]; ARITY];
    let mut s_bytes = [[0u8; 64]; ARITY];
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
        let zy_b = match take32(proof, off + 96) {
            Some(x) => x,
            None => return false,
        };
        let s_lo = match take32(proof, off + 128) {
            Some(x) => x,
            None => return false,
        };
        let s_hi = match take32(proof, off + 160) {
            Some(x) => x,
            None => return false,
        };
        let zlr_b = match take32(proof, off + 192) {
            Some(x) => x,
            None => return false,
        };
        let zrc = rsc(&match take32(proof, off + 224) {
            Some(x) => x,
            None => return false,
        });
        let zsd = vs(&match take32(proof, off + 256) {
            Some(x) => x,
            None => return false,
        });
        let zsc = rsc(&match take32(proof, off + 288) {
            Some(x) => x,
            None => return false,
        });
        let zct = rsc(&match take32(proof, off + 320) {
            Some(x) => x,
            None => return false,
        });
        let zpt = rsc(&match take32(proof, off + 352) {
            Some(x) => x,
            None => return false,
        });
        let zry = vs(&match take32(proof, off + 384) {
            Some(x) => x,
            None => return false,
        });
        let s = s_join(&s_lo, &s_hi);
        if s[63] >= 16 {
            return false;
        }
        e_bytes[j] = RScalar::from_bytes_mod_order_wide(&hv).to_bytes();
        s_bytes[j] = s;
        let zy = RScalar::from_bytes_mod_order_wide(&s);
        if zy_b != zy.to_bytes() {
            return false;
        }
        let zlr = vs(&zlr_b);
        let ann = match v3_ann_eval(j, &hv, &open, &zx, &zr, &zt, &s, &zlr, &zrc, &zsd, &zsc, &zct, &zpt, &zry) {
            Some(a) => a,
            None => return false,
        };
        last = v3_chal(ctx, &ann, dest_parent, c_parent, &wp_b, &q_b, &wc_b, &kc_b, &kp_b, &ct_b, &pcom_b, &y_b, &yx_b, &e1, &zv);
        hv = last;
    }
    if last != seed {
        return false;
    }
    let slot_at = V3_LINKS;
    let enc_at = slot_at + crate::r1cs::SLOT_LINK_BLOB;
    let kp_at = enc_at + crate::r1cs::ENCODE_LINK_BLOB;
    let slot = match proof.get(slot_at..enc_at) {
        Some(s) => s,
        None => return false,
    };
    let enc = match proof.get(enc_at..kp_at) {
        Some(s) => s,
        None => return false,
    };
    let kp_blob = match proof.get(kp_at..LEAF_V3_LEN) {
        Some(s) => s,
        None => return false,
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::gadget::verify_shared_y_links(&y_b, &e_bytes, &s_bytes, &kc_b, slot, enc)
            && crate::gadget::verify_kp_opening(&yx_b, &kp_b, kp_blob)
    })) {
        Ok(v) => v,
        Err(_) => false,
    }
}

/// Y, the slot proof's committed wire, and the encode proof's committed wire.
#[cfg(test)]
pub fn v3_link_openings(leaf: &[u8]) -> Option<([u8; 32], [u8; 32], [u8; 32])> {
    if leaf.len() != LEAF_V3_LEN {
        return None;
    }
    let y = take32(leaf, V3_Y)?;
    let slot_v = take32(leaf, V3_LINKS + 11 * 32)?;
    let enc_v = take32(leaf, V3_LINKS + crate::r1cs::SLOT_LINK_BLOB + 11 * 32)?;
    Some((y, slot_v, enc_v))
}

/// Slot blob, encode blob, then the dest-bind blob. Encode stays second.
#[cfg(test)]
pub fn v3_proof_blobs(leaf: &[u8]) -> Option<(&[u8], &[u8], &[u8])> {
    if leaf.len() != LEAF_V3_LEN {
        return None;
    }
    let slot_at = V3_LINKS;
    let enc_at = slot_at + crate::r1cs::SLOT_LINK_BLOB;
    let kp_at = enc_at + crate::r1cs::ENCODE_LINK_BLOB;
    if kp_at + crate::r1cs::ENCODE_LINK_BLOB != leaf.len() {
        return None;
    }
    Some((&leaf[slot_at..enc_at], &leaf[enc_at..kp_at], &leaf[kp_at..]))
}

/// Published Yx and the dest-bind proof's committed wire.
#[cfg(test)]
pub fn v3_dest_openings(leaf: &[u8]) -> Option<([u8; 32], [u8; 32])> {
    if leaf.len() != LEAF_V3_LEN {
        return None;
    }
    let yx = take32(leaf, V3_YX)?;
    let kp_at = V3_LINKS + crate::r1cs::SLOT_LINK_BLOB + crate::r1cs::ENCODE_LINK_BLOB;
    let kp_v = take32(leaf, kp_at + 11 * 32)?;
    Some((yx, kp_v))
}

fn point_child(b: &[u8; 32]) -> RistrettoPoint {
    dec_r(b).unwrap_or_else(<RistrettoPoint as Identity>::identity)
}

fn point_open_chal(rq: &[u8; 32], q: &[u8; 32], ctx: &[u8], sib: &[u8]) -> RScalar {
    chal_r(&[rq, q, ctx, sib, b"c-point-open-v3"])
}

/// Version-3 trailer. Q = C_i + ρ·U, and the CDS response opens that ρ on one
/// hidden slot of the published bucket. The dest-bind leaf in front of this is
/// `LEAF_V3_LEN`. Knowledge of ρ is the bind: every ristretto point is some
/// multiple of U, so a sum check with no Schnorr does not bind the slot.
pub fn point_open_prove(c_ch: &[[u8; 32]; ARITY], index: usize, ctx: &[u8]) -> Option<Vec<u8>> {
    if index >= ARITY {
        return None;
    }
    let ci = dec_r(&c_ch[index])?;
    let (u, _, _) = ristretto_gens();
    let rho = rs_rand();
    if rho == RScalar::ZERO {
        return None;
    }
    let q = ci + u * rho;
    if r_is_id(&q) || q == ci {
        return None;
    }
    let q_b = enc_r(&q);
    let mut sib = Vec::with_capacity(ARITY * 32);
    for c in c_ch {
        sib.extend_from_slice(c);
    }
    let mut z = [[0u8; 32]; ARITY];
    let k = rs_rand();
    let ann = u * k;
    let mut e = point_open_chal(&enc_r(&ann), &q_b, ctx, &sib);
    let mut j = (index + 1) % ARITY;
    while j != index {
        let zj = rs_rand();
        z[j] = zj.to_bytes();
        let rq = u * zj - (q - point_child(&c_ch[j])) * e;
        e = point_open_chal(&enc_r(&rq), &q_b, ctx, &sib);
        j = (j + 1) % ARITY;
    }
    z[index] = (k + e * rho).to_bytes();
    let mut e0 = point_open_chal(&enc_r(&ann), &q_b, ctx, &sib);
    let mut jj = (index + 1) % ARITY;
    while jj != 0 {
        let zj = rsc(&z[jj]);
        let rq = u * zj - (q - point_child(&c_ch[jj])) * e0;
        e0 = point_open_chal(&enc_r(&rq), &q_b, ctx, &sib);
        jj = (jj + 1) % ARITY;
    }
    let mut out = Vec::with_capacity(POINT_OPEN_LEN);
    out.extend_from_slice(&q_b);
    out.extend_from_slice(&e0.to_bytes());
    for slot in &z {
        out.extend_from_slice(slot);
    }
    Some(out)
}

pub fn point_open_verify(c_ch: &[[u8; 32]; ARITY], proof: &[u8], ctx: &[u8]) -> bool {
    if proof.len() != POINT_OPEN_LEN {
        return false;
    }
    let q_b = match take32(proof, 0) {
        Some(x) => x,
        None => return false,
    };
    let seed = match take32(proof, 32) {
        Some(x) => x,
        None => return false,
    };
    let q = match dec_r(&q_b) {
        Some(p) => p,
        None => return false,
    };
    if r_is_id(&q) {
        return false;
    }
    let mut sib = Vec::with_capacity(ARITY * 32);
    for c in c_ch {
        sib.extend_from_slice(c);
    }
    let (u, _, _) = ristretto_gens();
    let mut e = rsc(&seed);
    for j in 0..ARITY {
        let zj = rsc(&match take32(proof, 64 + j * 32) {
            Some(x) => x,
            None => return false,
        });
        let rq = u * zj - (q - point_child(&c_ch[j])) * e;
        e = point_open_chal(&enc_r(&rq), &q_b, ctx, &sib);
    }
    e == rsc(&seed)

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

    /// v3 blinds the other-slot sum. v2 still publishes it. The 128-byte child
    /// link stays: this blind does not remove the spent bucket.
    #[test]
    fn v3_paired_blinds_the_other_slot_sum() {
        let d = kids(3);
        let mut c = [[0u8; 32]; ARITY];
        for i in 0..ARITY {
            c[i] = kids(9)[i];
            c[i][3] = 2;
        }
        let td = vs_rand();
        let tc = rs_rand();
        let ctx = [7u8; 64];
        let pr = paired_prove(&d, &c, 4, &td, &tc, &ctx).expect("v3 pair");
        assert_eq!(pr.len(), PAIRED_LEN);
        let pd = commit_vesta(&d);
        let pc = commit_ristretto_encodings(&c);
        assert!(paired_verify(&pd, &pc, &pr, &ctx), "blinded v3 proof must verify");
        assert!(
            !paired_verify(&pd, &pc, &pr, &[]),
            "a v3 blind must not verify under an empty context"
        );
        let mut wd = pasta_curves::vesta::Point::identity();
        for k in 0..ARITY {
            if k == 4 {
                continue;
            }
            wd += crate::tree::vesta_mul_g(k, &crate::tree::vesta_x(&d[k]));
        }
        assert_ne!(&pr[..32], super::enc_v(&wd).as_slice(), "v3 published the unblinded dest sum");
        let (_, gc, _) = ristretto_gens();
        let mut wc = <RistrettoPoint as Identity>::identity();
        for k in 0..ARITY {
            if k == 4 {
                continue;
            }
            wc += gc[k] * rsc(&c[k]);
        }
        assert_ne!(&pr[64..96], super::enc_r(&wc).as_slice(), "v3 published the unblinded C sum");
        let pr2 = paired_prove(&d, &c, 4, &td, &tc, &[]).expect("v2 pair");
        assert!(paired_verify(&pd, &pc, &pr2, &[]));
        assert_eq!(&pr2[..32], super::enc_v(&wd).as_slice(), "v2 still opens the unblinded sum");
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
        let mut flipped = pr.clone();
        flipped[V3_Y] ^= 1;
        assert!(
            !leaf_verify_v3(&pd, &pc, &ct, &pcom, &flipped, &ctx),
            "flipping Y must fail verify"
        );
    }

    #[test]
    fn leaf_rerand_wide_s_matches_both_groups() {
        use ff::FromUniformBytes;
        for _ in 0..8 {
            let k = rs_rand();
            let e = rs_rand();
            let y = rs_rand();
            let s = mul_add_wide(&k, &e, &y).expect("wide");
            assert_eq!(RScalar::from_bytes_mod_order_wide(&s), k + e * y);
            let zv = pasta_curves::vesta::Scalar::from_uniform_bytes(&s);
            let kv = embed_r(&k).expect("k");
            let ev = embed_r(&e).expect("e");
            let yv = embed_r(&y).expect("y");
            assert_eq!(zv, kv + ev * yv);
            assert!(s[63] < 16);
        }
    }

    /// Cleartext dest Schnorr: the real slot's response opens Yx, with no IPA.
    #[test]
    fn fast_v3_yx_schnorr_matches_the_preimage() {
        let (b, blind) = link_bases();
        for _ in 0..8 {
            let x = vs_rand();
            let r_x = vs_rand();
            let kx = vs_rand();
            let krx = vs_rand();
            let ed = vs_rand();
            let yx = b * x + blind * r_x;
            let ax = b * kx + blind * krx;
            let zx = kx + ed * x;
            let zry = krx + ed * r_x;
            let got = b * zx + blind * zry - yx * ed;
            assert_eq!(enc_v(&got), enc_v(&ax));
        }
    }

    /// The unbound body commits Yx to the tree fingerprint and carries zry.
    /// No IPA. Indices cover the wrap, including the floor and the last slot.
    #[test]
    fn fast_v3_body_commits_yx_to_the_tree_fingerprint() {
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
        let h = ristretto_h_note();
        assert_eq!(V3_Y - V3_RESP, ARITY * V3_STRIDE);
        assert_eq!(V3_STRIDE, 32 * 13);
        for index in [0usize, 1, 17, ARITY - 1] {
            let t = rs_rand();
            let w = rs_rand();
            let rho_c = rs_rand();
            let rho_p = rs_rand();
            let ct = pts[index] + h * t;
            let pcom = dest_p[index] + u * w;
            let kc = pts[index] + h * rho_c;
            let kp = dest_p[index] + u * rho_p;
            let made = leaf_prove_v3_unbound(
                &d,
                &c,
                &p_ch,
                index,
                &vs_rand(),
                &ct,
                &pcom,
                &ctx,
                kc,
                kp,
                t - rho_c,
                w - rho_p,
            )
            .expect("body");
            assert_eq!(made.body.len(), LEAF_V3_BODY);
            assert_eq!(made.x, vesta_x(&d[index]));
            let yx = {
                let (b, blind) = link_bases();
                b * made.x + blind * made.r_x
            };
            let yx_b = take32(&made.body, V3_YX).expect("yx");
            assert_eq!(yx_b, enc_v(&yx));
            assert_eq!(&made.body[made.body.len() - 32..], yx_b.as_slice());
            let y_b = take32(&made.body, V3_Y).expect("y");
            assert_ne!(y_b, yx_b);
            assert_eq!(made.kp_b, kp.compress().to_bytes());
            let zry_off = V3_RESP + index * V3_STRIDE + 12 * 32;
            assert!(take32(&made.body, zry_off).is_some());
        }
    }
}
