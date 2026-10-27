/* R28 known-answer driver: one BluNotes key from a given r and its binding,
 * from the miner's own src/blunote.c. Usage: B||Y hex, r hex (LE), header hex. */
#include <stdio.h>
#include "../src/blunote.h"

int main(int argc, char **argv) {
  if (argc != 4) return 2;
  BluKey k;
  unsigned char r[32], hdr[128];
  if (blu_init() != 0 || blu_set_address(argv[1]) != 0) return 2;
  if (blu_hex_bytes(argv[2], r, 32) != 0 || blu_hex_bytes(argv[3], hdr, 128) != 0) return 2;
  if (blu_key_from_r(r, &k) != 0) return 3;
  char R[65], P[65];
  blu_hex32(k.R, R);
  blu_hex32(k.P, P);
  printf("%s %s %u %llu\n", R, P, (unsigned)k.tag, (unsigned long long)blu_bind(hdr, &k));
  return 0;
}
