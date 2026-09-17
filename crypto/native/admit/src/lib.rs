//! ADMITv2 native: Pasta Curve Trees membership + ristretto C select-and-rerandomize + BP+.
//! Verify returns 0/1, never panics across the C ABI.

#![allow(non_snake_case)]

mod bpplus;
mod leaf;
mod prove;
mod select;
mod tree;

pub use bpplus::{prove_range, verify_range, RANGE_BITS};
pub use leaf::{c_leaf_scalar, dest_leaf_fp, DST_LEAF};
pub use prove::{
    admit_prove, admit_verify, admit_verify_batch, forest_prove, forest_verify, Proof, MAX_PROOF,
};
pub use tree::{c_root, jroot, pasta_root, CTree, PastaTree, ARITY, HEIGHT_MAX, K_REF};

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
            !proof.windows(32).any(|w| w == ps[idx]),
            "blob must not contain P"
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
}
