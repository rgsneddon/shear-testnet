/*
 * Miner-side check of a pool-issued T21 share label: E = lambda*G + beta*H
 * on ristretto255, and the job's note commit is the share bind of E.
 * Variable time: lambda is the miner's public voucher label, beta and E come
 * from the pool, and nothing here is secret.
 */
#include "t21_label.h"
#include "sha256.h"
#include <stdint.h>
#include <string.h>

typedef uint64_t fe[5];
typedef unsigned __int128 u128;
#define MASK51 ((uint64_t)0x7ffffffffffff)

static const unsigned char P_MINUS_2[32] = {
  0xeb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f };
static const unsigned char P_MINUS_5_DIV_8[32] = {
  0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f };
static const unsigned char P_MINUS_1_DIV_4[32] = {
  0xfb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f };
static const unsigned char BASE_G[32] = {
  0xe2, 0xf2, 0xae, 0x0a, 0x6a, 0xbc, 0x4e, 0x71, 0xa8, 0x84, 0xa9, 0x61, 0xc5, 0x00, 0x51, 0x5f,
  0x58, 0xe3, 0x0b, 0x6a, 0xa5, 0x82, 0xdd, 0x8d, 0xb6, 0xa6, 0x59, 0x45, 0xe0, 0x8d, 0x2d, 0x76 };
/* crypto/note.js H (GEN_H). */
static const unsigned char GEN_H[32] = {
  0xfe, 0xea, 0x29, 0x14, 0xbd, 0xa9, 0x37, 0xd7, 0x4a, 0xcc, 0x1e, 0xfa, 0x93, 0xbf, 0x10, 0x94,
  0xf6, 0x5a, 0xe7, 0x09, 0x62, 0x8a, 0x7a, 0xad, 0x9d, 0x1b, 0x91, 0x3b, 0x6c, 0x80, 0xc3, 0x01 };
static const char SHARE_BIND_DOM[] = "shear-share-bind-v1";

static uint64_t load64(const unsigned char *s) {
  uint64_t r = 0;
  for (int i = 7; i >= 0; i--) r = (r << 8) | s[i];
  return r;
}

static void fe_small(fe h, uint64_t n) { h[0] = n; h[1] = h[2] = h[3] = h[4] = 0; }
static void fe_copy(fe h, const fe f) { memcpy(h, f, sizeof(fe)); }

static void fe_carry(fe h) {
  uint64_t c;
  c = h[0] >> 51; h[0] &= MASK51; h[1] += c;
  c = h[1] >> 51; h[1] &= MASK51; h[2] += c;
  c = h[2] >> 51; h[2] &= MASK51; h[3] += c;
  c = h[3] >> 51; h[3] &= MASK51; h[4] += c;
  c = h[4] >> 51; h[4] &= MASK51; h[0] += 19 * c;
}

static void fe_frombytes(fe h, const unsigned char s[32]) {
  h[0] = load64(s) & MASK51;
  h[1] = (load64(s + 6) >> 3) & MASK51;
  h[2] = (load64(s + 12) >> 6) & MASK51;
  h[3] = (load64(s + 19) >> 1) & MASK51;
  h[4] = (load64(s + 24) >> 12) & MASK51;
}

static void fe_tobytes(unsigned char s[32], const fe f) {
  fe h;
  fe_copy(h, f);
  fe_carry(h);
  fe_carry(h);
  uint64_t q = (h[0] + 19) >> 51;
  q = (h[1] + q) >> 51;
  q = (h[2] + q) >> 51;
  q = (h[3] + q) >> 51;
  q = (h[4] + q) >> 51;
  h[0] += 19 * q;
  uint64_t c;
  c = h[0] >> 51; h[0] &= MASK51; h[1] += c;
  c = h[1] >> 51; h[1] &= MASK51; h[2] += c;
  c = h[2] >> 51; h[2] &= MASK51; h[3] += c;
  c = h[3] >> 51; h[3] &= MASK51; h[4] += c;
  h[4] &= MASK51;
  uint64_t w[4] = {
    h[0] | (h[1] << 51),
    (h[1] >> 13) | (h[2] << 38),
    (h[2] >> 26) | (h[3] << 25),
    (h[3] >> 39) | (h[4] << 12),
  };
  for (int i = 0; i < 4; i++)
    for (int j = 0; j < 8; j++) s[8 * i + j] = (unsigned char)(w[i] >> (8 * j));
}

static void fe_add(fe h, const fe f, const fe g) {
  for (int i = 0; i < 5; i++) h[i] = f[i] + g[i];
  fe_carry(h);
}

/* f + 4p - g; inputs carried (limbs < 2^52). */
static void fe_sub(fe h, const fe f, const fe g) {
  h[0] = f[0] + 0x1fffffffffffb4ULL - g[0];
  for (int i = 1; i < 5; i++) h[i] = f[i] + 0x1ffffffffffffcULL - g[i];
  fe_carry(h);
}

static void fe_neg(fe h, const fe f) {
  fe z;
  fe_small(z, 0);
  fe_sub(h, z, f);
}

static void fe_mul(fe h, const fe f, const fe g) {
  uint64_t f0 = f[0], f1 = f[1], f2 = f[2], f3 = f[3], f4 = f[4];
  uint64_t g0 = g[0], g1 = g[1], g2 = g[2], g3 = g[3], g4 = g[4];
  uint64_t g1_19 = 19 * g1, g2_19 = 19 * g2, g3_19 = 19 * g3, g4_19 = 19 * g4;
  u128 r0 = (u128)f0 * g0 + (u128)f1 * g4_19 + (u128)f2 * g3_19 + (u128)f3 * g2_19 + (u128)f4 * g1_19;
  u128 r1 = (u128)f0 * g1 + (u128)f1 * g0 + (u128)f2 * g4_19 + (u128)f3 * g3_19 + (u128)f4 * g2_19;
  u128 r2 = (u128)f0 * g2 + (u128)f1 * g1 + (u128)f2 * g0 + (u128)f3 * g4_19 + (u128)f4 * g3_19;
  u128 r3 = (u128)f0 * g3 + (u128)f1 * g2 + (u128)f2 * g1 + (u128)f3 * g0 + (u128)f4 * g4_19;
  u128 r4 = (u128)f0 * g4 + (u128)f1 * g3 + (u128)f2 * g2 + (u128)f3 * g1 + (u128)f4 * g0;
  r1 += (uint64_t)(r0 >> 51); h[0] = (uint64_t)r0 & MASK51;
  r2 += (uint64_t)(r1 >> 51); h[1] = (uint64_t)r1 & MASK51;
  r3 += (uint64_t)(r2 >> 51); h[2] = (uint64_t)r2 & MASK51;
  r4 += (uint64_t)(r3 >> 51); h[3] = (uint64_t)r3 & MASK51;
  uint64_t c = (uint64_t)(r4 >> 51); h[4] = (uint64_t)r4 & MASK51;
  h[0] += 19 * c;
  c = h[0] >> 51; h[0] &= MASK51; h[1] += c;
}

static void fe_sq(fe h, const fe f) { fe_mul(h, f, f); }

static void fe_pow(fe out, const fe z, const unsigned char e[32]) {
  fe r, b;
  fe_small(r, 1);
  fe_copy(b, z);
  for (int i = 255; i >= 0; i--) {
    fe_sq(r, r);
    if ((e[i >> 3] >> (i & 7)) & 1) fe_mul(r, r, b);
  }
  fe_copy(out, r);
}

static int fe_isneg(const fe f) {
  unsigned char s[32];
  fe_tobytes(s, f);
  return s[0] & 1;
}

static int fe_iszero(const fe f) {
  unsigned char s[32], z[32] = {0};
  fe_tobytes(s, f);
  return memcmp(s, z, 32) == 0;
}

static int fe_eq(const fe f, const fe g) {
  unsigned char a[32], b[32];
  fe_tobytes(a, f);
  fe_tobytes(b, g);
  return memcmp(a, b, 32) == 0;
}

static void fe_abs(fe h, const fe f) {
  if (fe_isneg(f)) fe_neg(h, f);
  else fe_copy(h, f);
}

static fe C_D, C_D2, C_SQRT_M1, C_INVSQRT_A_MINUS_D;
static int g_consts;

static int sqrt_ratio_m1(fe r, const fe u, const fe v);

static void init_consts(void) {
  if (g_consts) return;
  fe a, b;
  fe_small(a, 121666);
  fe_pow(b, a, P_MINUS_2);
  fe_small(a, 121665);
  fe_mul(b, b, a);
  fe_neg(C_D, b);
  fe_add(C_D2, C_D, C_D);
  fe_small(a, 2);
  fe_pow(b, a, P_MINUS_1_DIV_4);
  fe_abs(C_SQRT_M1, b);
  fe one, amd;
  fe_small(one, 1);
  fe_neg(a, one);
  fe_sub(amd, a, C_D);
  sqrt_ratio_m1(C_INVSQRT_A_MINUS_D, one, amd);
  g_consts = 1;
}

/* r = sqrt(u/v) when it exists (non-negative); returns 1 then. */
static int sqrt_ratio_m1(fe r, const fe u, const fe v) {
  fe v3, v7, t, check, nu, nui;
  fe_sq(v3, v);
  fe_mul(v3, v3, v);
  fe_sq(v7, v3);
  fe_mul(v7, v7, v);
  fe_mul(t, u, v7);
  fe_pow(t, t, P_MINUS_5_DIV_8);
  fe_mul(t, t, u);
  fe_mul(t, t, v3);
  fe_sq(check, t);
  fe_mul(check, check, v);
  fe_neg(nu, u);
  fe_mul(nui, nu, C_SQRT_M1);
  int correct = fe_eq(check, u);
  int flipped = fe_eq(check, nu);
  int flipped_i = fe_eq(check, nui);
  if (flipped || flipped_i) fe_mul(t, t, C_SQRT_M1);
  fe_abs(r, t);
  return correct || flipped;
}

typedef struct { fe X, Y, Z, T; } ge;

static void ge_identity(ge *p) {
  fe_small(p->X, 0);
  fe_small(p->Y, 1);
  fe_small(p->Z, 1);
  fe_small(p->T, 0);
}

static void ge_add(ge *r, const ge *p, const ge *q) {
  fe a, b, c, d, e, f, g, h, t;
  fe_sub(a, p->Y, p->X);
  fe_sub(t, q->Y, q->X);
  fe_mul(a, a, t);
  fe_add(b, p->Y, p->X);
  fe_add(t, q->Y, q->X);
  fe_mul(b, b, t);
  fe_mul(c, p->T, q->T);
  fe_mul(c, c, C_D2);
  fe_mul(d, p->Z, q->Z);
  fe_add(d, d, d);
  fe_sub(e, b, a);
  fe_sub(f, d, c);
  fe_add(g, d, c);
  fe_add(h, b, a);
  fe_mul(r->X, e, f);
  fe_mul(r->Y, g, h);
  fe_mul(r->T, e, h);
  fe_mul(r->Z, f, g);
}

static int ge_decode(ge *p, const unsigned char in[32]) {
  fe s, ss, u1, u2, u2sq, v, t, inv, dx, dy, one;
  unsigned char back[32];
  fe_frombytes(s, in);
  fe_tobytes(back, s);
  if (memcmp(back, in, 32) != 0 || fe_isneg(s)) return -1;
  fe_small(one, 1);
  fe_sq(ss, s);
  fe_sub(u1, one, ss);
  fe_add(u2, one, ss);
  fe_sq(u2sq, u2);
  fe_sq(t, u1);
  fe_mul(t, t, C_D);
  fe_neg(t, t);
  fe_sub(v, t, u2sq);
  fe_mul(t, v, u2sq);
  int ok = sqrt_ratio_m1(inv, one, t);
  fe_mul(dx, inv, u2);
  fe_mul(dy, inv, dx);
  fe_mul(dy, dy, v);
  fe_add(t, s, s);
  fe_mul(t, t, dx);
  fe_abs(p->X, t);
  fe_mul(p->Y, u1, dy);
  fe_small(p->Z, 1);
  fe_mul(p->T, p->X, p->Y);
  if (!ok || fe_isneg(p->T) || fe_iszero(p->Y)) return -1;
  return 0;
}

static void ge_encode(unsigned char out[32], const ge *p) {
  fe u1, u2, t, inv, den1, den2, zinv, ix, iy, ench, x, y, dinv, one;
  fe_small(one, 1);
  fe_add(t, p->Z, p->Y);
  fe_sub(u1, p->Z, p->Y);
  fe_mul(u1, u1, t);
  fe_mul(u2, p->X, p->Y);
  fe_sq(t, u2);
  fe_mul(t, t, u1);
  sqrt_ratio_m1(inv, one, t);
  fe_mul(den1, inv, u1);
  fe_mul(den2, inv, u2);
  fe_mul(zinv, den1, den2);
  fe_mul(zinv, zinv, p->T);
  fe_mul(ix, p->X, C_SQRT_M1);
  fe_mul(iy, p->Y, C_SQRT_M1);
  fe_mul(ench, den1, C_INVSQRT_A_MINUS_D);
  fe_mul(t, p->T, zinv);
  if (fe_isneg(t)) {
    fe_copy(x, iy);
    fe_copy(y, ix);
    fe_copy(dinv, ench);
  } else {
    fe_copy(x, p->X);
    fe_copy(y, p->Y);
    fe_copy(dinv, den2);
  }
  fe_mul(t, x, zinv);
  if (fe_isneg(t)) fe_neg(y, y);
  fe_sub(t, p->Z, y);
  fe_mul(t, t, dinv);
  fe_abs(t, t);
  fe_tobytes(out, t);
}

static void ge_mul(ge *r, const ge *p, const unsigned char k[32]) {
  ge acc;
  ge_identity(&acc);
  for (int i = 255; i >= 0; i--) {
    ge_add(&acc, &acc, &acc);
    if ((k[i >> 3] >> (i & 7)) & 1) ge_add(&acc, &acc, p);
  }
  *r = acc;
}

int t21_label_point(const unsigned char a[32], const unsigned char b[32], unsigned char out[32]) {
  init_consts();
  ge G, H, aG, bH, sum;
  if (ge_decode(&G, BASE_G) != 0 || ge_decode(&H, GEN_H) != 0) return -1;
  ge_mul(&aG, &G, a);
  ge_mul(&bH, &H, b);
  ge_add(&sum, &aG, &bH);
  ge_encode(out, &sum);
  return 0;
}

int t21_label_ok(const unsigned char lambda[32], const unsigned char beta[32],
                 const unsigned char E[32], const unsigned char note[32], const char *magic) {
  unsigned char want[32], nc[32], buf[256];
  ge probe;
  init_consts();
  if (ge_decode(&probe, E) != 0) return 0;
  if (t21_label_point(lambda, beta, want) != 0 || memcmp(want, E, 32) != 0) return 0;
  size_t dl = sizeof(SHARE_BIND_DOM) - 1, ml = strlen(magic);
  if (dl + ml + 32 > sizeof(buf)) return 0;
  memcpy(buf, SHARE_BIND_DOM, dl);
  memcpy(buf + dl, magic, ml);
  memcpy(buf + dl + ml, E, 32);
  shear_sha256(buf, dl + ml + 32, nc);
  return memcmp(nc, note, 32) == 0;
}
