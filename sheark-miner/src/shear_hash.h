#ifndef SHEARK_HASH_H
#define SHEARK_HASH_H

#include <stddef.h>
#include <stdint.h>

#define SHEAR_HEADER_LEN 128
#define SHEAR_PERSONAL "ShearHash-v2"
#define SHEAR_KEY_PERSONAL "ShearHash-v2/key"
#define SHEAR_RX_SALT "ShearHash-v2/rx"
#define SHEAR_ALGO "ShearHash"
#define SHEAR_CLIENT "ShearHash"
#define SHEAR_MINER_NAME "ShearK-Miner"
#define SHEAR_VERSION "1.2"
#define SHEAR_MAGIC "shear-testnet-v2"
#define SHEAR_RX_CACHE_MIB 128

#ifdef __cplusplus
extern "C" {
#endif

void shear_hash_hex(const unsigned char hash[32], char hex[65]);
void shear_set_nonce(unsigned char header[SHEAR_HEADER_LEN], uint64_t nonce);
void shear_key(const unsigned char header[SHEAR_HEADER_LEN], unsigned char k[32]);
void shear_hash(const unsigned char header[SHEAR_HEADER_LEN], unsigned char out[32]);
int shear_bind(const unsigned char header[SHEAR_HEADER_LEN]);
int shear_hash_first(const unsigned char header[SHEAR_HEADER_LEN]);
int shear_hash_next(const unsigned char header[SHEAR_HEADER_LEN], unsigned char out[32]);
int shear_meets_target(const unsigned char hash[32], int bits);
int shear_selftest(char got_hex[65]);
int shear_verify_header_hex(const char *header_hex, char digest_hex[65], char k_hex[65]);
const char *shear_hash_backend(void);
int shear_hash_set_backend(const char *name);

#ifdef __cplusplus
}
#endif

#endif
