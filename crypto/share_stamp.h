#ifndef SHEAR_SHARE_STAMP_H
#define SHEAR_SHARE_STAMP_H

#include <stdint.h>

/*
 * Share credit is the little-endian high byte of the nonce.
 * B_MAX = min(52, floor(log2(MAX_HASH_UNITS_PER_BLOCK))).
 * This header is the C copy of crypto/asert.js shareCreditMaxBits()
 * and SHARE_FLOOR_BITS. Both miners call it. A pool job outside
 * [floor, B_MAX] is clamped before the byte is written.
 */
#define SHEAR_MAX_HASH_UNITS_PER_BLOCK (1u << 28)
#define SHEAR_SHARE_FLOOR_BITS 8
#define SHEAR_SHARE_BMAX_CAP 52
#define SHEAR_SHARE_NONCE_SHIFT 56

static inline int shear_share_bmax(void) {
  unsigned v = SHEAR_MAX_HASH_UNITS_PER_BLOCK;
  int n = 0;
  while (v > 1u) {
    v >>= 1u;
    n++;
  }
  if (n > SHEAR_SHARE_BMAX_CAP) n = SHEAR_SHARE_BMAX_CAP;
  if (n < SHEAR_SHARE_FLOOR_BITS) n = SHEAR_SHARE_FLOOR_BITS;
  return n;
}

static inline int shear_clamp_share_bits(int share_bits) {
  int sb = share_bits;
  int bmax = shear_share_bmax();
  if (sb < SHEAR_SHARE_FLOOR_BITS) sb = SHEAR_SHARE_FLOOR_BITS;
  if (sb > bmax) sb = bmax;
  return sb;
}

static inline uint64_t shear_stamp_share_nonce(uint64_t n, int share_bits) {
  int sb = shear_clamp_share_bits(share_bits);
  uint64_t low = n & ((1ull << SHEAR_SHARE_NONCE_SHIFT) - 1ull);
  return low | ((uint64_t)(unsigned)sb << SHEAR_SHARE_NONCE_SHIFT);
}

static inline int shear_credit_bits_of_nonce(uint64_t nonce) {
  int sb = (int)((nonce >> SHEAR_SHARE_NONCE_SHIFT) & 0xffu);
  int bmax = shear_share_bmax();
  if (sb < SHEAR_SHARE_FLOOR_BITS || sb > bmax) return -1;
  return sb;
}

#endif
