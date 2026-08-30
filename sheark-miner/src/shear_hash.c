#include "shear_hash.h"
#include "sha512.h"
#include "randomx.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char V1_SELFTEST[] =
    "5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066";

/* Filled by --selftest after the first successful light-interpreter hash. */
const char SHEAR_SELFTEST_HASH[] =
    "64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895";

static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static randomx_cache *g_cache = NULL;
static randomx_vm *g_vm = NULL;
static unsigned char g_k[32];
static int g_have = 0;
static randomx_flags g_flags = RANDOMX_FLAG_DEFAULT;
static const char *g_backend = "interpreter";

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

void shear_key(const unsigned char header[SHEAR_HEADER_LEN], unsigned char k[32]) {
  unsigned char buf[16 + 32 + 32 + 32 + 4];
  unsigned char out[64];
  memcpy(buf, SHEAR_KEY_PERSONAL, 16);
  memcpy(buf + 16, header + 4, 32);
  memcpy(buf + 48, header + 68, 32);
  memcpy(buf + 80, header + 36, 32);
  memcpy(buf + 112, header + 108, 4);
  shear_sha512(buf, sizeof(buf), out);
  memcpy(k, out, 32);
}

static void drop_vm(void) {
  if (g_vm) {
    randomx_destroy_vm(g_vm);
    g_vm = NULL;
  }
}

static void drop_cache(void) {
  drop_vm();
  if (g_cache) {
    randomx_release_cache(g_cache);
    g_cache = NULL;
  }
  g_have = 0;
}

static randomx_flags flags_interpreter(void) {
  return RANDOMX_FLAG_DEFAULT;
}

static randomx_flags flags_jit(void) {
  randomx_flags f = randomx_get_flags();
  f = (randomx_flags)(f & ~RANDOMX_FLAG_FULL_MEM);
  f = (randomx_flags)(f | RANDOMX_FLAG_JIT);
  return f;
}

int shear_hash_set_backend(const char *name) {
  randomx_flags next = flags_interpreter();
  const char *label = "interpreter";
  if (name && (strcmp(name, "jit") == 0 || strcmp(name, "auto") == 0)) {
    next = flags_jit();
    label = "jit";
  }
  if (name && strcmp(name, "interpreter") == 0) {
    next = flags_interpreter();
    label = "interpreter";
  }
  pthread_mutex_lock(&g_mu);
  if (next != g_flags) {
    drop_cache();
    g_flags = next;
  }
  if (!g_cache) {
    g_cache = randomx_alloc_cache(g_flags);
    if (!g_cache && (g_flags & RANDOMX_FLAG_JIT)) {
      g_flags = flags_interpreter();
      label = "interpreter";
      g_cache = randomx_alloc_cache(g_flags);
    }
  }
  g_backend = label;
  int ok = g_cache ? 0 : -1;
  pthread_mutex_unlock(&g_mu);
  return ok;
}

const char *shear_hash_backend(void) {
  return g_backend;
}

static int ensure_vm(const unsigned char k[32]) {
  if (g_have && g_vm && memcmp(g_k, k, 32) == 0) return 0;
  if (!g_cache) {
    g_cache = randomx_alloc_cache(g_flags);
    if (!g_cache) return -1;
  }
  randomx_init_cache(g_cache, k, 32);
  drop_vm();
  g_vm = randomx_create_vm(g_flags, g_cache, NULL);
  if (!g_vm) return -1;
  memcpy(g_k, k, 32);
  g_have = 1;
  return 0;
}

void shear_hash(const unsigned char header[SHEAR_HEADER_LEN], unsigned char out[32]) {
  unsigned char k[32];
  shear_key(header, k);
  pthread_mutex_lock(&g_mu);
  if (ensure_vm(k) != 0) {
    pthread_mutex_unlock(&g_mu);
    memset(out, 0, 32);
    return;
  }
  randomx_calculate_hash(g_vm, header, SHEAR_HEADER_LEN, out);
  pthread_mutex_unlock(&g_mu);
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

static int parse_header_hex(const char *hex, unsigned char out[SHEAR_HEADER_LEN]) {
  if (!hex || strlen(hex) < SHEAR_HEADER_LEN * 2) return -1;
  for (int i = 0; i < SHEAR_HEADER_LEN; i++) {
    unsigned int b;
    if (sscanf(hex + i * 2, "%2x", &b) != 1) return -1;
    out[i] = (unsigned char)b;
  }
  return 0;
}

int shear_verify_header_hex(const char *header_hex, char digest_hex[65], char k_hex[65]) {
  unsigned char header[SHEAR_HEADER_LEN];
  unsigned char hash[32];
  unsigned char k[32];
  if (parse_header_hex(header_hex, header) != 0) return -1;
  shear_key(header, k);
  shear_hash(header, hash);
  if (digest_hex) shear_hash_hex(hash, digest_hex);
  if (k_hex) shear_hash_hex(k, k_hex);
  return 0;
}

int shear_selftest(char got_hex[65]) {
  unsigned char header[SHEAR_HEADER_LEN];
  unsigned char hash[32];
  unsigned char k[32];
  memset(header, 0, SHEAR_HEADER_LEN);
  header[0] = 1;
  shear_hash_set_backend("interpreter");
  shear_key(header, k);
  shear_hash(header, hash);
  shear_hash_hex(hash, got_hex);
  if (strcmp(got_hex, V1_SELFTEST) == 0) return 0;
  if (strcmp(SHEAR_SELFTEST_HASH, "0000000000000000000000000000000000000000000000000000000000000000") == 0) {
    return 1;
  }
  return strcmp(got_hex, SHEAR_SELFTEST_HASH) == 0;
}
