/* R40: prints shear_sha512 of a message, for test_sha512_fips_v12.js.
 *   sha512_main HEX       the message as hex ("" for the empty message)
 *   sha512_main --a N     N bytes of 'a' (FIPS 180-4's one-million-'a' vector) */
#include "../src/sha512.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int nib(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int main(int argc, char **argv) {
  unsigned char *msg = NULL;
  size_t n = 0;
  if (argc == 3 && strcmp(argv[1], "--a") == 0) {
    n = (size_t)strtoul(argv[2], NULL, 10);
    msg = malloc(n ? n : 1);
    if (!msg) return 1;
    memset(msg, 'a', n);
  } else if (argc == 2) {
    size_t h = strlen(argv[1]);
    if (h % 2) return 2;
    n = h / 2;
    msg = malloc(n ? n : 1);
    if (!msg) return 1;
    for (size_t i = 0; i < n; i++) {
      int a = nib(argv[1][2 * i]), b = nib(argv[1][2 * i + 1]);
      if (a < 0 || b < 0) return 2;
      msg[i] = (unsigned char)((a << 4) | b);
    }
  } else {
    return 2;
  }
  unsigned char out[64];
  shear_sha512(msg, n, out);
  for (int i = 0; i < 64; i++) printf("%02x", out[i]);
  printf("\n");
  free(msg);
  return 0;
}
