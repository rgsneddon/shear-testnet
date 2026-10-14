#include "../../crypto/share_stamp.h"

#include <stdio.h>
#include <stdlib.h>

/* No RandomX. Prints "<stamped-nonce> <credit-byte>" for a job width. */
int main(int argc, char **argv) {
  if (argc < 2) {
    printf("bmax %d floor %d\n", shear_share_bmax(), SHEAR_SHARE_FLOOR_BITS);
    return 0;
  }
  int bits = atoi(argv[1]);
  unsigned long long low = argc > 2 ? strtoull(argv[2], NULL, 0) : 1ull;
  uint64_t stamped = shear_stamp_share_nonce(low, bits);
  printf("%llu %d\n", (unsigned long long)stamped, shear_credit_bits_of_nonce(stamped));
  return 0;
}
