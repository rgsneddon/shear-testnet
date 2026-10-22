#include "shear_hash.h"

/* Wallet FFI. The miner shear_hash keeps the RandomX cache for the current key. */
__attribute__((constructor)) static void shear_v3_init(void) {
  shear_hash_set_backend("interpreter");
}

void shear_v3_hash(const unsigned char header[128], unsigned char out[32]) {
  shear_hash(header, out);
}
