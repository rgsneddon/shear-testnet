/*
 * AVX2 8-way SHA-256. Compile this file only with -mavx2 -DGNFP_ALLOW_AVX2.
 * Dispatch calls this only after CPUID AVX2 + OSXSAVE + XMM/YMM. No scalar
 * fallback in this object (that would reintroduce 1.1.2 ymm in a mixed TU).
 */
#include "sha256.h"

#include <immintrin.h>
#include <string.h>

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

static inline uint32_t load_be32(const uint8_t *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static inline void store_be32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v >> 24);
  p[1] = (uint8_t)(v >> 16);
  p[2] = (uint8_t)(v >> 8);
  p[3] = (uint8_t)v;
}

static inline __m256i vrotr32(__m256i x, int n) {
  return _mm256_or_si256(_mm256_srli_epi32(x, n), _mm256_slli_epi32(x, 32 - n));
}

static inline __m256i vch(__m256i x, __m256i y, __m256i z) {
  return _mm256_xor_si256(_mm256_and_si256(x, y), _mm256_andnot_si256(x, z));
}

static inline __m256i vmaj(__m256i x, __m256i y, __m256i z) {
  return _mm256_or_si256(_mm256_and_si256(x, y),
                         _mm256_and_si256(z, _mm256_or_si256(x, y)));
}

static inline __m256i vsig0(__m256i x) {
  return _mm256_xor_si256(vrotr32(x, 2), _mm256_xor_si256(vrotr32(x, 13), vrotr32(x, 22)));
}

static inline __m256i vsig1(__m256i x) {
  return _mm256_xor_si256(vrotr32(x, 6), _mm256_xor_si256(vrotr32(x, 11), vrotr32(x, 25)));
}

static inline __m256i vsmall0(__m256i x) {
  return _mm256_xor_si256(vrotr32(x, 7), _mm256_xor_si256(vrotr32(x, 18), _mm256_srli_epi32(x, 3)));
}

static inline __m256i vsmall1(__m256i x) {
  return _mm256_xor_si256(vrotr32(x, 17), _mm256_xor_si256(vrotr32(x, 19), _mm256_srli_epi32(x, 10)));
}

#define ROUND8(a, b, c, d, e, f, g, h, k, w)                                 \
  do {                                                                       \
    __m256i t1 = _mm256_add_epi32(h, vsig1(e));                              \
    t1 = _mm256_add_epi32(t1, vch(e, f, g));                                 \
    t1 = _mm256_add_epi32(t1, _mm256_set1_epi32((int)(k)));                   \
    t1 = _mm256_add_epi32(t1, (w));                                           \
    __m256i t2 = _mm256_add_epi32(vsig0(a), vmaj(a, b, c));                   \
    d = _mm256_add_epi32(d, t1);                                              \
    h = _mm256_add_epi32(t1, t2);                                             \
  } while (0)

static void sha256_compress_x8(__m256i s[8], const uint8_t block[8][64]) {
  __m256i w[16];
  for (int i = 0; i < 16; i++) {
    int o = 4 * i;
    w[i] = _mm256_setr_epi32((int)load_be32(block[0] + o), (int)load_be32(block[1] + o),
                             (int)load_be32(block[2] + o), (int)load_be32(block[3] + o),
                             (int)load_be32(block[4] + o), (int)load_be32(block[5] + o),
                             (int)load_be32(block[6] + o), (int)load_be32(block[7] + o));
  }
  __m256i a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];

  ROUND8(a, b, c, d, e, f, g, h, K[0], w[0]);
  ROUND8(h, a, b, c, d, e, f, g, K[1], w[1]);
  ROUND8(g, h, a, b, c, d, e, f, K[2], w[2]);
  ROUND8(f, g, h, a, b, c, d, e, K[3], w[3]);
  ROUND8(e, f, g, h, a, b, c, d, K[4], w[4]);
  ROUND8(d, e, f, g, h, a, b, c, K[5], w[5]);
  ROUND8(c, d, e, f, g, h, a, b, K[6], w[6]);
  ROUND8(b, c, d, e, f, g, h, a, K[7], w[7]);
  ROUND8(a, b, c, d, e, f, g, h, K[8], w[8]);
  ROUND8(h, a, b, c, d, e, f, g, K[9], w[9]);
  ROUND8(g, h, a, b, c, d, e, f, K[10], w[10]);
  ROUND8(f, g, h, a, b, c, d, e, K[11], w[11]);
  ROUND8(e, f, g, h, a, b, c, d, K[12], w[12]);
  ROUND8(d, e, f, g, h, a, b, c, K[13], w[13]);
  ROUND8(c, d, e, f, g, h, a, b, K[14], w[14]);
  ROUND8(b, c, d, e, f, g, h, a, K[15], w[15]);

  for (int i = 16; i < 64; i++) {
    int idx = i & 15;
    __m256i s1 = vsmall1(w[(idx + 14) & 15]);
    __m256i s0 = vsmall0(w[(idx + 1) & 15]);
    w[idx] = _mm256_add_epi32(_mm256_add_epi32(s1, w[(idx + 9) & 15]),
                              _mm256_add_epi32(s0, w[idx]));
    switch (i & 7) {
      case 0: ROUND8(a, b, c, d, e, f, g, h, K[i], w[idx]); break;
      case 1: ROUND8(h, a, b, c, d, e, f, g, K[i], w[idx]); break;
      case 2: ROUND8(g, h, a, b, c, d, e, f, K[i], w[idx]); break;
      case 3: ROUND8(f, g, h, a, b, c, d, e, K[i], w[idx]); break;
      case 4: ROUND8(e, f, g, h, a, b, c, d, K[i], w[idx]); break;
      case 5: ROUND8(d, e, f, g, h, a, b, c, K[i], w[idx]); break;
      case 6: ROUND8(c, d, e, f, g, h, a, b, K[i], w[idx]); break;
      default: ROUND8(b, c, d, e, f, g, h, a, K[i], w[idx]); break;
    }
  }

  s[0] = _mm256_add_epi32(s[0], a);
  s[1] = _mm256_add_epi32(s[1], b);
  s[2] = _mm256_add_epi32(s[2], c);
  s[3] = _mm256_add_epi32(s[3], d);
  s[4] = _mm256_add_epi32(s[4], e);
  s[5] = _mm256_add_epi32(s[5], f);
  s[6] = _mm256_add_epi32(s[6], g);
  s[7] = _mm256_add_epi32(s[7], h);
}

void sha256_oneshot_x8_avx2(const uint8_t *const data[8], size_t len, uint8_t out[8][32]) {
  size_t rem = len & 63u;
  size_t pad_blocks = (rem + 1 + 8 <= 64) ? 1 : 2;
  size_t nfull = len / 64;
  uint8_t tail[8][128];
  memset(tail, 0, sizeof(tail));
  uint64_t bits = (uint64_t)len * 8ull;
  for (int lane = 0; lane < 8; lane++) {
    if (rem) memcpy(tail[lane], data[lane] + nfull * 64, rem);
    tail[lane][rem] = 0x80;
    size_t off = pad_blocks * 64 - 8;
    for (int b = 7; b >= 0; b--) {
      tail[lane][off + (size_t)(7 - b)] = (uint8_t)(bits >> (b * 8));
    }
  }

  __m256i s[8];
  for (int i = 0; i < 8; i++) s[i] = _mm256_set1_epi32((int)IV[i]);

  uint8_t blk[8][64];
  for (size_t bi = 0; bi < nfull; bi++) {
    for (int lane = 0; lane < 8; lane++) memcpy(blk[lane], data[lane] + bi * 64, 64);
    sha256_compress_x8(s, blk);
  }
  for (int lane = 0; lane < 8; lane++) memcpy(blk[lane], tail[lane], 64);
  sha256_compress_x8(s, blk);
  if (pad_blocks == 2) {
    for (int lane = 0; lane < 8; lane++) memcpy(blk[lane], tail[lane] + 64, 64);
    sha256_compress_x8(s, blk);
  }

  uint32_t lane_state[8][8];
  for (int word = 0; word < 8; word++) {
    uint32_t tmp[8];
    _mm256_storeu_si256((__m256i *)tmp, s[word]);
    for (int lane = 0; lane < 8; lane++) lane_state[lane][word] = tmp[lane];
  }
  for (int lane = 0; lane < 8; lane++) {
    for (int word = 0; word < 8; word++) store_be32(out[lane] + 4 * word, lane_state[lane][word]);
  }
}
