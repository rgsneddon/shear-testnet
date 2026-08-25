#ifndef SHEAR_SHA256_H
#define SHEAR_SHA256_H

#include <stddef.h>
#include <stdint.h>

void sha256_init(uint32_t state[8]);
void sha256_compress(uint32_t state[8], const uint8_t block[64]);
void sha256_oneshot(const uint8_t *data, size_t len, uint8_t out[32]);
void sha256_finish(uint32_t state[8], const uint8_t *rest, size_t rest_len, size_t total_len,
                   uint8_t out[32]);
void sha256_oneshot_x8(const uint8_t *const data[8], size_t len, uint8_t out[8][32]);

void sha256_compress_scalar(uint32_t state[8], const uint8_t block[64]);
void sha256_oneshot_scalar(const uint8_t *data, size_t len, uint8_t out[32]);
void sha256_oneshot_x8_scalar(const uint8_t *const data[8], size_t len, uint8_t out[8][32]);

void sha256_compress_ni(uint32_t state[8], const uint8_t block[64]);
void sha256_oneshot_ni(const uint8_t *data, size_t len, uint8_t out[32]);
void sha256_oneshot_x8_ni(const uint8_t *const data[8], size_t len, uint8_t out[8][32]);

void sha256_oneshot_x8_avx2(const uint8_t *const data[8], size_t len, uint8_t out[8][32]);

/* Runtime dispatch. Default pointers are scalar so hashing before select is safe. */
int sha256_select_backend(const char *want);
const char *sha256_backend_name(void);
int sha256_have_sha_ni(void);
int sha256_have_avx2(void);

#endif
