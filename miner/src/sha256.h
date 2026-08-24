#ifndef SHEAR_SHA256_H
#define SHEAR_SHA256_H

#include <stddef.h>
#include <stdint.h>

void sha256_init(uint32_t state[8]);
void sha256_compress(uint32_t state[8], const uint8_t block[64]);
void sha256_oneshot(const uint8_t *data, size_t len, uint8_t out[32]);
void sha256_finish(uint32_t state[8], const uint8_t *rest, size_t rest_len, size_t total_len,
                   uint8_t out[32]);

int sha256_have_avx2(void);

/* Eight independent equal-length messages → eight 32-byte digests. */
void sha256_oneshot_x8(const uint8_t *const data[8], size_t len, uint8_t out[8][32]);

#endif
