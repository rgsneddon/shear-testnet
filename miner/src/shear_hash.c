#include "shear_hash.h"

#include <stdio.h>
#include <string.h>

#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
static void sha256(const void *data, size_t len, unsigned char out[32]) {
  CC_SHA256(data, (CC_LONG)len, out);
}
#else
/* FIPS 180-4 SHA-256. Selftest vector 6e95b903… must match CommonCrypto/OpenSSL. */
static uint32_t rotr32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
static uint32_t bswap32(uint32_t x) {
  return ((x & 0xff000000u) >> 24) | ((x & 0x00ff0000u) >> 8) |
         ((x & 0x0000ff00u) << 8) | ((x & 0x000000ffu) << 24);
}
static void sha256(const void *data, size_t len, unsigned char out[32]) {
  static const uint32_t K[64] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  unsigned char block[64];
  size_t n = 0;
  uint64_t bitlen = 0;
  const unsigned char *p = (const unsigned char *)data;
  for (;;) {
    size_t take = 64 - n;
    if (take > len) take = len;
    if (take) {
      memcpy(block + n, p, take);
      n += take;
      p += take;
      len -= take;
      bitlen += take * 8;
    }
    if (n < 64) break;
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
      memcpy(&w[i], block + i * 4, 4);
      w[i] = bswap32(w[i]);
    }
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      uint32_t ch = (e & f) ^ ((~e) & g);
      uint32_t t1 = hh + S1 + ch + K[i] + w[i];
      uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    n = 0;
  }
  block[n++] = 0x80;
  if (n > 56) {
    while (n < 64) block[n++] = 0;
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
      memcpy(&w[i], block + i * 4, 4);
      w[i] = bswap32(w[i]);
    }
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      uint32_t ch = (e & f) ^ ((~e) & g);
      uint32_t t1 = hh + S1 + ch + K[i] + w[i];
      uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    n = 0;
  }
  while (n < 56) block[n++] = 0;
  uint64_t bl = bitlen;
  for (int i = 7; i >= 0; i--) {
    block[56 + i] = (unsigned char)(bl & 0xff);
    bl >>= 8;
  }
  {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
      memcpy(&w[i], block + i * 4, 4);
      w[i] = bswap32(w[i]);
    }
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      uint32_t ch = (e & f) ^ ((~e) & g);
      uint32_t t1 = hh + S1 + ch + K[i] + w[i];
      uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  for (int i = 0; i < 8; i++) {
    uint32_t v = bswap32(h[i]);
    memcpy(out + i * 4, &v, 4);
  }
}
#endif

/* version=1, remaining zeros — filled at runtime via encode match in JS tests */
const unsigned char SHEAR_SELFTEST_HEADER[SHEAR_HEADER_LEN] = {
  1, 0, 0, 0
};

const char SHEAR_SELFTEST_HASH[] =
    "6e95b9033c5d044d08bbf854fb2e5343ca3103b96ae37bde101258d43cfacc63";

void shear_hash_hex(const unsigned char hash[32], char hex[65]) {
  static const char *digits = "0123456789abcdef";
  for (int i = 0; i < 32; i++) {
    hex[i * 2] = digits[hash[i] >> 4];
    hex[i * 2 + 1] = digits[hash[i] & 15];
  }
  hex[64] = 0;
}

void shear_set_nonce(unsigned char header[SHEAR_HEADER_LEN], uint64_t nonce) {
  for (int i = 0; i < 8; i++) {
    header[112 + i] = (unsigned char)(nonce & 0xff);
    nonce >>= 8;
  }
}

void shear_hash(const unsigned char header[SHEAR_HEADER_LEN], unsigned char out[32]) {
  unsigned char buf[32 + 32 + SHEAR_HEADER_LEN + 8];
  size_t n = 0;
  memcpy(buf + n, SHEAR_PERSONAL, strlen(SHEAR_PERSONAL));
  n += strlen(SHEAR_PERSONAL);
  memcpy(buf + n, SHEAR_ALGO, strlen(SHEAR_ALGO));
  n += strlen(SHEAR_ALGO);
  memcpy(buf + n, header, SHEAR_HEADER_LEN);
  n += SHEAR_HEADER_LEN;
  sha256(buf, n, out);
  for (int r = 0; r < SHEAR_HASH_ROUNDS; r++) {
    n = 0;
    memcpy(buf + n, out, 32);
    n += 32;
    memcpy(buf + n, SHEAR_PERSONAL, strlen(SHEAR_PERSONAL));
    n += strlen(SHEAR_PERSONAL);
    buf[n++] = (unsigned char)('0' + r);
    memcpy(buf + n, header, SHEAR_HEADER_LEN);
    n += SHEAR_HEADER_LEN;
    sha256(buf, n, out);
  }
}

int shear_meets_target(const unsigned char hash[32], int bits) {
  if (bits <= 0) return 1;
  if (bits > 256) bits = 256;
  int full = bits / 8;
  int rem = bits % 8;
  for (int i = 0; i < full; i++) {
    if (hash[i] != 0) return 0;
  }
  if (!rem) return 1;
  return hash[full] < (1 << (8 - rem));
}

int shear_selftest(char got_hex[65]) {
  unsigned char header[SHEAR_HEADER_LEN];
  unsigned char hash[32];
  memset(header, 0, SHEAR_HEADER_LEN);
  header[0] = 1;
  shear_hash(header, hash);
  shear_hash_hex(hash, got_hex);
  return strcmp(got_hex, SHEAR_SELFTEST_HASH) == 0;
}
