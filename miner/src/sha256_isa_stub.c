/*
 * Non-x86_64 stand-ins for SHA-NI / AVX2 symbols. Dispatch never selects
 * these backends without CPUID, which is false here.
 */
#include "sha256.h"

void sha256_compress_ni(uint32_t state[8], const uint8_t block[64]) {
  sha256_compress_scalar(state, block);
}

void sha256_oneshot_ni(const uint8_t *data, size_t len, uint8_t out[32]) {
  sha256_oneshot_scalar(data, len, out);
}

void sha256_oneshot_x8_ni(const uint8_t *const data[8], size_t len, uint8_t out[8][32]) {
  sha256_oneshot_x8_scalar(data, len, out);
}

void sha256_oneshot_x8_avx2(const uint8_t *const data[8], size_t len, uint8_t out[8][32]) {
  sha256_oneshot_x8_scalar(data, len, out);
}
