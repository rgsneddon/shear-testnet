/*
 * SHA-256 scalar kernel for GNFPHash.
 * Default translation unit must stay ymm-free. AVX2 is sha256_avx2.c
 * (GNFP_ALLOW_AVX2). SHA-NI is sha256_ni.c. Do not pass -mavx2 here
 * (that SIGILL/voltage path is 1.1.2).
 */
#include "sha256.h"

#include <string.h>

#if defined(__AVX2__) && !defined(GNFP_ALLOW_AVX2)
#error "shear-miner 0.1.4 default sha256.c is scalar-only. Do not pass -mavx2 (that SIGILL/voltage path is 1.1.2). AVX2 lives in sha256_avx2.c."
#endif

static const uint32_t K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
    0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
    0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
    0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
    0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static const uint32_t IV[8] = {
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
};

#if defined(__clang__)
#define ROTR32(x, n) __builtin_rotateright32((uint32_t)(x), (n))
#else
#define ROTR32(x, n) (((uint32_t)(x) >> (n)) | ((uint32_t)(x) << (32 - (n))))
#endif

#define Ch(x, y, z) (((x) & (y)) ^ (~(x) & (z)))
#define Maj(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define SIG0(x) (ROTR32((x), 2) ^ ROTR32((x), 13) ^ ROTR32((x), 22))
#define SIG1(x) (ROTR32((x), 6) ^ ROTR32((x), 11) ^ ROTR32((x), 25))
#define sig0(x) (ROTR32((x), 7) ^ ROTR32((x), 18) ^ ((uint32_t)(x) >> 3))
#define sig1(x) (ROTR32((x), 17) ^ ROTR32((x), 19) ^ ((uint32_t)(x) >> 10))

static inline uint32_t load_be32(const uint8_t *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static inline void store_be32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v >> 24);
  p[1] = (uint8_t)(v >> 16);
  p[2] = (uint8_t)(v >> 8);
  p[3] = (uint8_t)v;
}

void sha256_init(uint32_t state[8]) {
  memcpy(state, IV, sizeof(IV));
}

void sha256_compress_scalar(uint32_t state[8], const uint8_t block[64]) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) w[i] = load_be32(block + 4 * i);
  for (int i = 16; i < 64; i++) {
    w[i] = sig1(w[i - 2]) + w[i - 7] + sig0(w[i - 15]) + w[i - 16];
  }
  uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = h + SIG1(e) + Ch(e, f, g) + K[i] + w[i];
    uint32_t t2 = SIG0(a) + Maj(a, b, c);
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

void sha256_finish(uint32_t state[8], const uint8_t *rest, size_t rest_len, size_t total_len,
                   uint8_t out[32]) {
  uint8_t tail[128];
  memset(tail, 0, sizeof(tail));
  if (rest_len) memcpy(tail, rest, rest_len);
  tail[rest_len] = 0x80;
  size_t pad_blocks = (rest_len + 1 + 8 <= 64) ? 1 : 2;
  uint64_t bits = (uint64_t)total_len * 8ull;
  size_t off = pad_blocks * 64 - 8;
  for (int b = 7; b >= 0; b--) {
    tail[off + (size_t)(7 - b)] = (uint8_t)(bits >> (b * 8));
  }
  sha256_compress(state, tail);
  if (pad_blocks == 2) sha256_compress(state, tail + 64);
  for (int j = 0; j < 8; j++) store_be32(out + 4 * j, state[j]);
}

void sha256_oneshot_scalar(const uint8_t *data, size_t len, uint8_t out[32]) {
  uint32_t state[8];
  sha256_init(state);
  size_t i = 0;
  for (; i + 64 <= len; i += 64) sha256_compress_scalar(state, data + i);
  uint8_t tail[128];
  memset(tail, 0, sizeof(tail));
  size_t rem = len - i;
  if (rem) memcpy(tail, data + i, rem);
  tail[rem] = 0x80;
  size_t pad_blocks = (rem + 1 + 8 <= 64) ? 1 : 2;
  uint64_t bits = (uint64_t)len * 8ull;
  size_t off = pad_blocks * 64 - 8;
  for (int b = 7; b >= 0; b--) {
    tail[off + (size_t)(7 - b)] = (uint8_t)(bits >> (b * 8));
  }
  sha256_compress_scalar(state, tail);
  if (pad_blocks == 2) sha256_compress_scalar(state, tail + 64);
  for (int j = 0; j < 8; j++) store_be32(out + 4 * j, state[j]);
}

void sha256_oneshot_x8_scalar(const uint8_t *const data[8], size_t len, uint8_t out[8][32]) {
  for (int lane = 0; lane < 8; lane++) sha256_oneshot_scalar(data[lane], len, out[lane]);
}
