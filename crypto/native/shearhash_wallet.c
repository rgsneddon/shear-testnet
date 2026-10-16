#include "shear_hash.h"

/* Wallet FFI. Interpreter only: the light digest is the one that verifies.
 * A zeroed buffer is not a digest; callers must check the return code.
 * shear_hash() writes zeros when the cache cannot be built. */
static int g_wallet_backend;

int shear_wallet_hash(const unsigned char header[128], unsigned char out[32]) {
  if (!header || !out) return -1;
  if (!g_wallet_backend) {
    if (shear_hash_set_backend("interpreter") != 0) return -1;
    g_wallet_backend = 1;
  }
  if (shear_bind(header) != 0) return -1;
  shear_hash(header, out);
  /* shear_hash writes zeros when the cache or VM cannot be built.
   * That buffer meets any positive bits, so it is not a digest. */
  for (int i = 0; i < 32; i++) {
    if (out[i] != 0) return 0;
  }
  return -1;
}
