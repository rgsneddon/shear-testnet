#ifndef SHEAR_HASH_H
#define SHEAR_HASH_H

#include <stddef.h>
#include <stdint.h>

#define SHEAR_HASH_ROUNDS 8
#define SHEAR_HEADER_LEN 128
#define SHEAR_PERSONAL "ShearHash-v1"
#define SHEAR_ALGO "ShearHash"
#define SHEAR_CLIENT "ShearHash"
#define SHEAR_MINER_NAME "shear-miner"
#define SHEAR_VERSION "0.5"
#define SHEAR_X8 8

void shear_hash(const unsigned char header[SHEAR_HEADER_LEN], unsigned char out[32]);
void shear_hash_x8(const unsigned char headers[SHEAR_X8][SHEAR_HEADER_LEN],
                   unsigned char out[SHEAR_X8][32]);
void shear_hash_hex(const unsigned char hash[32], char hex[65]);
int shear_meets_target(const unsigned char hash[32], int bits);
int shear_selftest(char got_hex[65]);
void shear_set_nonce(unsigned char header[SHEAR_HEADER_LEN], uint64_t nonce);
const char *shear_hash_backend(void);

extern const unsigned char SHEAR_SELFTEST_HEADER[SHEAR_HEADER_LEN];
extern const char SHEAR_SELFTEST_HASH[];

#endif
