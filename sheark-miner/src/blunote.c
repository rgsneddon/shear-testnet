/* BluNotes (R28) rig keys and binding. See blunote.h. */
#include "blunote.h"
#include "sha256.h"
#include <sodium.h>
#include <string.h>

static unsigned char g_B[32];
static unsigned char g_Y[32];
static int g_on = 0;

static const char BIND_DST[] = "shear-blunote-bind-v1";
static const char DELTA_DST[] = "shear-blunote-delta-v1";
static const char TAG_DST[] = "shear-blunote-tag-v1";

int blu_init(void) {
  return sodium_init() < 0 ? -1 : 0;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int blu_hex_bytes(const char *hex, unsigned char *out, size_t n) {
  if (!hex || strlen(hex) != 2 * n) return -1;
  for (size_t i = 0; i < n; i++) {
    int a = hexval(hex[2 * i]);
    int b = hexval(hex[2 * i + 1]);
    if (a < 0 || b < 0) return -1;
    out[i] = (unsigned char)((a << 4) | b);
  }
  return 0;
}

int blu_set_address(const char *hex) {
  unsigned char raw[64];
  if (blu_hex_bytes(hex, raw, 64) != 0) return -1;
  if (!crypto_core_ristretto255_is_valid_point(raw) || !crypto_core_ristretto255_is_valid_point(raw + 32)) return -1;
  memcpy(g_B, raw, 32);
  memcpy(g_Y, raw + 32, 32);
  g_on = 1;
  return 0;
}

int blu_enabled(void) {
  return g_on;
}

int blu_key_from_r(const unsigned char r[32], BluKey *out) {
  if (!g_on || !out) return -1;
  unsigned char S[32], h[64], delta[32], D[32], t[32];
  if (crypto_scalarmult_ristretto255_base(out->R, r) != 0) return -1;
  if (crypto_scalarmult_ristretto255(S, r, g_Y) != 0) return -1;
  /* delta = H512(DST || S) reduced mod L, as hashToScalar in crypto/note.js. */
  unsigned char m1[sizeof(DELTA_DST) - 1 + 32];
  memcpy(m1, DELTA_DST, sizeof(DELTA_DST) - 1);
  memcpy(m1 + sizeof(DELTA_DST) - 1, S, 32);
  crypto_hash_sha512(h, m1, sizeof(m1));
  crypto_core_ristretto255_scalar_reduce(delta, h);
  if (crypto_scalarmult_ristretto255_base(D, delta) != 0) return -1;
  if (crypto_core_ristretto255_add(out->P, g_B, D) != 0) return -1;
  unsigned char m2[sizeof(TAG_DST) - 1 + 32];
  memcpy(m2, TAG_DST, sizeof(TAG_DST) - 1);
  memcpy(m2 + sizeof(TAG_DST) - 1, S, 32);
  shear_sha256(m2, sizeof(m2), t);
  out->tag = t[0];
  sodium_memzero(S, sizeof(S));
  return 0;
}

int blu_new_key(BluKey *out) {
  unsigned char r[32];
  for (int tries = 0; tries < 8; tries++) {
    crypto_core_ristretto255_scalar_random(r);
    if (blu_key_from_r(r, out) == 0) {
      sodium_memzero(r, sizeof(r));
      return 0;
    }
  }
  sodium_memzero(r, sizeof(r));
  return -1;
}

uint64_t blu_bind(const unsigned char header[128], const BluKey *k) {
  enum { DL = sizeof(BIND_DST) - 1 };
  unsigned char m[DL + 128 + 64], d[32];
  memcpy(m, BIND_DST, DL);
  memcpy(m + DL, header, 128);
  memset(m + DL + 112, 0, 8);
  memcpy(m + DL + 128, k->R, 32);
  memcpy(m + DL + 160, k->P, 32);
  shear_sha256(m, sizeof(m), d);
  uint64_t v = 0;
  for (int i = 5; i >= 0; i--) v = (v << 8) | d[i];
  return v;
}

uint64_t blu_nonce(uint64_t width_hi, uint64_t bind, unsigned c) {
  return (width_hi & 0xff00000000000000ULL) | ((bind & 0xffffffffffffULL) << 8) | (uint64_t)(c & 0xff);
}

void blu_hex32(const unsigned char in[32], char out[65]) {
  static const char hx[] = "0123456789abcdef";
  for (int i = 0; i < 32; i++) {
    out[2 * i] = hx[in[i] >> 4];
    out[2 * i + 1] = hx[in[i] & 0xf];
  }
  out[64] = 0;
}
