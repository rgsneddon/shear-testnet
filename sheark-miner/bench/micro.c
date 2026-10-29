/*
 * micro (R41): what the miner adds to each ShearHash-v3 hash, measured on
 * the miner's own objects. Per nonce a worker derives the RandomX key
 * (shear_key: SHA-512, inside shear_hash_next), stamps the nonce
 * (blu_nonce) and checks the target; every 256 nonces, or on a hit or a
 * header change, it makes a fresh BluNotes key (blu_new_key) and binds it
 * (blu_bind). This times each piece against one pipelined jit-full hash.
 * Measurement only: no socket, no file written.
 *   micro [--backend jit-full] [--secs 10]
 */
#include "shear_hash.h"
#include "blunote.h"

#include <sodium.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static volatile uint64_t g_sink;

int main(int argc, char **argv) {
  const char *backend = "jit-full";
  double secs = 10;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--backend") && i + 1 < argc) backend = argv[++i];
    else if (!strcmp(argv[i], "--secs") && i + 1 < argc) secs = atof(argv[++i]);
  }
  if (blu_init() != 0) return 1;
  unsigned char B[32], Y[32];
  crypto_core_ristretto255_random(B);
  crypto_core_ristretto255_random(Y);
  char addr[129];
  for (int i = 0; i < 32; i++) {
    snprintf(addr + 2 * i, 3, "%02x", B[i]);
    snprintf(addr + 64 + 2 * i, 3, "%02x", Y[i]);
  }
  if (blu_set_address(addr) != 0) {
    printf("blu_set_address failed\n");
    return 1;
  }
  unsigned char hdr[SHEAR_HEADER_LEN], k[32], out[32];
  memset(hdr, 0, sizeof(hdr));
  hdr[0] = 1;

  int n = 200000;
  double t0 = now_s();
  for (int i = 0; i < n; i++) {
    hdr[112] = (unsigned char)i;
    shear_key(hdr, k);
    g_sink += k[0];
  }
  double key_ns = (now_s() - t0) / n * 1e9;

  BluKey key;
  int nk = 2000;
  t0 = now_s();
  for (int i = 0; i < nk; i++) {
    if (blu_new_key(&key) != 0) return 1;
    g_sink += key.tag;
  }
  double newkey_us = (now_s() - t0) / nk * 1e6;

  t0 = now_s();
  uint64_t bind = 0;
  for (int i = 0; i < nk * 10; i++) {
    hdr[100] = (unsigned char)i;
    bind = blu_bind(hdr, &key);
    g_sink += bind;
  }
  double bind_us = (now_s() - t0) / (nk * 10) * 1e6;

  t0 = now_s();
  for (int i = 0; i < n * 10; i++) g_sink += blu_nonce((uint64_t)8 << 56, bind, (unsigned)(i & 255));
  double nonce_ns = (now_s() - t0) / (n * 10) * 1e9;

  unsigned char note[32], bound[32];
  memset(note, 7, sizeof(note));
  t0 = now_s();
  for (int i = 0; i < n; i++) {
    out[0] = (unsigned char)i;
    shear_share_bind(out, note, bound);
    g_sink += (uint64_t)shear_meets_target(bound, 10);
  }
  double target_ns = (now_s() - t0) / n * 1e9;

  if (shear_hash_set_backend(backend) != 0) return 1;
  shear_hash(hdr, out);
  uint64_t h = 0, nonce = 1;
  int primed = 0;
  t0 = now_s();
  while (now_s() - t0 < secs) {
    shear_set_nonce(hdr, nonce++);
    if (!primed) {
      primed = shear_hash_first(hdr) == 0;
      continue;
    }
    if (shear_hash_next(hdr, out) != 0) {
      primed = 0;
      continue;
    }
    h++;
  }
  double hash_us = (now_s() - t0) / (double)h * 1e6;
  /* Per nonce: shear_key + blu_nonce + target check (dest-bound worst case);
   * per 256 nonces: one new key and its binding. */
  double add_us = key_ns / 1e3 + nonce_ns / 1e3 + target_ns / 1e3 + (newkey_us + bind_us) / 256.0;
  printf("micro backend=%s hash_us=%.1f shear_key_ns=%.0f blu_new_key_us=%.1f blu_bind_us=%.2f blu_nonce_ns=%.1f "
         "share_bind_target_ns=%.0f miner_overhead_per_hash_us=%.3f overhead_pct=%.3f\n",
         shear_hash_backend(), hash_us, key_ns, newkey_us, bind_us, nonce_ns, target_ns, add_us,
         100.0 * add_us / hash_us);
  return 0;
}
