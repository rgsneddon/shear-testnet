//! Native range proofs on ristretto: v ∈ [0, 2^64).
//! Wire marker 0x02. v3 bit-OR JSON/objects fail this verifier.

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity;
use sha2::{Digest, Sha512};

pub const RANGE_BITS: usize = 64;
const DST: &[u8] = b"shear-bpplus-v2";

fn wide(parts: &[&[u8]]) -> [u8; 64] {
    let mut h = Sha512::new();
    h.update(DST);
    for p in parts {
        h.update(p);
    }
    let d = h.finalize();
    let mut o = [0u8; 64];
    o.copy_from_slice(&d);
    o
}

fn chal(parts: &[&[u8]]) -> Scalar {
    Scalar::from_bytes_mod_order_wide(&wide(parts))
}

pub fn h_note() -> RistrettoPoint {
    RistrettoPoint::from_uniform_bytes(&wide(&[b"shear-note-H-v1"]))
}

fn compress(p: &RistrettoPoint) -> [u8; 32] {
    p.compress().to_bytes()
}

fn decompress(b: &[u8]) -> Option<RistrettoPoint> {
    let mut a = [0u8; 32];
    if b.len() != 32 {
        return None;
    }
    a.copy_from_slice(b);
    CompressedRistretto(a).decompress()
}

fn nonce(tag: &[u8], r: &[u8; 32], i: u64) -> Scalar {
    Scalar::from_bytes_mod_order_wide(&wide(&[tag, r, &i.to_le_bytes()]))
}

/// Prove C = v·G + r·H and each bit of v is 0 or 1, packed (not v3 bit-OR).
pub fn prove_range(v: u64, r_bytes: &[u8; 32]) -> Option<Vec<u8>> {
    let r = Scalar::from_bytes_mod_order(*r_bytes);
    let h = h_note();
    let c = G * Scalar::from(v) + h * r;
    let c_b = compress(&c);

    let mut bits = [0u8; RANGE_BITS];
    let mut s = vec![Scalar::ZERO; RANGE_BITS];
    let mut b_pts = vec![RistrettoPoint::identity(); RANGE_BITS];
    let mut n = v;
    for i in 0..RANGE_BITS {
        bits[i] = (n & 1) as u8;
        n >>= 1;
        s[i] = nonce(b"sbit", r_bytes, i as u64);
        b_pts[i] = G * Scalar::from(bits[i] as u64) + h * s[i];
    }

    let mut out = Vec::with_capacity(2 + 32 + RANGE_BITS * 192 + 64);
    out.push(2u8);
    out.extend_from_slice(&c_b);
    for i in 0..RANGE_BITS {
        out.extend_from_slice(&compress(&b_pts[i]));
    }

    // One FS challenge over all B_i and C
    let mut chal_parts: Vec<&[u8]> = vec![b"bits", &c_b];
    // need owned buffers for B_i
    let b_bytes: Vec<[u8; 32]> = b_pts.iter().map(compress).collect();
    for i in 0..RANGE_BITS {
        chal_parts.push(&b_bytes[i]);
    }
    let e_all = chal(&chal_parts);

    let mut s_sum = Scalar::ZERO;
    let mut two = Scalar::ONE;
    for i in 0..RANGE_BITS {
        let b = bits[i] == 1;
        let bi = b_pts[i];
        let si = s[i];
        let p0 = bi;
        let p1 = bi - G;
        let real = if b { p1 } else { p0 };
        let fake = if b { p0 } else { p1 };
        let e_fake = nonce(b"efake", r_bytes, i as u64);
        let z_fake = nonce(b"zfake", r_bytes, i as u64);
        let r_fake = h * z_fake - fake * e_fake;
        let k = nonce(b"kbit", r_bytes, i as u64);
        let r_real = h * k;
        let r0 = if b { r_fake } else { r_real };
        let r1 = if b { r_real } else { r_fake };
        let e = chal(&[
            b"bit",
            &compress(&bi),
            &compress(&r0),
            &compress(&r1),
            &e_all.to_bytes(),
        ]);
        let e_real = e - e_fake;
        let z_real = k + e_real * si;
        let e0 = if b { e_fake } else { e_real };
        let e1 = if b { e_real } else { e_fake };
        let z0 = if b { z_fake } else { z_real };
        let z1 = if b { z_real } else { z_fake };
        out.extend_from_slice(&compress(&r0));
        out.extend_from_slice(&compress(&r1));
        out.extend_from_slice(&e0.to_bytes());
        out.extend_from_slice(&e1.to_bytes());
        out.extend_from_slice(&z0.to_bytes());
        out.extend_from_slice(&z1.to_bytes());
        s_sum += two * si;
        two += two;
    }
    let r_delta = r - s_sum;
    let acc = {
        let mut a = RistrettoPoint::identity();
        let mut two = Scalar::ONE;
        for i in 0..RANGE_BITS {
            a += b_pts[i] * two;
            two += two;
        }
        a
    };
    let p = c - acc;
    let k = nonce(b"cons", r_bytes, 0);
    let r_pt = h * k;
    let e = chal(&[b"cons", &c_b, &compress(&p), &compress(&r_pt)]);
    let z = k + e * r_delta;
    out.extend_from_slice(&compress(&r_pt));
    out.extend_from_slice(&z.to_bytes());
    Some(out)
}

pub fn verify_range(c_bytes: &[u8; 32], proof: &[u8]) -> bool {
    if proof.is_empty() || proof[0] != 2 {
        return false;
    }
    let need = 1 + 32 + RANGE_BITS * 32 + RANGE_BITS * 192 + 64;
    if proof.len() < need {
        return false;
    }
    let c = match decompress(&proof[1..33]) {
        Some(p) => p,
        None => return false,
    };
    let want = match decompress(c_bytes) {
        Some(p) => p,
        None => return false,
    };
    if c != want {
        return false;
    }
    let h = h_note();
    let mut off = 33usize;
    let mut b_pts = Vec::with_capacity(RANGE_BITS);
    let mut b_bytes = Vec::with_capacity(RANGE_BITS);
    for _ in 0..RANGE_BITS {
        let raw = &proof[off..off + 32];
        let p = match decompress(raw) {
            Some(p) => p,
            None => return false,
        };
        let mut a = [0u8; 32];
        a.copy_from_slice(raw);
        b_bytes.push(a);
        b_pts.push(p);
        off += 32;
    }
    let mut chal_parts: Vec<&[u8]> = vec![b"bits", &proof[1..33]];
    for i in 0..RANGE_BITS {
        chal_parts.push(&b_bytes[i]);
    }
    let e_all = chal(&chal_parts);
    if e_all == Scalar::ZERO {
        return false;
    }
    for i in 0..RANGE_BITS {
        let r0 = match decompress(&proof[off..off + 32]) {
            Some(p) => p,
            None => return false,
        };
        let r1 = match decompress(&proof[off + 32..off + 64]) {
            Some(p) => p,
            None => return false,
        };
        let mut e0b = [0u8; 32];
        e0b.copy_from_slice(&proof[off + 64..off + 96]);
        let mut e1b = [0u8; 32];
        e1b.copy_from_slice(&proof[off + 96..off + 128]);
        let mut z0b = [0u8; 32];
        z0b.copy_from_slice(&proof[off + 128..off + 160]);
        let mut z1b = [0u8; 32];
        z1b.copy_from_slice(&proof[off + 160..off + 192]);
        off += 192;
        let e0 = Scalar::from_bytes_mod_order(e0b);
        let e1 = Scalar::from_bytes_mod_order(e1b);
        let z0 = Scalar::from_bytes_mod_order(z0b);
        let z1 = Scalar::from_bytes_mod_order(z1b);
        let e = chal(&[
            b"bit",
            &b_bytes[i],
            &proof[off - 192..off - 160],
            &proof[off - 160..off - 128],
            &e_all.to_bytes(),
        ]);
        if e == Scalar::ZERO {
            return false;
        }
        if e0 + e1 != e {
            return false;
        }
        let p0 = b_pts[i];
        let p1 = b_pts[i] - G;
        if h * z0 != r0 + p0 * e0 {
            return false;
        }
        if h * z1 != r1 + p1 * e1 {
            return false;
        }
    }
    let mut acc = RistrettoPoint::identity();
    let mut two = Scalar::ONE;
    for i in 0..RANGE_BITS {
        acc += b_pts[i] * two;
        two += two;
    }
    let p = c - acc;
    let r_pt = match decompress(&proof[off..off + 32]) {
        Some(p) => p,
        None => return false,
    };
    let mut zb = [0u8; 32];
    zb.copy_from_slice(&proof[off + 32..off + 64]);
    let z = Scalar::from_bytes_mod_order(zb);
    let e = chal(&[b"cons", &proof[1..33], &compress(&p), &proof[off..off + 32]]);
    if e == Scalar::ZERO {
        return false;
    }
    h * z == r_pt + p * e
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dummy_zero_and_nonzero() {
        let r = Scalar::from(7u64);
        let h = h_note();
        for v in [0u64, 1, 255, (1u64 << 32) + 9] {
            let c = G * Scalar::from(v) + h * r;
            let p = prove_range(v, &r.to_bytes()).unwrap();
            assert!(verify_range(&c.compress().to_bytes(), &p), "v={v}");
        }
        let c = G * Scalar::from(3u64) + h * r;
        let p = prove_range(4, &r.to_bytes()).unwrap();
        assert!(!verify_range(&c.compress().to_bytes(), &p));
        assert!(!verify_range(&c.compress().to_bytes(), &[0u8; 8]));
        let cb = (G * Scalar::from(1u64) + h * r).compress().to_bytes();
        let mut z = prove_range(1, &r.to_bytes()).unwrap();
        let e0 = 1 + 32 + RANGE_BITS * 32 + 64;
        for b in z.iter_mut().skip(e0).take(64) {
            *b = 0;
        }
        assert!(!verify_range(&cb, &z), "zero Fiat–Shamir e0/e1 rejected");
    }
}
