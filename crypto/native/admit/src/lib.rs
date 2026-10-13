//! ADMITv2 native: Pasta Curve Trees membership + ristretto C select-and-rerandomize + BP+.
//! Verify returns 0/1, never panics across the C ABI.

#![allow(non_snake_case)]

mod bpplus;
mod fe25519;
mod gadget;
mod ipa;
mod leaf;
mod prove;
mod r1cs;
mod select;
mod tree;

pub use bpplus::{prove_range, verify_range, RANGE_BITS};
pub use leaf::{c_leaf_scalar, dest_leaf_fp, DST_LEAF};
pub use prove::{
    admit_prove, admit_prove_v3, admit_verify, admit_verify_v3, admit_verify_batch, forest_prove,
    forest_verify, Proof, MAX_PROOF, MAX_PROOF_V3,
};
pub use tree::{c_root, jroot, jroot_point, pasta_root, CTree, PastaTree, ARITY, HEIGHT_MAX, K_REF};

use std::panic::{catch_unwind, AssertUnwindSafe};

const OK: i32 = 1;
const BAD: i32 = 0;

fn b32(ptr: *const u8) -> Option<[u8; 32]> {
    if ptr.is_null() {
        return None;
    }
    let mut o = [0u8; 32];
    unsafe { std::ptr::copy_nonoverlapping(ptr, o.as_mut_ptr(), 32) };
    Some(o)
}

fn slice<'a>(ptr: *const u8, len: usize) -> Option<&'a [u8]> {
    if ptr.is_null() && len != 0 {
        return None;
    }
    if len == 0 {
        return Some(&[]);
    }
    Some(unsafe { std::slice::from_raw_parts(ptr, len) })
}

#[no_mangle]
pub extern "C" fn shear_note_h(out: *mut u8) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        if out.is_null() {
            return BAD;
        }
        let h = bpplus::h_note().compress().to_bytes();
        unsafe { std::ptr::copy_nonoverlapping(h.as_ptr(), out, 32) };
        OK
    }))
    .unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_admit_max_proof() -> u32 {
    MAX_PROOF as u32
}

#[no_mangle]
pub extern "C" fn shear_admit_arity() -> u32 {
    ARITY as u32
}

/// leaf = H_to_field("shear-admit-leaf-v2" || P). 32-byte Pallas Fp encoding.
#[no_mangle]
pub extern "C" fn shear_admit_leaf(p: *const u8, out: *mut u8) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let p = match b32(p) {
            Some(x) => x,
            None => return BAD,
        };
        if out.is_null() {
            return BAD;
        }
        let l = dest_leaf_fp(&p);
        unsafe { std::ptr::copy_nonoverlapping(l.as_ptr(), out, 32) };
        OK
    }))
    .unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_admit_jroot(
    dest_leaves: *const u8,
    c_leaves: *const u8,
    n: u32,
    out: *mut u8,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        let d = match slice(dest_leaves, n.saturating_mul(32)) {
            Some(x) => x,
            None => return BAD,
        };
        let c = match slice(c_leaves, n.saturating_mul(32)) {
            Some(x) => x,
            None => return BAD,
        };
        if out.is_null() {
            return BAD;
        }
        let root = jroot(d, c, n);
        unsafe { std::ptr::copy_nonoverlapping(root.as_ptr(), out, 32) };
        OK
    }))
    .unwrap_or(BAD)
}

/// Version-3 book. The C root is the ristretto-point leaf, not `jroot`.
#[no_mangle]
pub extern "C" fn shear_admit_jroot_point(
    dest_leaves: *const u8,
    c_leaves: *const u8,
    n: u32,
    out: *mut u8,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        let d = match slice(dest_leaves, n.saturating_mul(32)) {
            Some(x) => x,
            None => return BAD,
        };
        let c = match slice(c_leaves, n.saturating_mul(32)) {
            Some(x) => x,
            None => return BAD,
        };
        if out.is_null() {
            return BAD;
        }
        let root = match jroot_point(d, c, n) {
            Some(r) => r,
            None => return BAD,
        };
        unsafe { std::ptr::copy_nonoverlapping(root.as_ptr(), out, 32) };
        OK
    }))
    .unwrap_or(BAD)
}

/// Extend a JF01 frontier blob by n leaves. `prev_len == 0` starts at n = 0.
/// Writes the new blob and the 32-byte root. The root matches `jroot` of the
/// whole set when every append is applied in order.
#[no_mangle]
pub extern "C" fn shear_admit_frontier_append(
    prev: *const u8,
    prev_len: u32,
    dest_leaves: *const u8,
    c_leaves: *const u8,
    n: u32,
    out_frontier: *mut u8,
    out_cap: u32,
    out_len: *mut u32,
    out_root: *mut u8,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        let prev_len = prev_len as usize;
        let prev_bytes = match slice(prev, prev_len) {
            Some(x) => x,
            None => return BAD,
        };
        let d = match slice(dest_leaves, n.saturating_mul(32)) {
            Some(x) => x,
            None => return BAD,
        };
        let c = match slice(c_leaves, n.saturating_mul(32)) {
            Some(x) => x,
            None => return BAD,
        };
        if out_frontier.is_null() || out_len.is_null() || out_root.is_null() {
            return BAD;
        }
        let (blob, root) = match tree::frontier_append(prev_bytes, d, c, n) {
            Some(x) => x,
            None => return BAD,
        };
        if blob.len() > out_cap as usize || blob.len() > tree::FRONTIER_MAX {
            return BAD;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(blob.as_ptr(), out_frontier, blob.len());
            std::ptr::copy_nonoverlapping(root.as_ptr(), out_root, 32);
            *out_len = blob.len() as u32;
        }
        OK
    }))
    .unwrap_or(BAD)
}

/// prove: returns proof length, or 0 on failure. `out` must hold MAX_PROOF bytes.
#[no_mangle]
pub extern "C" fn shear_admit_prove(
    x: *const u8,
    p: *const u8,
    c: *const u8,
    t: *const u8,
    index: u32,
    dest_leaves: *const u8,
    c_leaves: *const u8,
    n: u32,
    c_tilde_out: *mut u8,
    proof_out: *mut u8,
    proof_len: *mut u32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        let x = match b32(x) {
            Some(v) => v,
            None => return BAD,
        };
        let p = match b32(p) {
            Some(v) => v,
            None => return BAD,
        };
        let c = match b32(c) {
            Some(v) => v,
            None => return BAD,
        };
        let t = match b32(t) {
            Some(v) => v,
            None => return BAD,
        };
        let dest = match slice(dest_leaves, n.saturating_mul(32)) {
            Some(v) => v,
            None => return BAD,
        };
        let cs = match slice(c_leaves, n.saturating_mul(32)) {
            Some(v) => v,
            None => return BAD,
        };
        if c_tilde_out.is_null() || proof_out.is_null() || proof_len.is_null() {
            return BAD;
        }
        match admit_prove(&x, &p, &c, &t, index as usize, dest, cs, n) {
            Some((ct, proof)) => {
                if proof.len() > MAX_PROOF {
                    return BAD;
                }
                unsafe {
                    std::ptr::copy_nonoverlapping(ct.as_ptr(), c_tilde_out, 32);
                    std::ptr::copy_nonoverlapping(proof.as_ptr(), proof_out, proof.len());
                    *proof_len = proof.len() as u32;
                }
                OK
            }
            None => BAD,
        }
    }))
    .unwrap_or(BAD)
}

/// v3 prove. `ctx` is 64 bytes. Returns proof length, or 0. `out` holds MAX_PROOF_V3.
#[no_mangle]
pub extern "C" fn shear_admit_prove_v3(
    x: *const u8,
    p: *const u8,
    c: *const u8,
    t: *const u8,
    index: u32,
    dest_leaves: *const u8,
    c_leaves: *const u8,
    n: u32,
    ctx: *const u8,
    ctx_len: u32,
    c_tilde_out: *mut u8,
    proof_out: *mut u8,
    proof_len: *mut u32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        let x = match b32(x) {
            Some(v) => v,
            None => return BAD,
        };
        let p = match b32(p) {
            Some(v) => v,
            None => return BAD,
        };
        let c = match b32(c) {
            Some(v) => v,
            None => return BAD,
        };
        let t = match b32(t) {
            Some(v) => v,
            None => return BAD,
        };
        let ctx_b = match slice(ctx, ctx_len as usize) {
            Some(v) => v,
            None => return BAD,
        };
        let dest = match slice(dest_leaves, n.saturating_mul(32)) {
            Some(v) => v,
            None => return BAD,
        };
        let cs = match slice(c_leaves, n.saturating_mul(32)) {
            Some(v) => v,
            None => return BAD,
        };
        if c_tilde_out.is_null() || proof_out.is_null() || proof_len.is_null() {
            return BAD;
        }
        match admit_prove_v3(&x, &p, &c, &t, index as usize, dest, cs, n, ctx_b) {
            Some((ct, proof)) => {
                if proof.len() > MAX_PROOF_V3 {
                    return BAD;
                }
                unsafe {
                    std::ptr::copy_nonoverlapping(ct.as_ptr(), c_tilde_out, 32);
                    std::ptr::copy_nonoverlapping(proof.as_ptr(), proof_out, proof.len());
                    *proof_len = proof.len() as u32;
                }
                OK
            }
            None => BAD,
        }
    }))
    .unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_admit_verify_v3(
    proof: *const u8,
    proof_len: u32,
    jroot_bytes: *const u8,
    c_tilde: *const u8,
    spend_tag: *const u8,
    ctx: *const u8,
    ctx_len: u32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let pr = match slice(proof, proof_len as usize) {
            Some(v) => v,
            None => return BAD,
        };
        let jr = match b32(jroot_bytes) {
            Some(v) => v,
            None => return BAD,
        };
        let ct = match b32(c_tilde) {
            Some(v) => v,
            None => return BAD,
        };
        let tag = match b32(spend_tag) {
            Some(v) => v,
            None => return BAD,
        };
        let ctx_b = match slice(ctx, ctx_len as usize) {
            Some(v) => v,
            None => return BAD,
        };
        if admit_verify_v3(pr, &jr, &ct, &tag, ctx_b) {
            OK
        } else {
            BAD
        }
    }))
    .unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_admit_verify(
    proof: *const u8,
    proof_len: u32,
    jroot_bytes: *const u8,
    c_tilde: *const u8,
    spend_tag: *const u8,
    dest_leaves: *const u8,
    c_leaves: *const u8,
    n: u32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        let pr = match slice(proof, proof_len as usize) {
            Some(v) => v,
            None => return BAD,
        };
        let jr = match b32(jroot_bytes) {
            Some(v) => v,
            None => return BAD,
        };
        let ct = match b32(c_tilde) {
            Some(v) => v,
            None => return BAD,
        };
        let tag = match b32(spend_tag) {
            Some(v) => v,
            None => return BAD,
        };
        // Membership is log-time against jroot. Leaf lists are ignored.
        let dest = slice(dest_leaves, n.saturating_mul(32)).unwrap_or(&[]);
        let cs = slice(c_leaves, n.saturating_mul(32)).unwrap_or(&[]);
        if admit_verify(pr, &jr, &ct, &tag, dest, cs, n) {
            OK
        } else {
            BAD
        }
    }))
    .unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_admit_verify_batch(
    proofs: *const u8,
    lens: *const u32,
    count: u32,
    jroot_bytes: *const u8,
    c_tildes: *const u8,
    tags: *const u8,
    dest_leaves: *const u8,
    c_leaves: *const u8,
    n: u32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let count = count as usize;
        let n = n as usize;
        if proofs.is_null() || lens.is_null() || jroot_bytes.is_null() {
            return BAD;
        }
        let lens_s = unsafe { std::slice::from_raw_parts(lens, count) };
        let total: usize = lens_s.iter().map(|x| *x as usize).sum();
        let blob = match slice(proofs, total) {
            Some(v) => v,
            None => return BAD,
        };
        let jr = match b32(jroot_bytes) {
            Some(v) => v,
            None => return BAD,
        };
        let cts = match slice(c_tildes, count.saturating_mul(32)) {
            Some(v) => v,
            None => return BAD,
        };
        let tgs = match slice(tags, count.saturating_mul(32)) {
            Some(v) => v,
            None => return BAD,
        };
        let dest = slice(dest_leaves, n.saturating_mul(32)).unwrap_or(&[]);
        let cs = slice(c_leaves, n.saturating_mul(32)).unwrap_or(&[]);
        let mut offset = 0usize;
        let mut items = Vec::with_capacity(count);
        for i in 0..count {
            let ln = lens_s[i] as usize;
            if offset + ln > blob.len() {
                return BAD;
            }
            let mut ct = [0u8; 32];
            let mut tg = [0u8; 32];
            ct.copy_from_slice(&cts[i * 32..i * 32 + 32]);
            tg.copy_from_slice(&tgs[i * 32..i * 32 + 32]);
            items.push((&blob[offset..offset + ln], ct, tg));
            offset += ln;
        }
        if admit_verify_batch(&items, &jr, dest, cs, n) {
            OK
        } else {
            BAD
        }
    }))
    .unwrap_or(BAD)
}

/// Native 1k/10k/100k bench. Times prove + jroot-only verify. `n==0` is BAD.
#[no_mangle]
pub extern "C" fn shear_admit_bench(
    n: u32,
    prove_us: *mut u64,
    verify_us: *mut u64,
    proof_len: *mut u32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        if prove_us.is_null() || verify_us.is_null() || proof_len.is_null() {
            return BAD;
        }
        let n = n as usize;
        if n == 0 || n > 1_048_576 {
            return BAD;
        }
        use crate::leaf::sha512_64;
        use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
        use curve25519_dalek::scalar::Scalar;
        use std::time::Instant;

        let h = bpplus::h_note();
        let x = Scalar::from(7u64);
        let p = (G * x).compress().to_bytes();
        let r = Scalar::from(9u64);
        let c = (G * Scalar::from(1u64) + h * r).compress().to_bytes();
        let t = Scalar::from(11u64);
        let idx = 7.min(n - 1);
        let mut dest = vec![0u8; n * 32];
        let mut cs = vec![0u8; n * 32];
        for i in 0..n {
            let wd = sha512_64(&[b"shear-bench-d", &(i as u64).to_le_bytes()]);
            dest[i * 32..i * 32 + 32].copy_from_slice(&wd[..32]);
            let wc = sha512_64(&[b"shear-bench-c", &(i as u64).to_le_bytes()]);
            cs[i * 32..i * 32 + 32].copy_from_slice(&wc[..32]);
        }
        dest[idx * 32..idx * 32 + 32].copy_from_slice(&p);
        cs[idx * 32..idx * 32 + 32].copy_from_slice(&c);

        // Warm generators + memoize dest/C levels (wallet already has jroot before send).
        let jr = jroot(&dest, &cs, n);

        let t0 = Instant::now();
        let (ct, proof) = match admit_prove(&x.to_bytes(), &p, &c, &t.to_bytes(), idx, &dest, &cs, n)
        {
            Some(v) => v,
            None => return BAD,
        };
        let prove = t0.elapsed().as_micros() as u64;
        let tag = match prove::spend_tag_of(&proof) {
            Some(t) => t,
            None => return BAD,
        };
        let t1 = Instant::now();
        let ok = admit_verify(&proof, &jr, &ct, &tag, &[], &[], 0);
        let verify = t1.elapsed().as_micros() as u64;
        if !ok {
            return BAD;
        }
        unsafe {
            *prove_us = prove;
            *verify_us = verify;
            *proof_len = proof.len() as u32;
        }
        OK
    }))
    .unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_range_prove(v: u64, r: *const u8, out: *mut u8, out_len: *mut u32) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let r = match b32(r) {
            Some(x) => x,
            None => return BAD,
        };
        if out.is_null() || out_len.is_null() {
            return BAD;
        }
        match prove_range(v, &r) {
            Some(p) => {
                unsafe {
                    std::ptr::copy_nonoverlapping(p.as_ptr(), out, p.len());
                    *out_len = p.len() as u32;
                }
                OK
            }
            None => BAD,
        }
    }))
    .unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_range_verify(c: *const u8, proof: *const u8, proof_len: u32) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let c = match b32(c) {
            Some(x) => x,
            None => return BAD,
        };
        let p = match slice(proof, proof_len as usize) {
            Some(x) => x,
            None => return BAD,
        };
        if verify_range(&c, p) {
            OK
        } else {
            BAD
        }
    }))
    .unwrap_or(BAD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use group::GroupEncoding;
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
    use curve25519_dalek::ristretto::RistrettoPoint;
    use curve25519_dalek::scalar::Scalar;
    use curve25519_dalek::traits::Identity;
    use rand_core::OsRng;
    use sha2::{Digest, Sha512};

    fn rand_scalar() -> Scalar {
        let mut w = [0u8; 64];
        rand_core::RngCore::fill_bytes(&mut OsRng, &mut w);
        Scalar::from_bytes_mod_order_wide(&w)
    }

    fn point_bytes(p: &RistrettoPoint) -> [u8; 32] {
        p.compress().to_bytes()
    }

    fn hash_to_ristretto(tag: &[u8]) -> RistrettoPoint {
        let mut h = Sha512::digest(tag);
        let mut u = [0u8; 64];
        u.copy_from_slice(&h);
        RistrettoPoint::from_uniform_bytes(&u)
    }

    #[test]
    fn range_accepts_honest_and_rejects_bit_or_blob() {
        let r = rand_scalar();
        let v = 42u64;
        let h = bpplus::h_note();
        let c = RISTRETTO_BASEPOINT_POINT * Scalar::from(v) + h * r;
        let cb = point_bytes(&c);
        let proof = prove_range(v, &r.to_bytes()).expect("prove");
        assert!(verify_range(&cb, &proof));
        assert!(!verify_range(&cb, &[0u8; 8]));
        assert!(!verify_range(&cb, &proof[..proof.len() / 2]));
        let mut bad = proof.clone();
        bad[0] ^= 1;
        assert!(!verify_range(&cb, &bad));
        let c2 = RISTRETTO_BASEPOINT_POINT * Scalar::from(43u64) + h * r;
        assert!(!verify_range(&point_bytes(&c2), &proof));
    }

    #[test]
    fn admit_honest_and_subset_and_v1_fail() {
        let n = 8usize;
        let mut xs = Vec::new();
        let mut ps = Vec::new();
        let mut cs = Vec::new();
        let h = hash_to_ristretto(b"shear-note-H-v1");
        for i in 0..n {
            let x = rand_scalar();
            let p = RISTRETTO_BASEPOINT_POINT * x;
            let r = rand_scalar();
            let c = RISTRETTO_BASEPOINT_POINT * Scalar::from((i as u64) + 1) + h * r;
            xs.push(x);
            ps.push(point_bytes(&p));
            cs.push(point_bytes(&c));
        }
        let mut dest_blob = Vec::new();
        let mut c_blob = Vec::new();
        for i in 0..n {
            dest_blob.extend_from_slice(&ps[i]);
            c_blob.extend_from_slice(&cs[i]);
        }
        let idx = 3usize;
        let t = rand_scalar();
        let (ct, proof) = admit_prove(
            &xs[idx].to_bytes(),
            &ps[idx],
            &cs[idx],
            &t.to_bytes(),
            idx,
            &dest_blob,
            &c_blob,
            n,
        )
        .expect("prove");
        assert!(proof.len() <= MAX_PROOF);
        assert_ne!(ct, cs[idx]); // rerandomized — not the original C
        let jr = jroot(&dest_blob, &c_blob, n);
        let tag = {
            // spendTag is inside the proof; verify extracts it. Recompute via prove path.
            proof_spend_tag(&proof).expect("tag")
        };
        assert!(admit_verify(&proof, &jr, &ct, &tag, &dest_blob, &c_blob, n));
        // log-time: empty leaf lists, jroot only
        assert!(admit_verify(&proof, &jr, &ct, &tag, &[], &[], 0));
        // subset J → different jroot
        let jr_sub = jroot(&dest_blob[..4 * 32], &c_blob[..4 * 32], 4);
        assert!(!admit_verify(
            &proof, &jr_sub, &ct, &tag, &dest_blob[..4 * 32], &c_blob[..4 * 32], 4
        ));
        assert!(!admit_verify(&proof, &jr_sub, &ct, &tag, &[], &[], 0));
        // ADMITv1-shaped blob
        let mut v1 = vec![1u8, 0, 0, 0];
        v1.extend_from_slice(&[0u8; 64]);
        v1.extend(vec![0u8; n * 32]); // r.length === |J|
        assert!(!admit_verify(&v1, &jr, &ct, &tag, &dest_blob, &c_blob, n));
        // fake C̃
        let mut ct_bad = ct;
        ct_bad[0] ^= 1;
        assert!(!admit_verify(
            &proof, &jr, &ct_bad, &tag, &dest_blob, &c_blob, n
        ));
    }

    fn proof_spend_tag(proof: &[u8]) -> Option<[u8; 32]> {
        prove::spend_tag_of(proof)
    }

    #[test]
    fn dest_path_rejects_inconsistent_levels() {
        let n = 40usize;
        let mut dest = vec![0u8; n * 32];
        let mut cs = vec![0u8; n * 32];
        for i in 0..n {
            dest[i * 32] = i as u8;
            dest[i * 32 + 1] = 1;
            cs[i * 32] = i as u8;
            cs[i * 32 + 1] = 2;
        }
        let path = tree::dest_path(&dest, n, 7).expect("path");
        assert!(path.len() >= 2, "n=40 must be at least two D-ary levels");
        let mut raw = Vec::new();
        for lvl in &path {
            for x in lvl {
                raw.extend_from_slice(x);
            }
        }
        let honest = tree::dest_path_root(&raw).expect("honest fold");
        raw[0] ^= 0xff;
        assert_ne!(tree::dest_path_root(&raw), Some(honest));
        // parent-in-child fails (or root changes); never equals honest root
        if let Some(bad) = tree::dest_path_root(&raw) {
            assert_ne!(bad, honest);
        }
    }

    fn note_set(n: usize) -> (Vec<Scalar>, Vec<[u8; 32]>, Vec<[u8; 32]>, Vec<u8>, Vec<u8>) {
        let h = hash_to_ristretto(b"shear-note-H-v1");
        let mut xs = Vec::new();
        let mut ps = Vec::new();
        let mut cs = Vec::new();
        for i in 0..n {
            let x = rand_scalar();
            let p = RISTRETTO_BASEPOINT_POINT * x;
            let r = rand_scalar();
            let c = RISTRETTO_BASEPOINT_POINT * Scalar::from((i as u64) + 1) + h * r;
            xs.push(x);
            ps.push(point_bytes(&p));
            cs.push(point_bytes(&c));
        }
        let mut dest_blob = Vec::new();
        let mut c_blob = Vec::new();
        for i in 0..n {
            dest_blob.extend_from_slice(&ps[i]);
            c_blob.extend_from_slice(&cs[i]);
        }
        (xs, ps, cs, dest_blob, c_blob)
    }

    #[test]
    fn proof_blob_does_not_name_p_or_c_or_dest_leaf() {
        let n = 8usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let idx = 3usize;
        let t = rand_scalar();
        let (_ct, proof) = admit_prove(
            &xs[idx].to_bytes(),
            &ps[idx],
            &cs[idx],
            &t.to_bytes(),
            idx,
            &dest_blob,
            &c_blob,
            n,
        )
        .expect("prove");
        let dest_l = crate::leaf::dest_leaf_fp(&ps[idx]);
        assert!(
            !proof[1..(1 + 32 * 8 + 1)].windows(32).any(|w| *w == ps[idx]),
            "header must not name P"
        );
        assert!(
            !proof.windows(32).any(|w| w == dest_l),
            "blob must not contain dest_leaf of the spent note"
        );
        // Original C may appear in the arity-32 sibling bucket (anonymity 32),
        // never as a unique named field and never equal to C̃.
        assert_ne!(_ct, cs[idx]);
        assert_ne!(proof.get(257).copied().unwrap_or(0), idx as u8);
    }

    #[test]
    fn from_scratch_non_member_fails_admit_verify() {
        let n = 8usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot(&dest_blob, &c_blob, n);
        let ax = rand_scalar();
        let ap = (RISTRETTO_BASEPOINT_POINT * ax).compress().to_bytes();
        let h = hash_to_ristretto(b"shear-note-H-v1");
        let ac = (RISTRETTO_BASEPOINT_POINT * Scalar::from(99u64) + h * rand_scalar()).compress().to_bytes();
        let t = rand_scalar();
        assert!(
            admit_prove(&ax.to_bytes(), &ap, &ac, &t.to_bytes(), 0, &dest_blob, &c_blob, n).is_none(),
            "prove must refuse attacker P not at the claimed index"
        );
        let mut d_att = ap.to_vec();
        d_att.extend_from_slice(&dest_blob[32..]);
        let mut c_att = ac.to_vec();
        c_att.extend_from_slice(&c_blob[32..]);
        let (ct_a, proof_a) = admit_prove(
            &ax.to_bytes(),
            &ap,
            &ac,
            &t.to_bytes(),
            0,
            &d_att,
            &c_att,
            n,
        )
        .expect("attacker can prove against a J that contains them");
        let tag_a = proof_spend_tag(&proof_a).unwrap();
        assert!(
            !admit_verify(&proof_a, &jr, &ct_a, &tag_a, &[], &[], 0),
            "from-scratch attacker-x + self-minted C̃ against honest jroot must fail"
        );
        let _ = (xs, ps, cs);
    }

    #[test]
    fn attacker_x_cannot_spend_victim_index() {
        let n = 8usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot(&dest_blob, &c_blob, n);
        let ax = rand_scalar();
        let ap = (RISTRETTO_BASEPOINT_POINT * ax).compress().to_bytes();
        let t = rand_scalar();
        assert!(
            admit_prove(
                &ax.to_bytes(),
                &ap,
                &cs[3],
                &t.to_bytes(),
                3,
                &dest_blob,
                &c_blob,
                n,
            )
            .is_none(),
            "attacker x + victim dest/C index must not prove"
        );
        let (ct, proof) = admit_prove(
            &xs[3].to_bytes(),
            &ps[3],
            &cs[3],
            &t.to_bytes(),
            3,
            &dest_blob,
            &c_blob,
            n,
        )
        .expect("honest");
        let tag = proof_spend_tag(&proof).unwrap();
        assert!(admit_verify(&proof, &jr, &ct, &tag, &[], &[], 0));
    }

    #[test]
    fn admit_rejects_self_minted_c_tilde() {
        let n = 8usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot(&dest_blob, &c_blob, n);
        let t = rand_scalar();
        let (mut ct, mut proof) = admit_prove(
            &xs[3].to_bytes(),
            &ps[3],
            &cs[3],
            &t.to_bytes(),
            3,
            &dest_blob,
            &c_blob,
            n,
        )
        .expect("honest");
        let tag = proof_spend_tag(&proof).unwrap();
        ct[0] ^= 0x5a;
        proof[33] ^= 0x5a;
        assert!(
            !admit_verify(&proof, &jr, &ct, &tag, &[], &[], 0),
            "self-minted C̃ must fail"
        );
    }

    #[test]
    fn admit_rejects_mixed_dest_c_indices() {
        let n = 40usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot(&dest_blob, &c_blob, n);
        let t = rand_scalar();
        let (ct_a, mut proof_a) = admit_prove(
            &xs[7].to_bytes(),
            &ps[7],
            &cs[7],
            &t.to_bytes(),
            7,
            &dest_blob,
            &c_blob,
            n,
        )
        .expect("idx7");
        let t2 = rand_scalar();
        let (_ct_b, proof_b) = admit_prove(
            &xs[39].to_bytes(),
            &ps[39],
            &cs[39],
            &t2.to_bytes(),
            39,
            &dest_blob,
            &c_blob,
            n,
        )
        .expect("idx39");
        let tag_a = proof_spend_tag(&proof_a).unwrap();
        let nlay_a = proof_a[257];
        let nlay_b = proof_b[257];
        assert_eq!(nlay_a, nlay_b);
        // Swap C siblings (32×32 at the leaf) from 39 into 7's blob.
        let sib_len = 32 * 32;
        assert!(proof_a.len() > sib_len + 64);
        assert!(proof_b.len() > sib_len + 64);
        let off_a = proof_a.len() - crate::select::LEAF_PAIRED_LEN - sib_len;
        let off_b = proof_b.len() - crate::select::LEAF_PAIRED_LEN - sib_len;
        let sib_b = proof_b[off_b..off_b + sib_len].to_vec();
        proof_a[off_a..off_a + sib_len].copy_from_slice(&sib_b);
        assert!(
            !admit_verify(&proof_a, &jr, &ct_a, &tag_a, &[], &[], 0),
            "mixed dest/C indices must fail"
        );
    }

    #[test]
    fn forest_shares_one_path_bit_commitment() {
        let n = 8usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot(&dest_blob, &c_blob, n);
        let t0 = rand_scalar();
        let t1 = rand_scalar();
        let spends = [
            (xs[1].to_bytes(), ps[1], cs[1], t0.to_bytes(), 1usize),
            (xs[4].to_bytes(), ps[4], cs[4], t1.to_bytes(), 4usize),
        ];
        let got = prove::forest_prove(&spends, &dest_blob, &c_blob, n).expect("forest");
        assert_eq!(got.len(), 2);
        let items: Vec<(&[u8], [u8; 32], [u8; 32])> = got
            .iter()
            .map(|(ct, pr)| {
                let tag = proof_spend_tag(pr).unwrap();
                (pr.as_slice(), *ct, tag)
            })
            .collect();
        assert!(prove::forest_verify(&items, &jr, &[], &[], 0));
        // Independent single-input proofs do not share the forest bind.
        let a = admit_prove(
            &xs[1].to_bytes(),
            &ps[1],
            &cs[1],
            &t0.to_bytes(),
            1,
            &dest_blob,
            &c_blob,
            n,
        )
        .unwrap();
        let b = admit_prove(
            &xs[4].to_bytes(),
            &ps[4],
            &cs[4],
            &t1.to_bytes(),
            4,
            &dest_blob,
            &c_blob,
            n,
        )
        .unwrap();
        let loose = [
            (a.1.as_slice(), a.0, proof_spend_tag(&a.1).unwrap()),
            (b.1.as_slice(), b.0, proof_spend_tag(&b.1).unwrap()),
        ];
        assert!(!prove::forest_verify(&loose, &jr, &[], &[], 0));
        assert!(admit_verify(&a.1, &jr, &a.0, &proof_spend_tag(&a.1).unwrap(), &[], &[], 0));
    }

    fn ctx64() -> [u8; 64] {
        let mut c = [0u8; 64];
        c[0] = 0x33;
        c[31] = 0xa1;
        c[63] = 0x7e;
        c
    }

    fn enc_vesta(p: &pasta_curves::vesta::Point) -> [u8; 32] {
        let e = p.to_bytes();
        let mut o = [0u8; 32];
        o.copy_from_slice(e.as_ref());
        o
    }

    /// Unblinded dest remainder for one arity-32 bucket. Matches the version-2 leaf.
    fn dest_remainder(children: &[[u8; 32]; 32], slot: usize) -> [u8; 32] {
        use group::Group;
        let mut w = pasta_curves::vesta::Point::identity();
        for k in 0..32 {
            if k == slot {
                continue;
            }
            w += tree::vesta_mul_g(k, &tree::vesta_x(&children[k]));
        }
        enc_vesta(&w)
    }

    fn leaf_dest_children(dest: &[u8], n: usize, index: usize) -> [[u8; 32]; 32] {
        let mut xs = [[0u8; 32]; 32];
        let start = (index / 32) * 32;
        for i in 0..32 {
            let at = start + i;
            if at < n {
                let mut p = [0u8; 32];
                p.copy_from_slice(&dest[at * 32..at * 32 + 32]);
                xs[i] = dest_leaf_fp(&p);
            }
        }
        xs
    }

    fn slots_matching(children: &[[u8; 32]; 32], published: &[u8; 32]) -> Vec<usize> {
        (0..32)
            .filter(|slot| dest_remainder(children, *slot) == *published)
            .collect()
    }

    /// One-layer proof. Version 2 publishes both buckets. Version 3 publishes
    /// the dest bucket only; the C notes are not on the wire.
    fn one_layer_leaf_w(proof: &[u8]) -> [u8; 32] {
        assert_eq!(proof[257], 1, "n <= 32 is one layer");
        let buckets = if proof[0] == 3 { 1 } else { 2 };
        let off = 258 + 32 * 32 * buckets;
        proof[off..off + 32].try_into().unwrap()
    }

    #[test]
    fn v2_remainder_names_the_spent_slot() {
        let n = 8usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let idx = 3usize;
        let t = rand_scalar();
        let (_ct, proof) = admit_prove(
            &xs[idx].to_bytes(),
            &ps[idx],
            &cs[idx],
            &t.to_bytes(),
            idx,
            &dest_blob,
            &c_blob,
            n,
        )
        .expect("v2");
        let kids = leaf_dest_children(&dest_blob, n, idx);
        let hits = slots_matching(&kids, &one_layer_leaf_w(&proof));
        assert_eq!(hits, vec![idx], "unblinded W identifies the spent slot");
    }

    #[test]
    fn v3_remainder_hides_the_slot_and_rejects_a_mint() {
        let n = 8usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot_point(&dest_blob, &c_blob, n).expect("point leaves");
        let idx = 3usize;
        let t = rand_scalar();
        let ctx = ctx64();
        let (ct, proof) = admit_prove_v3(
            &xs[idx].to_bytes(),
            &ps[idx],
            &cs[idx],
            &t.to_bytes(),
            idx,
            &dest_blob,
            &c_blob,
            n,
            &ctx,
        )
        .expect("v3");
        assert_eq!(proof[0], 3);
        assert!(proof.len() <= MAX_PROOF_V3);
        let tag = proof_spend_tag(&proof).expect("v3 tag");
        assert!(admit_verify_v3(&proof, &jr, &ct, &tag, &ctx));
        assert!(!admit_verify(&proof, &jr, &ct, &tag, &[], &[], 0), "v3 blob is not v2");
        let kids = leaf_dest_children(&dest_blob, n, idx);
        let hits = slots_matching(&kids, &one_layer_leaf_w(&proof));
        assert!(hits.is_empty(), "blinded W matches no slot, got {hits:?}");
        let mut minted = ct;
        let mut bad = proof.clone();
        minted[0] ^= 0x5a;
        bad[33] ^= 0x5a;
        assert!(!admit_verify_v3(&bad, &jr, &minted, &tag, &ctx), "self-minted C-tilde");
        let jr_sub = jroot_point(&dest_blob[..4 * 32], &c_blob[..4 * 32], 4).expect("point leaves");
        assert!(!admit_verify_v3(&proof, &jr_sub, &ct, &tag, &ctx), "subset jroot");
        let mut ctx_b = ctx;
        ctx_b[10] ^= 1;
        assert!(!admit_verify_v3(&proof, &jr, &ct, &tag, &ctx_b), "foreign ctx");
        let (ct2, proof2) = admit_prove(
            &xs[idx].to_bytes(),
            &ps[idx],
            &cs[idx],
            &t.to_bytes(),
            idx,
            &dest_blob,
            &c_blob,
            n,
        )
        .expect("v2");
        let tag2 = proof_spend_tag(&proof2).unwrap();
        assert!(!admit_verify_v3(&proof2, &jr, &ct2, &tag2, &ctx), "v2 blob is not v3");
        let ax = rand_scalar();
        let ap = (RISTRETTO_BASEPOINT_POINT * ax).compress().to_bytes();
        assert!(
            admit_prove_v3(
                &ax.to_bytes(),
                &ap,
                &cs[idx],
                &t.to_bytes(),
                idx,
                &dest_blob,
                &c_blob,
                n,
                &ctx,
            )
            .is_none(),
            "attacker x at a victim index must not prove"
        );
    }

    #[test]
    fn v3_paired_remainder_hides_the_child_slot() {
        let n = 40usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot_point(&dest_blob, &c_blob, n).expect("point leaves");
        let idx = 7usize;
        let t = rand_scalar();
        let ctx = ctx64();
        let (dlevels, _) = tree::trees(&dest_blob, &c_blob, n);
        let dpath = tree::path_from_levels(&dlevels, idx).expect("path");
        assert!(dpath.len() >= 2, "n=40 has an internal layer");
        let top = dpath.len() - 1;
        let mut slot_idx = idx;
        for _ in 0..top {
            slot_idx /= 32;
        }
        let top_slot = slot_idx % 32;
        let (ct2, proof2) = admit_prove(
            &xs[idx].to_bytes(),
            &ps[idx],
            &cs[idx],
            &t.to_bytes(),
            idx,
            &dest_blob,
            &c_blob,
            n,
        )
        .expect("v2");
        assert_eq!(proof2[257], dpath.len() as u8);
        let published2: [u8; 32] = proof2[258..290].try_into().unwrap();
        assert_eq!(
            slots_matching(&dpath[top], &published2),
            vec![top_slot],
            "v2 internal W names the child"
        );
        let (ct, proof) = admit_prove_v3(
            &xs[idx].to_bytes(),
            &ps[idx],
            &cs[idx],
            &t.to_bytes(),
            idx,
            &dest_blob,
            &c_blob,
            n,
            &ctx,
        )
        .expect("v3");
        let tag = proof_spend_tag(&proof).unwrap();
        assert!(admit_verify_v3(&proof, &jr, &ct, &tag, &ctx));
        assert_eq!(proof[257], dpath.len() as u8);
        let published: [u8; 32] = proof[258..290].try_into().unwrap();
        assert!(
            slots_matching(&dpath[top], &published).is_empty(),
            "v3 internal W matches no child slot"
        );
        let mut sib = proof.clone();
        let leaf_at = sib.len() - crate::select::HIDE_TAIL_LEN - crate::select::LEAF_V3_LEN;
        let q_at = leaf_at + crate::select::LEAF_V3_LEN;
        sib[q_at] ^= 0xff;
        assert!(!admit_verify_v3(&sib, &jr, &ct, &tag, &ctx), "a forged Q must fail");
        let _ = ct2;
    }

    /// Honest version-3 seal. C-tilde is C + t H, and the proof verifies on the set that contains C.
    #[test]
    fn seal_v3_opens_the_note_in_the_set() {
        let n = 8usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot_point(&dest_blob, &c_blob, n).expect("point leaves");
        let idx = 3usize;
        let t = rand_scalar();
        let ctx = ctx64();
        let (ct, proof) = admit_prove_v3(
            &xs[idx].to_bytes(),
            &ps[idx],
            &cs[idx],
            &t.to_bytes(),
            idx,
            &dest_blob,
            &c_blob,
            n,
            &ctx,
        )
        .expect("seal v3");
        let expect = tree::rerand_c(&cs[idx], &t.to_bytes()).expect("rerand");
        assert_eq!(ct, expect, "C-tilde = C + t H");
        assert_ne!(ct, cs[idx]);
        let tag = proof_spend_tag(&proof).expect("tag");
        assert!(admit_verify_v3(&proof, &jr, &ct, &tag, &ctx));
        assert_eq!(proof[0], 3);
        assert_eq!(proof[257], 1);
    }

    /// A fresh ristretto point that was never inserted is not a member.
    #[test]
    fn v3_fresh_point_outside_the_set_fails() {
        let n = 8usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot_point(&dest_blob, &c_blob, n).expect("point leaves");
        let idx = 3usize;
        let t = rand_scalar();
        let ctx = ctx64();
        let (ct, proof) = admit_prove_v3(
            &xs[idx].to_bytes(),
            &ps[idx],
            &cs[idx],
            &t.to_bytes(),
            idx,
            &dest_blob,
            &c_blob,
            n,
            &ctx,
        )
        .expect("honest");
        let tag = proof_spend_tag(&proof).unwrap();
        assert!(admit_verify_v3(&proof, &jr, &ct, &tag, &ctx));

        let ax = rand_scalar();
        let ap = (RISTRETTO_BASEPOINT_POINT * ax).compress().to_bytes();
        let h = hash_to_ristretto(b"shear-note-H-v1");
        let ac = (RISTRETTO_BASEPOINT_POINT * Scalar::from(50_000u64) + h * rand_scalar())
            .compress()
            .to_bytes();
        assert!(ps.iter().all(|p| p != &ap), "fresh P is not in the set");
        assert!(cs.iter().all(|c| c != &ac), "fresh C is not in the set");
        assert!(
            admit_prove_v3(
                &ax.to_bytes(),
                &ap,
                &ac,
                &t.to_bytes(),
                0,
                &dest_blob,
                &c_blob,
                n,
                &ctx,
            )
            .is_none(),
            "prove must refuse a fresh point that is not in the set"
        );
        let mut d_att = dest_blob.clone();
        let mut c_att = c_blob.clone();
        d_att[..32].copy_from_slice(&ap);
        c_att[..32].copy_from_slice(&ac);
        let (ct_a, proof_a) = admit_prove_v3(
            &ax.to_bytes(),
            &ap,
            &ac,
            &t.to_bytes(),
            0,
            &d_att,
            &c_att,
            n,
            &ctx,
        )
        .expect("the fresh point proves only inside a set that contains it");
        let tag_a = proof_spend_tag(&proof_a).unwrap();
        assert!(
            !admit_verify_v3(&proof_a, &jr, &ct_a, &tag_a, &ctx),
            "a fresh point proved in some other set must fail the honest jroot"
        );
        let mut spliced = proof.clone();
        let blob_at = spliced.len() - crate::r1cs::HIDE_BLOB_LEN;
        spliced[blob_at] ^= 0xff;
        assert!(
            !admit_verify_v3(&spliced, &jr, &ct, &tag, &ctx),
            "a forged hide blob must fail"
        );
    }

    /// Honest C and an attacker dest. Slot and encode both open Y. The dest-bind
    /// circuit is valid for the attacker point and commits a different Yx.
    #[test]
    fn honest_c_attacker_p_fails_admit_verify_v3() {
        let n = 32usize;
        let (_xs, _ps, _cs, dest_blob, c_blob) = note_set(n);
        let mut ctx = [0u8; 64];
        rand_core::RngCore::fill_bytes(&mut OsRng, &mut ctx);
        let idx = 4usize;
        eprintln!("PHASE attacker-forge");
        let forged = prove::forge_attacker_dest_v3(idx, &dest_blob, &c_blob, n, &ctx)
            .expect("attacker dest transcript");
        let leaf_at = forged.proof.len() - select::HIDE_TAIL_LEN - select::LEAF_V3_LEN;
        let leaf = &forged.proof[leaf_at..leaf_at + select::LEAF_V3_LEN];
        let (y, slot_v, enc_v) = select::v3_link_openings(leaf).expect("openings");
        assert_eq!(slot_v, y, "slot proof must open the published Y");
        assert_eq!(enc_v, y, "encode proof must open the honest note");
        let (yx, kp_v) = select::v3_dest_openings(leaf).expect("dest openings");
        assert_ne!(kp_v, yx, "dest-bind proof must open the attacker fingerprint");
        let (slot_blob, enc_blob, kp_blob) = select::v3_proof_blobs(leaf).expect("blobs");
        eprintln!("PHASE attacker-circuits");
        assert!(crate::gadget::slot_opening_verifies(slot_blob, &forged.e_bytes, &forged.s_bytes));
        assert!(crate::gadget::encode_opening_verifies(enc_blob, &forged.kc_b));
        assert!(crate::gadget::kp_opening_verifies(kp_blob, &forged.kp_b, &kp_v));
        let jr = jroot_point(&dest_blob, &c_blob, n).expect("point leaves");
        eprintln!("PHASE attacker-verify");
        assert!(
            !admit_verify_v3(&forged.proof, &jr, &forged.ct, &forged.tag, &ctx),
            "verifier accepted an attacker dest under an honest note"
        );
    }

    /// n=64 is two arity-32 buckets. The raw C bucket and its encoding
    /// commitment are absent. Honest proofs verify. A forged Q, a forged hide
    /// blob, a scalar parent, and the scalar jroot do not.
    #[test]
    fn v3_two_bucket_hides_the_spent_notes() {
        let n = 64usize;
        let (xs, ps, cs, dest_blob, c_blob) = note_set(n);
        let jr = jroot_point(&dest_blob, &c_blob, n).expect("point leaves");
        let jr_scalar = jroot(&dest_blob, &c_blob, n);
        assert_ne!(jr, jr_scalar, "the point book is not the scalar jroot");
        let ctx = ctx64();
        let mut seen = Vec::new();
        for idx in [3usize, 40usize] {
            let t = rand_scalar();
            let (ct, proof) = admit_prove_v3(
                &xs[idx].to_bytes(),
                &ps[idx],
                &cs[idx],
                &t.to_bytes(),
                idx,
                &dest_blob,
                &c_blob,
                n,
                &ctx,
            )
            .expect("v3");
            let tag = proof_spend_tag(&proof).unwrap();
            assert!(admit_verify_v3(&proof, &jr, &ct, &tag, &ctx));
            assert_eq!(proof[257], 2, "64 notes are two buckets under one root");
            assert!(proof.len() <= MAX_PROOF_V3);
            let glue = 258 + crate::select::PAIRED_LEN;
            let parent_c: [u8; 32] = proof[glue + 64..glue + 96].try_into().unwrap();
            let which = idx / 32;
            let mut bucket = [[0u8; 32]; 32];
            for i in 0..32 {
                bucket[i] = cs[which * 32 + i];
            }
            assert_eq!(
                parent_c,
                tree::commit_ristretto_points(&bucket).expect("point bucket"),
                "the glue parent is the point commitment of the off-wire bucket"
            );
            let enc = tree::commit_ristretto_encodings(&bucket);
            assert_ne!(parent_c, enc, "the encoding commitment is not the point parent");
            let mut raw = [0u8; 1024];
            for i in 0..32 {
                raw[i * 32..i * 32 + 32].copy_from_slice(&bucket[i]);
            }
            assert!(
                !proof.windows(1024).any(|w| w == raw),
                "the raw C bucket is a contiguous window"
            );
            assert!(
                !proof.windows(32).any(|w| w == enc),
                "the encoding commitment is on the wire"
            );
            let leaf_at = glue + 128 + 32 * 32;
            assert_eq!(
                proof.len(),
                leaf_at + crate::select::LEAF_V3_LEN + crate::select::HIDE_TAIL_LEN
            );
            let w: [u8; 32] = proof[leaf_at..leaf_at + 32].try_into().unwrap();
            let kids = leaf_dest_children(&dest_blob, n, idx);
            assert!(
                slots_matching(&kids, &w).is_empty(),
                "blinding W does not name the slot"
            );
            let q_at = leaf_at + crate::select::LEAF_V3_LEN;
            let q: [u8; 32] = proof[q_at..q_at + 32].try_into().unwrap();
            for note in &bucket {
                assert_ne!(q, *note, "the rerandomized child is not a raw note");
            }
            assert!(
                !admit_verify_v3(&proof, &jr_scalar, &ct, &tag, &ctx),
                "the scalar jroot must not verify a point-leaf proof"
            );
            let mut scalar_parent = proof.clone();
            scalar_parent[glue + 64..glue + 96].copy_from_slice(&enc);
            assert!(
                !admit_verify_v3(&scalar_parent, &jr, &ct, &tag, &ctx),
                "a scalar parent does not open the point bucket"
            );
            let mut forged_q = proof.clone();
            forged_q[q_at] ^= 0xff;
            assert!(
                !admit_verify_v3(&forged_q, &jr, &ct, &tag, &ctx),
                "a forged Q fails"
            );
            let mut forged_blob = proof.clone();
            forged_blob[q_at + 32] ^= 0xff;
            assert!(
                !admit_verify_v3(&forged_blob, &jr, &ct, &tag, &ctx),
                "a forged hide blob fails"
            );
            seen.push(which);
        }
        assert_eq!(seen, vec![0, 1]);
    }

}
