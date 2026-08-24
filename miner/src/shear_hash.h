#ifndef SHEAR_HASH_H
#define SHEAR_HASH_H

#include <stddef.h>
#include <stdint.h>

#define SHEAR_HASH_ROUNDS 8
#define SHEAR_HEADER_LEN 120
#define SHEAR_PERSONAL "ShearHash-v1"
#define SHEAR_ALGO "ShearHash"
#define SHEAR_CLIENT "ShearHash"
#define SHEAR_VERSION "0.1.3"

void shear_hash(const unsigned char header[SHEAR_HEADER_LEN], unsigned char out[32]);
void shear_hash_hex(const unsigned char hash[32], char hex[65]);
int shear_meets_target(const unsigned char hash[32], int bits);
int shear_selftest(char got_hex[65]);
void shear_set_nonce(unsigned char header[SHEAR_HEADER_LEN], uint64_t nonce);

extern const unsigned char SHEAR_SELFTEST_HEADER[SHEAR_HEADER_LEN];
extern const char SHEAR_SELFTEST_HASH[];

#endif
