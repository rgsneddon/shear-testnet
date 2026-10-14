/* In-process stand-in for the wallet dart:ffi range calls.
 * Same C ABI as wallet/lib/shear_admit_ffi.dart. Prints hex to stdout.
 */
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int32_t (*range_fn)(uint64_t v, const uint8_t *r, uint8_t *out, uint32_t *out_len);

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static int unhex(const char *s, uint8_t **out, size_t *out_len) {
  size_t n = strlen(s);
  if (n % 2 != 0) return -1;
  size_t len = n / 2;
  uint8_t *buf = (uint8_t *)malloc(len ? len : 1);
  if (!buf) return -1;
  for (size_t i = 0; i < len; i++) {
    int hi = hex_nibble(s[i * 2]);
    int lo = hex_nibble(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) {
      free(buf);
      return -1;
    }
    buf[i] = (uint8_t)((hi << 4) | lo);
  }
  *out = buf;
  *out_len = len;
  return 0;
}

static void hexout(const char *key, const uint8_t *p, size_t n) {
  fputs(key, stdout);
  fputc(' ', stdout);
  for (size_t i = 0; i < n; i++) fprintf(stdout, "%02x", p[i]);
  fputc('\n', stdout);
}

static void wipe(uint8_t *p, size_t n) {
  if (!p) return;
  volatile uint8_t *b = p;
  for (size_t i = 0; i < n; i++) b[i] = 0;
}

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: %s <libshear_admit.so> range <v> <rhex>\n", argv[0]);
    return 2;
  }
  void *lib = dlopen(argv[1], RTLD_NOW);
  if (!lib) {
    fprintf(stderr, "dlopen: %s\n", dlerror());
    return 2;
  }
  if (strcmp(argv[2], "range") != 0) {
    fprintf(stderr, "unknown op\n");
    return 2;
  }
  range_fn fn = (range_fn)dlsym(lib, "shear_range_prove");
  if (!fn) {
    fprintf(stderr, "missing shear_range_prove\n");
    return 2;
  }
  unsigned long long v = strtoull(argv[3], NULL, 10);
  uint8_t *r = NULL;
  size_t rn = 0;
  if (unhex(argv[4], &r, &rn) != 0 || rn != 32) {
    free(r);
    fprintf(stderr, "bad r\n");
    return 2;
  }
  uint8_t *out = (uint8_t *)malloc(65536);
  uint32_t olen = 0;
  int32_t ok = out ? fn((uint64_t)v, r, out, &olen) : 0;
  wipe(r, rn);
  free(r);
  if (!out || ok != 1 || olen == 0 || olen > 65536) {
    free(out);
    fprintf(stderr, "range prove failed\n");
    return 1;
  }
  hexout("proof", out, olen);
  free(out);
  return 0;
}
