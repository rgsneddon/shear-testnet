//! Curve25519 field and ristretto encode, checked against dalek.
//! Variable-time. The bind circuit is what the verifier trusts.

const MASK51: u64 = (1u64 << 51) - 1;

#[derive(Clone, Copy, Debug)]
pub struct Fe(pub [u64; 5]);

impl PartialEq for Fe {
    fn eq(&self, other: &Self) -> bool {
        self.to_bytes() == other.to_bytes()
    }
}

impl Fe {
    pub const ZERO: Fe = Fe([0; 5]);
    pub const ONE: Fe = Fe([1, 0, 0, 0, 0]);

    pub fn from_bytes(b: &[u8; 32]) -> Fe {
        let load8 = |i: usize| -> u64 {
            (b[i] as u64)
                | ((b[i + 1] as u64) << 8)
                | ((b[i + 2] as u64) << 16)
                | ((b[i + 3] as u64) << 24)
                | ((b[i + 4] as u64) << 32)
                | ((b[i + 5] as u64) << 40)
                | ((b[i + 6] as u64) << 48)
                | ((b[i + 7] as u64) << 56)
        };
        Fe([
            load8(0) & MASK51,
            (load8(6) >> 3) & MASK51,
            (load8(12) >> 6) & MASK51,
            (load8(19) >> 1) & MASK51,
            (load8(24) >> 12) & MASK51,
        ])
    }

    pub fn to_bytes(self) -> [u8; 32] {
        let f = self.carry_full();
        let mut out = [0u8; 32];
        out[0] = f.0[0] as u8;
        out[1] = (f.0[0] >> 8) as u8;
        out[2] = (f.0[0] >> 16) as u8;
        out[3] = (f.0[0] >> 24) as u8;
        out[4] = (f.0[0] >> 32) as u8;
        out[5] = (f.0[0] >> 40) as u8;
        out[6] = ((f.0[0] >> 48) | (f.0[1] << 3)) as u8;
        out[7] = (f.0[1] >> 5) as u8;
        out[8] = (f.0[1] >> 13) as u8;
        out[9] = (f.0[1] >> 21) as u8;
        out[10] = (f.0[1] >> 29) as u8;
        out[11] = (f.0[1] >> 37) as u8;
        out[12] = ((f.0[1] >> 45) | (f.0[2] << 6)) as u8;
        out[13] = (f.0[2] >> 2) as u8;
        out[14] = (f.0[2] >> 10) as u8;
        out[15] = (f.0[2] >> 18) as u8;
        out[16] = (f.0[2] >> 26) as u8;
        out[17] = (f.0[2] >> 34) as u8;
        out[18] = (f.0[2] >> 42) as u8;
        out[19] = ((f.0[2] >> 50) | (f.0[3] << 1)) as u8;
        out[20] = (f.0[3] >> 7) as u8;
        out[21] = (f.0[3] >> 15) as u8;
        out[22] = (f.0[3] >> 23) as u8;
        out[23] = (f.0[3] >> 31) as u8;
        out[24] = (f.0[3] >> 39) as u8;
        out[25] = ((f.0[3] >> 47) | (f.0[4] << 4)) as u8;
        out[26] = (f.0[4] >> 4) as u8;
        out[27] = (f.0[4] >> 12) as u8;
        out[28] = (f.0[4] >> 20) as u8;
        out[29] = (f.0[4] >> 28) as u8;
        out[30] = (f.0[4] >> 36) as u8;
        out[31] = (f.0[4] >> 44) as u8;
        out
    }

    pub fn is_negative(self) -> bool {
        (self.to_bytes()[0] & 1) == 1
    }

    pub fn is_zero(self) -> bool {
        self.to_bytes() == [0u8; 32]
    }

    fn carry(self) -> Fe {
        let mut l = self.0;
        for _ in 0..2 {
            let mut c = l[0] >> 51;
            l[1] += c;
            l[0] &= MASK51;
            c = l[1] >> 51;
            l[2] += c;
            l[1] &= MASK51;
            c = l[2] >> 51;
            l[3] += c;
            l[2] &= MASK51;
            c = l[3] >> 51;
            l[4] += c;
            l[3] &= MASK51;
            c = l[4] >> 51;
            l[0] += c * 19;
            l[4] &= MASK51;
        }
        let c = l[0] >> 51;
        l[1] += c;
        l[0] &= MASK51;
        Fe(l)
    }

    /// Canonical representative in `0..p`, matching dalek's byte encoding.
    pub fn carry_full(self) -> Fe {
        let mut limbs = self.carry().0;
        // q = 1 iff limbs >= p iff limbs + 19 >= 2^255.
        let mut q = (limbs[0] + 19) >> 51;
        q = (limbs[1] + q) >> 51;
        q = (limbs[2] + q) >> 51;
        q = (limbs[3] + q) >> 51;
        q = (limbs[4] + q) >> 51;
        limbs[0] += 19 * q;
        let mut c = limbs[0] >> 51;
        limbs[0] &= MASK51;
        limbs[1] += c;
        c = limbs[1] >> 51;
        limbs[1] &= MASK51;
        limbs[2] += c;
        c = limbs[2] >> 51;
        limbs[2] &= MASK51;
        limbs[3] += c;
        c = limbs[3] >> 51;
        limbs[3] &= MASK51;
        limbs[4] += c;
        limbs[4] &= MASK51;
        Fe(limbs)
    }

    pub fn add(self, o: Fe) -> Fe {
        Fe([
            self.0[0] + o.0[0],
            self.0[1] + o.0[1],
            self.0[2] + o.0[2],
            self.0[3] + o.0[3],
            self.0[4] + o.0[4],
        ])
        .carry()
    }

    pub fn sub(self, o: Fe) -> Fe {
        // Add a multiple of p so the subtraction stays non-negative.
        let p2 = [
            (MASK51 - 18) * 2,
            MASK51 * 2,
            MASK51 * 2,
            MASK51 * 2,
            MASK51 * 2,
        ];
        Fe([
            self.0[0] + p2[0] - o.0[0],
            self.0[1] + p2[1] - o.0[1],
            self.0[2] + p2[2] - o.0[2],
            self.0[3] + p2[3] - o.0[3],
            self.0[4] + p2[4] - o.0[4],
        ])
        .carry_full()
    }

    pub fn neg(self) -> Fe {
        Fe::ZERO.sub(self)
    }

    pub fn mul(self, o: Fe) -> Fe {
        let a = self.carry().0;
        let b = o.carry().0;
        let mut t = [0u128; 5];
        for i in 0..5 {
            for j in 0..5 {
                let k = i + j;
                let limb = k % 5;
                let factor: u128 = if k >= 5 { 19 } else { 1 };
                t[limb] += (a[i] as u128) * (b[j] as u128) * factor;
            }
        }
        let mut wide = t;
        for _ in 0..3 {
            let mut carry = 0u128;
            let mut n = [0u128; 5];
            for i in 0..5 {
                let cur = wide[i] + carry;
                n[i] = cur & (MASK51 as u128);
                carry = cur >> 51;
            }
            n[0] += carry * 19;
            wide = n;
        }
        Fe([
            wide[0] as u64,
            wide[1] as u64,
            wide[2] as u64,
            wide[3] as u64,
            wide[4] as u64,
        ])
        .carry_full()
    }

    pub fn square(self) -> Fe {
        self.mul(self)
    }

    pub fn pow(self, exp: &[u8; 32]) -> Fe {
        let mut acc = Fe::ONE;
        for byte_i in (0..32).rev() {
            for bit in (0..8).rev() {
                acc = acc.square();
                if ((exp[byte_i] >> bit) & 1) == 1 {
                    acc = acc.mul(self);
                }
            }
        }
        acc
    }

    pub fn invert(self) -> Fe {
        // p - 2 = 2^255 - 21
        let mut e = [0xffu8; 32];
        e[0] = 0xff - 20; // 256-21 = 235? Wait, do this properly below.
        let _ = e;
        // exponent bytes of p-2, little-endian.
        // p-2 = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeb
        let exp: [u8; 32] = [
            0xeb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
        ];
        self.pow(&exp)
    }

    /// Nonnegative invsqrt, matching dalek's `FieldElement::invsqrt` on success.
    pub fn invsqrt(self) -> (bool, Fe) {
        // sqrt_ratio_i(1, self)
        self.sqrt_ratio(Fe::ONE)
    }

    fn pow_p58(self) -> Fe {
        // (p-5)/8 = 2^252 - 3
        // LE bytes of 2^252 - 3.
        let mut exp = [0xffu8; 32];
        exp[0] = 0xfd; // -3
        exp[31] = 0x0f; // 2^252 sits at bit 252 = byte 31 bit 4, so low nibble of top byte is 0x0f after the -3 borrow? 
        // 2^252 in LE: byte 31 = 0x10, lower bytes 0. Minus 3 borrows.
        // 2^252 - 3 = bytes: FD FF FF ... FF 0F, with byte 31 = 0x0f.
        exp[31] = 0x0f;
        self.pow(&exp)
    }

    fn sqrt_ratio(self, u: Fe) -> (bool, Fe) {
        // r = (u v^3) (u v^7)^((p-5)/8), v = self
        let v = self;
        let v3 = v.square().mul(v);
        let v7 = v3.square().mul(v);
        let mut r = u.mul(v3).mul(u.mul(v7).pow_p58());
        let check = v.mul(r.square());
        let i = sqrt_m1();
        let neg_u = u.neg();
        let ok = check == u || check == neg_u;
        if check == neg_u || check == neg_u.mul(i) {
            r = r.mul(i);
        }
        if r.is_negative() {
            r = r.neg();
        }
        (ok || u.is_zero(), r)
    }
}

pub fn sqrt_m1() -> Fe {
    // 2^((p-1)/4) mod p. Computed once from a known constant.
    // dalek SQRT_M1 bytes (canonical), from the curve25519-dalek test that SQRT_M1^2 = -1.
    // We derive it as 2^((p-1)/4).
    Fe::from_bytes(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).pow(&{
        // (p-1)/4 = 2^253 - 5
        let mut e = [0xffu8; 32];
        e[0] = 0xfb;
        e[31] = 0x1f;
        e
    })
}

pub fn edwards_d() -> Fe {
    // d = -121665 * inv(121666)
    let a = fe_from_u64(121665);
    let b = fe_from_u64(121666);
    a.neg().mul(b.invert())
}

pub fn fe_from_u64(x: u64) -> Fe {
    let mut b = [0u8; 32];
    b[..8].copy_from_slice(&x.to_le_bytes());
    Fe::from_bytes(&b)
}

#[derive(Clone, Copy, Debug)]
pub struct Ed {
    pub x: Fe,
    pub y: Fe,
    pub z: Fe,
    pub t: Fe,
}

impl Ed {
    pub fn add(self, o: Ed) -> Ed {
        let d = edwards_d();
        let a = self.x.mul(o.x);
        let b = self.y.mul(o.y);
        let c = self.t.mul(d).mul(o.t);
        let dd = self.z.mul(o.z);
        let e = self.x.add(self.y).mul(o.x.add(o.y)).sub(a).sub(b);
        let f = dd.sub(c);
        let g = dd.add(c);
        let h = b.add(a);
        Ed {
            x: e.mul(f),
            y: g.mul(h),
            t: e.mul(h),
            z: f.mul(g),
        }
    }

    pub fn double(self) -> Ed {
        self.add(self)
    }

    pub fn identity() -> Ed {
        Ed {
            x: Fe::ZERO,
            y: Fe::ONE,
            z: Fe::ONE,
            t: Fe::ZERO,
        }
    }

    /// Ristretto compress. Returns canonical 32 bytes.
    pub fn ristretto_compress(self) -> [u8; 32] {
        let x = self.x;
        let y = self.y;
        let z = self.z;
        let t = self.t;
        let u1 = z.add(y).mul(z.sub(y));
        let u2 = x.mul(y);
        let (_, invsqrt) = u1.mul(u2.square()).invsqrt();
        let i1 = invsqrt.mul(u1);
        let i2 = invsqrt.mul(u2);
        let z_inv = i1.mul(i2.mul(t));
        let mut den_inv = i2;
        let i_x = x.mul(sqrt_m1());
        let i_y = y.mul(sqrt_m1());
        let magic = invsqrt_a_minus_d();
        let enchanted = i1.mul(magic);
        let rotate = t.mul(z_inv).is_negative();
        let (x, y, den_inv) = if rotate {
            (i_y, i_x, enchanted)
        } else {
            (x, y, den_inv)
        };
        let y = if x.mul(z_inv).is_negative() { y.neg() } else { y };
        let mut s = den_inv.mul(z.sub(y));
        if s.is_negative() {
            s = s.neg();
        }
        s.to_bytes()
    }
}

fn invsqrt_a_minus_d() -> Fe {
    // 1/sqrt(a-d) with a = -1, so 1/sqrt(-1 - d).
    let a_minus_d = Fe::ONE.neg().sub(edwards_d());
    let (ok, s) = a_minus_d.invsqrt();
    assert!(ok);
    s
}

/// Decompress a ristretto encoding into extended coordinates (Z = 1).
pub fn ristretto_decompress(b: &[u8; 32]) -> Option<Ed> {
    let s = Fe::from_bytes(b);
    if s.to_bytes() != *b || s.is_negative() {
        return None;
    }
    let one = Fe::ONE;
    let ss = s.square();
    let u1 = one.sub(ss);
    let u2 = one.add(ss);
    let u2_sqr = u2.square();
    let v = edwards_d().neg().mul(u1.square()).sub(u2_sqr);
    let (ok, i) = v.mul(u2_sqr).invsqrt();
    if !ok {
        return None;
    }
    let dx = i.mul(u2);
    let dy = i.mul(dx.mul(v));
    let mut x = s.add(s).mul(dx);
    if x.is_negative() {
        x = x.neg();
    }
    let y = u1.mul(dy);
    if y.is_zero() {
        return None;
    }
    let t = x.mul(y);
    if t.is_negative() {
        return None;
    }
    Some(Ed { x, y, z: one, t })
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
    use curve25519_dalek::ristretto::RistrettoPoint;
    use curve25519_dalek::scalar::Scalar;
    use curve25519_dalek::traits::Identity;

    #[test]
    fn dalek_square_vector() {
        let a_bytes: [u8; 32] = [
            0x04, 0xfe, 0xdf, 0x98, 0xa7, 0xfa, 0x0a, 0x68, 0x84, 0x92, 0xbd, 0x59, 0x08, 0x07, 0xa7, 0x03,
            0x9e, 0xd1, 0xf6, 0xf2, 0xe1, 0xd9, 0xe2, 0xa4, 0xa4, 0x51, 0x47, 0x36, 0xf3, 0xc3, 0xa9, 0x17,
        ];
        let asq: [u8; 32] = [
            0x75, 0x97, 0x24, 0x9e, 0xe6, 0x06, 0xfe, 0xab, 0x24, 0x04, 0x56, 0x68, 0x07, 0x91, 0x2d, 0x5d,
            0x0b, 0x0f, 0x3f, 0x1c, 0xb2, 0x6e, 0xf2, 0xe2, 0x63, 0x9c, 0x12, 0xba, 0x73, 0x0b, 0xe3, 0x62,
        ];
        let a = Fe::from_bytes(&a_bytes);
        assert_eq!(a.square().to_bytes(), asq);
        let ainv: [u8; 32] = [
            0x96, 0x1b, 0xcd, 0x8d, 0x4d, 0x5e, 0xa2, 0x3a, 0xe9, 0x36, 0x37, 0x93, 0xdb, 0x7b, 0x4d, 0x70,
            0xb8, 0x0d, 0xc0, 0x55, 0xd0, 0x4c, 0x1d, 0x7b, 0x90, 0x71, 0xd8, 0xe9, 0xb6, 0x18, 0xe6, 0x30,
        ];
        assert_eq!(a.invert().to_bytes(), ainv);
    }

    #[test]
    fn compress_matches_dalek() {
        let mut p = RISTRETTO_BASEPOINT_POINT;
        for i in 0..8u64 {
            let enc = p.compress().to_bytes();
            let ed = ristretto_decompress(&enc).expect("dec");
            assert_eq!(ed.ristretto_compress(), enc, "roundtrip {i}");
            p += RISTRETTO_BASEPOINT_POINT;
        }
        let h = RistrettoPoint::from_uniform_bytes(&[9u8; 64]);
        let enc = h.compress().to_bytes();
        let ed = ristretto_decompress(&enc).expect("h");
        assert_eq!(ed.ristretto_compress(), enc);
    }

    #[test]
    fn add_matches_dalek() {
        let p = RISTRETTO_BASEPOINT_POINT * Scalar::from(5u64);
        let q = RistrettoPoint::from_uniform_bytes(&[4u8; 64]);
        let sum = p + q;
        let ep = ristretto_decompress(&p.compress().to_bytes()).unwrap();
        let eq = ristretto_decompress(&q.compress().to_bytes()).unwrap();
        let es = ep.add(eq).ristretto_compress();
        assert_eq!(es, sum.compress().to_bytes());
        let _ = RistrettoPoint::identity();
    }
}
