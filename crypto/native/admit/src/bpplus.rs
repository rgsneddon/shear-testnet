//! Native range proofs on ristretto: v ∈ [0, 2^64).
//! Wire marker 0x02. v3 bit-OR JSON/objects fail this verifier.

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha512};
use zeroize::Zeroize;

/// Named secret. Drop wipes it on every return path, including panic.
struct SecretScalar(Scalar);

impl Drop for SecretScalar {
    fn drop(&mut self) {
        wipe_scalar(&mut self.0);
    }
}

impl SecretScalar {
    fn from_scalar(s: Scalar) -> Self {
        Self(s)
    }

    fn as_scalar(&self) -> Scalar {
        self.0
    }
}

fn wipe_scalar(s: &mut Scalar) {
    unsafe {
        let p = s as *mut Scalar as *mut u8;
        for i in 0..core::mem::size_of::<Scalar>() {
            core::ptr::write_volatile(p.add(i), 0);
        }
    }
    core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
}

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
    // Wide reduction is the Fiat-Shamir challenge. Do not switch this to a
    // canonical-bytes parse: the hash is 64 bytes and is not a wire scalar.
    Scalar::from_bytes_mod_order_wide(&wide(parts))
}

/// Wire scalars must be canonical. `from_bytes_mod_order` would accept s+L.
fn scalar_canonical(bytes: [u8; 32]) -> Option<Scalar> {
    Scalar::from_canonical_bytes(bytes).into()
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

/// Hedged nonce. Fresh CSPRNG output, the blind, the value, the commitment,
/// and the statement transcript. A second proof on the same blind draws a
/// new hedge, so the nonces cannot match.
fn nonce(
    tag: &[u8],
    hedge: &[u8; 32],
    r: &[u8; 32],
    value: &[u8; 8],
    commit: &[u8; 32],
    transcript: &[u8],
    i: u64,
) -> Scalar {
    Scalar::from_bytes_mod_order_wide(&wide(&[
        tag,
        hedge,
        r,
        value,
        commit,
        transcript,
        &i.to_le_bytes(),
    ]))
}

fn fill_hedge() -> [u8; 32] {
    let mut hedge = [0u8; 32];
    OsRng.fill_bytes(&mut hedge);
    hedge
}

/// Prove C = v·G + r·H and each bit of v is 0 or 1, packed (not v3 bit-OR).
/// The hedge is CSPRNG output. Two calls on one blind do not reuse nonces.
pub fn prove_range(v: u64, r_bytes: &[u8; 32]) -> Option<Vec<u8>> {
    let mut hedge = fill_hedge();
    let proof = prove_range_hedged(v, r_bytes, &hedge);
    hedge.zeroize();
    proof
}

/// Same proof with a caller-supplied hedge. Tests use this to check parity.
/// Production calls [prove_range], which draws the hedge.
pub fn prove_range_hedged(v: u64, r_bytes: &[u8; 32], hedge: &[u8; 32]) -> Option<Vec<u8>> {
    let r = SecretScalar::from_scalar(Scalar::from_bytes_mod_order(*r_bytes));
    let h = h_note();
    let c = G * Scalar::from(v) + h * r.as_scalar();
    let c_b = compress(&c);
    let mut value = v.to_le_bytes();

    let mut bits = [0u8; RANGE_BITS];
    let mut s = Vec::with_capacity(RANGE_BITS);
    let mut b_pts = vec![RistrettoPoint::identity(); RANGE_BITS];
    let mut n = v;
    for i in 0..RANGE_BITS {
        bits[i] = (n & 1) as u8;
        n >>= 1;
        let si = SecretScalar::from_scalar(nonce(
            b"sbit",
            hedge,
            r_bytes,
            &value,
            &c_b,
            b"",
            i as u64,
        ));
        b_pts[i] = G * Scalar::from(bits[i] as u64) + h * si.as_scalar();
        s.push(si);
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
    let mut transcript = Vec::with_capacity(RANGE_BITS * 32);
    for row in &b_bytes {
        transcript.extend_from_slice(row);
    }

    let mut s_sum = SecretScalar::from_scalar(Scalar::ZERO);
    let mut two = Scalar::ONE;
    for i in 0..RANGE_BITS {
        let b = bits[i] == 1;
        let bi = b_pts[i];
        let si = s[i].as_scalar();
        let p0 = bi;
        let p1 = bi - G;
        let real = if b { p1 } else { p0 };
        let fake = if b { p0 } else { p1 };
        let e_fake = SecretScalar::from_scalar(nonce(
            b"efake", hedge, r_bytes, &value, &c_b, &transcript, i as u64,
        ));
        let z_fake = SecretScalar::from_scalar(nonce(
            b"zfake", hedge, r_bytes, &value, &c_b, &transcript, i as u64,
        ));
        let r_fake = h * z_fake.as_scalar() - fake * e_fake.as_scalar();
        let k = SecretScalar::from_scalar(nonce(
            b"kbit", hedge, r_bytes, &value, &c_b, &transcript, i as u64,
        ));
        let r_real = h * k.as_scalar();
        let r0 = if b { r_fake } else { r_real };
        let r1 = if b { r_real } else { r_fake };
        let e = chal(&[
            b"bit",
            &compress(&bi),
            &compress(&r0),
            &compress(&r1),
            &e_all.to_bytes(),
        ]);
        let e_real = SecretScalar::from_scalar(e - e_fake.as_scalar());
        let z_real = SecretScalar::from_scalar(k.as_scalar() + e_real.as_scalar() * si);
        let e0 = if b { e_fake.as_scalar() } else { e_real.as_scalar() };
        let e1 = if b { e_real.as_scalar() } else { e_fake.as_scalar() };
        let z0 = if b { z_fake.as_scalar() } else { z_real.as_scalar() };
        let z1 = if b { z_real.as_scalar() } else { z_fake.as_scalar() };
        out.extend_from_slice(&compress(&r0));
        out.extend_from_slice(&compress(&r1));
        out.extend_from_slice(&e0.to_bytes());
        out.extend_from_slice(&e1.to_bytes());
        out.extend_from_slice(&z0.to_bytes());
        out.extend_from_slice(&z1.to_bytes());
        s_sum = SecretScalar::from_scalar(s_sum.as_scalar() + two * si);
        two += two;
    }
    let r_delta = SecretScalar::from_scalar(r.as_scalar() - s_sum.as_scalar());
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
    let k = SecretScalar::from_scalar(nonce(
        b"cons", hedge, r_bytes, &value, &c_b, &transcript, 0,
    ));
    let r_pt = h * k.as_scalar();
    let e = chal(&[b"cons", &c_b, &compress(&p), &compress(&r_pt)]);
    let z = SecretScalar::from_scalar(k.as_scalar() + e * r_delta.as_scalar());
    out.extend_from_slice(&compress(&r_pt));
    out.extend_from_slice(&z.as_scalar().to_bytes());
    bits.zeroize();
    value.zeroize();
    Some(out)
}

pub fn verify_range(c_bytes: &[u8; 32], proof: &[u8]) -> bool {
    if proof.is_empty() || proof[0] != 2 {
        return false;
    }
    let need = 1 + 32 + RANGE_BITS * 32 + RANGE_BITS * 192 + 64;
    // Exact length. A shorter proof is truncated. Trailing bytes are malleable.
    if proof.len() != need {
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
        let e0 = match scalar_canonical(e0b) {
            Some(s) => s,
            None => return false,
        };
        let e1 = match scalar_canonical(e1b) {
            Some(s) => s,
            None => return false,
        };
        let z0 = match scalar_canonical(z0b) {
            Some(s) => s,
            None => return false,
        };
        let z1 = match scalar_canonical(z1b) {
            Some(s) => s,
            None => return false,
        };
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
    let z = match scalar_canonical(zb) {
        Some(s) => s,
        None => return false,
    };
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
            let again = prove_range(v, &r.to_bytes()).unwrap();
            assert_ne!(p, again, "a fresh hedge makes a second proof differ");
            assert!(verify_range(&c.compress().to_bytes(), &p), "v={v}");
            assert!(verify_range(&c.compress().to_bytes(), &again), "v={v}");
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

    fn bit_r0(proof: &[u8], bit: usize) -> &[u8] {
        let off = 1 + 32 + RANGE_BITS * 32 + bit * 192;
        &proof[off..off + 32]
    }

    #[test]
    fn two_proofs_on_one_blind_do_not_reuse_nonces() {
        let r = Scalar::from(7u64);
        let rb = r.to_bytes();
        let hedge = [9u8; 32];
        let h = h_note();
        let zero = prove_range_hedged(0, &rb, &hedge).unwrap();
        let one = prove_range_hedged(1, &rb, &hedge).unwrap();
        let again = prove_range_hedged(0, &rb, &hedge).unwrap();
        assert_eq!(zero, again, "the same hedge is the same proof");
        assert_ne!(bit_r0(&zero, 0), bit_r0(&one, 0), "bit 0 nonce");
        assert_ne!(bit_r0(&zero, 3), bit_r0(&one, 3), "shared bit nonce");
        let c0 = (G * Scalar::from(0u64) + h * r).compress().to_bytes();
        let c1 = (G * Scalar::from(1u64) + h * r).compress().to_bytes();
        assert!(verify_range(&c0, &zero));
        assert!(verify_range(&c1, &one));
        let fresh = prove_range(0, &rb).unwrap();
        let other = prove_range(0, &rb).unwrap();
        assert_ne!(fresh, other, "CSPRNG hedge");
        assert_ne!(bit_r0(&fresh, 0), bit_r0(&other, 0));
    }

    /// L = 2^252 + 27742317777372353535851937790883648493
    fn add_l(bytes: &mut [u8; 32]) {
        const L: [u8; 32] = [
            0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9,
            0xde, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x10,
        ];
        let mut carry = 0u16;
        for i in 0..32 {
            let sum = bytes[i] as u16 + L[i] as u16 + carry;
            bytes[i] = (sum & 0xff) as u8;
            carry = sum >> 8;
        }
        assert_eq!(carry, 0, "s+L overflowed 32 bytes");
    }

    #[test]
    fn exact_length_and_canonical_scalars() {
        let r = Scalar::from(9u64);
        let h = h_note();
        let need = 1 + 32 + RANGE_BITS * 32 + RANGE_BITS * 192 + 64;
        for v in [0u64, 1, 2_000_000_000, u64::MAX] {
            let c = (G * Scalar::from(v) + h * r).compress().to_bytes();
            let p = prove_range(v, &r.to_bytes()).unwrap();
            assert_eq!(p.len(), need, "v={v}");
            assert!(verify_range(&c, &p), "honest v={v}");
            let mut trail = p.clone();
            trail.push(0);
            assert!(!verify_range(&c, &trail), "trailing v={v}");
            assert!(!verify_range(&c, &p[..p.len() - 1]), "short v={v}");
            let mut z = p.clone();
            let z_at = need - 32;
            let mut zb = [0u8; 32];
            zb.copy_from_slice(&z[z_at..]);
            add_l(&mut zb);
            z[z_at..].copy_from_slice(&zb);
            assert!(!verify_range(&c, &z), "non-canonical z v={v}");
            let mut e0 = p.clone();
            let e0_at = 1 + 32 + RANGE_BITS * 32 + 64;
            let mut eb = [0u8; 32];
            eb.copy_from_slice(&e0[e0_at..e0_at + 32]);
            add_l(&mut eb);
            e0[e0_at..e0_at + 32].copy_from_slice(&eb);
            assert!(!verify_range(&c, &e0), "non-canonical e0 v={v}");
        }
    }
}
