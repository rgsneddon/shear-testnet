#ifndef SHEAR_T21_LABEL_H
#define SHEAR_T21_LABEL_H
#include <stddef.h>

#define T21_MAGIC_DEFAULT "shear-testnet-v12"

/* 1 when E = lambda*G + beta*H on ristretto255 (G the basepoint, H the Shear
 * note generator) and note == SHA-256("shear-share-bind-v1" || magic || E).
 * Scalars are 32-byte little-endian. */
int t21_label_ok(const unsigned char lambda[32], const unsigned char beta[32],
                 const unsigned char E[32], const unsigned char note[32], const char *magic);

/* out = a*G + b*H, encoded. 0 on success. */
int t21_label_point(const unsigned char a[32], const unsigned char b[32], unsigned char out[32]);

#endif
