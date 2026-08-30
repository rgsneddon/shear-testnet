#ifndef SHEAR_SHA512_H
#define SHEAR_SHA512_H

#include <stddef.h>
#include <stdint.h>

void shear_sha512(const unsigned char *msg, size_t len, unsigned char out[64]);

#endif
