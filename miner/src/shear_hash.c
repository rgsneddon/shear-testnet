#include "shear_hash.h"
#include "sha256.h"

#include <stdio.h>
#include <string.h>

const unsigned char SHEAR_SELFTEST_HEADER[SHEAR_HEADER_LEN] = {1, 0, 0, 0};

const char SHEAR_SELFTEST_HASH[] =
    "5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066";

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
  sha256_oneshot(buf, n, out);
  for (int r = 0; r < SHEAR_HASH_ROUNDS; r++) {
    n = 0;
    memcpy(buf + n, out, 32);
    n += 32;
    memcpy(buf + n, SHEAR_PERSONAL, strlen(SHEAR_PERSONAL));
    n += strlen(SHEAR_PERSONAL);
    buf[n++] = (unsigned char)('0' + r);
    memcpy(buf + n, header, SHEAR_HEADER_LEN);
    n += SHEAR_HEADER_LEN;
    sha256_oneshot(buf, n, out);
  }
}

static void opening_midstate(uint32_t mid[8], const unsigned char header[SHEAR_HEADER_LEN]) {
  unsigned char blk[128];
  size_t pre = strlen(SHEAR_PERSONAL) + strlen(SHEAR_ALGO);
  memcpy(blk, SHEAR_PERSONAL, strlen(SHEAR_PERSONAL));
  memcpy(blk + strlen(SHEAR_PERSONAL), SHEAR_ALGO, strlen(SHEAR_ALGO));
  memcpy(blk + pre, header, 128 - pre);
  sha256_init(mid);
  sha256_compress(mid, blk);
  sha256_compress(mid, blk + 64);
}

void shear_hash_x8(const unsigned char headers[SHEAR_X8][SHEAR_HEADER_LEN],
                   unsigned char out[SHEAR_X8][32]) {
  size_t pre = strlen(SHEAR_PERSONAL) + strlen(SHEAR_ALGO);
  size_t first_len = pre + SHEAR_HEADER_LEN;
  uint32_t mid[8];
  opening_midstate(mid, headers[0]);
  for (int lane = 0; lane < SHEAR_X8; lane++) {
    uint32_t st[8];
    memcpy(st, mid, sizeof(st));
    sha256_finish(st, headers[lane] + (128 - pre), first_len - 128, first_len, out[lane]);
  }
  unsigned char msg[SHEAR_X8][32 + 32 + SHEAR_HEADER_LEN];
  const uint8_t *ptr[SHEAR_X8];
  size_t pers = strlen(SHEAR_PERSONAL);
  size_t round_len = 32u + pers + 1u + SHEAR_HEADER_LEN;
  for (int r = 0; r < SHEAR_HASH_ROUNDS; r++) {
    for (int lane = 0; lane < SHEAR_X8; lane++) {
      size_t n = 0;
      memcpy(msg[lane] + n, out[lane], 32);
      n += 32;
      memcpy(msg[lane] + n, SHEAR_PERSONAL, pers);
      n += pers;
      msg[lane][n++] = (unsigned char)('0' + r);
      memcpy(msg[lane] + n, headers[lane], SHEAR_HEADER_LEN);
      ptr[lane] = msg[lane];
    }
    sha256_oneshot_x8(ptr, round_len, out);
  }
}

const char *shear_hash_backend(void) {
  return sha256_backend_name();
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
  if (strcmp(got_hex, SHEAR_SELFTEST_HASH) != 0) return 0;

  unsigned char headers[SHEAR_X8][SHEAR_HEADER_LEN];
  unsigned char o8[SHEAR_X8][32];
  unsigned char ref[32];
  for (int i = 0; i < SHEAR_X8; i++) {
    memset(headers[i], 0, SHEAR_HEADER_LEN);
    headers[i][0] = 1;
    shear_set_nonce(headers[i], (uint64_t)(1000 + i));
  }
  shear_hash_x8(headers, o8);
  for (int i = 0; i < SHEAR_X8; i++) {
    shear_hash(headers[i], ref);
    if (memcmp(ref, o8[i], 32) != 0) return 0;
    for (int j = 0; j < i; j++) {
      if (memcmp(o8[i], o8[j], 32) == 0) return 0;
    }
  }
  return 1;
}
