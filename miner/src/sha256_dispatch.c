/*
 * Runtime SHA-256 kernel pick. Default CFLAGS (no -mavx2 / -msha).
 * Auto uses the fastest CPUID-legal kernel (SHA-NI vs AVX2 timed; else scalar).
 * ISA kernels live in other .o files; they are never entered without CPUID.
 */
#include "sha256.h"

#include <string.h>
#include <time.h>

#if defined(__x86_64__) || defined(_M_X64)
#include <cpuid.h>
#endif

static void (*p_compress)(uint32_t[8], const uint8_t[64]) = sha256_compress_scalar;
static void (*p_oneshot)(const uint8_t *, size_t, uint8_t[32]) = sha256_oneshot_scalar;
static void (*p_oneshot_x8)(const uint8_t *const[8], size_t, uint8_t[8][32]) =
    sha256_oneshot_x8_scalar;
static const char *g_backend = "scalar-x8";

int sha256_have_sha_ni(void) {
#if defined(__x86_64__) || defined(_M_X64)
  unsigned int a = 0, b = 0, c = 0, d = 0;
  if (__get_cpuid_max(0, NULL) < 7) return 0;
  __cpuid_count(7, 0, a, b, c, d);
  return (b & (1u << 29)) ? 1 : 0;
#else
  return 0;
#endif
}

int sha256_have_avx2(void) {
#if defined(__x86_64__) || defined(_M_X64)
  unsigned int a = 0, b = 0, c = 0, d = 0;
  if (!__get_cpuid(1, &a, &b, &c, &d)) return 0;
  if ((c & (1u << 27)) == 0 || (c & (1u << 28)) == 0) return 0;
  {
    unsigned int xeax = 0, xedx = 0;
    __asm__ volatile(".byte 0x0f, 0x01, 0xd0" : "=a"(xeax), "=d"(xedx) : "c"(0));
    if ((xeax & 6u) != 6u) return 0;
  }
  if (__get_cpuid_max(0, NULL) < 7) return 0;
  __cpuid_count(7, 0, a, b, c, d);
  return (b & (1u << 5)) ? 1 : 0;
#else
  return 0;
#endif
}

static void apply_scalar(void) {
  p_compress = sha256_compress_scalar;
  p_oneshot = sha256_oneshot_scalar;
  p_oneshot_x8 = sha256_oneshot_x8_scalar;
  g_backend = "scalar-x8";
}

static void apply_ni(void) {
  p_compress = sha256_compress_ni;
  p_oneshot = sha256_oneshot_ni;
  p_oneshot_x8 = sha256_oneshot_x8_ni;
  g_backend = "sha-ni";
}

static void apply_avx2(void) {
  p_compress = sha256_compress_scalar;
  p_oneshot = sha256_oneshot_scalar;
  p_oneshot_x8 = sha256_oneshot_x8_avx2;
  g_backend = "avx2-x8";
}

static uint64_t time_x8(void (*fn)(const uint8_t *const[8], size_t, uint8_t[8][32]), int iters) {
  uint8_t msg[8][128];
  const uint8_t *ptr[8];
  uint8_t out[8][32];
  memset(msg, 0x5a, sizeof(msg));
  for (int i = 0; i < 8; i++) {
    msg[i][0] = (uint8_t)i;
    ptr[i] = msg[i];
  }
  fn(ptr, 99, out);
  clock_t t0 = clock();
  for (int n = 0; n < iters; n++) fn(ptr, 99, out);
  clock_t dt = clock() - t0;
  return dt > 0 ? (uint64_t)dt : 1ull;
}

static void apply_fastest(int ni, int avx2) {
  if (ni && avx2) {
    uint64_t t_ni = time_x8(sha256_oneshot_x8_ni, 1500);
    uint64_t t_av = time_x8(sha256_oneshot_x8_avx2, 1500);
    if (t_ni <= t_av) apply_ni();
    else apply_avx2();
    return;
  }
  if (ni) apply_ni();
  else if (avx2) apply_avx2();
  else apply_scalar();
}

int sha256_select_backend(const char *want) {
  int ni = sha256_have_sha_ni();
  int avx2 = sha256_have_avx2();
  if (!want || !want[0] || strcmp(want, "auto") == 0) {
    apply_fastest(ni, avx2);
    return 0;
  }
  if (strcmp(want, "scalar") == 0 || strcmp(want, "scalar-x8") == 0) {
    apply_scalar();
    return 0;
  }
  if (strcmp(want, "sha-ni") == 0) {
    if (!ni) {
      apply_scalar();
      return -1;
    }
    apply_ni();
    return 0;
  }
  if (strcmp(want, "avx2") == 0 || strcmp(want, "avx2-x8") == 0) {
    if (!avx2) {
      apply_scalar();
      return -1;
    }
    apply_avx2();
    return 0;
  }
  apply_scalar();
  return -1;
}

const char *sha256_backend_name(void) {
  return g_backend;
}

void sha256_compress(uint32_t state[8], const uint8_t block[64]) {
  p_compress(state, block);
}

void sha256_oneshot(const uint8_t *data, size_t len, uint8_t out[32]) {
  p_oneshot(data, len, out);
}

void sha256_oneshot_x8(const uint8_t *const data[8], size_t len, uint8_t out[8][32]) {
  p_oneshot_x8(data, len, out);
}
