#ifndef SHEAR_SHA256_H
#define SHEAR_SHA256_H

#include <stddef.h>
#include <stdint.h>

void shear_sha256(const unsigned char *msg, size_t len, unsigned char out[32]);

#endif
