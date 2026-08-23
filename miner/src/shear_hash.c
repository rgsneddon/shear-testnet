#include "shear_hash.h"

#include <stdio.h>
#include <string.h>

#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
static void sha256(const void *data, size_t len, unsigned char out[32]) {
  CC_SHA256(data, (CC_LONG)len, out);
}
#else
#include <openssl/sha.h>
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
#endif
static void sha256(const void *data, size_t len, unsigned char out[32]) {
  SHA256_CTX ctx;
  SHA256_Init(&ctx);
  SHA256_Update(&ctx, data, len);
  SHA256_Final(out, &ctx);
}
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
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
