/* BluNotes (R28): the rig's one-time share keys and the nonce binding.
 * The same rules as crypto/blunote.js, byte for byte:
 *   R = r*G, S = r*Y, delta = H512("shear-blunote-delta-v1" || S) mod L,
 *   P = B + delta*G, tag = sha256("shear-blunote-tag-v1" || S)[0];
 *   bind = first 6 bytes (LE) of
 *          sha256("shear-blunote-bind-v1" || header with nonce zeroed || R || P),
 *   nonce = counter | bind << 8 | width << 56.
 * The rig holds only the public mining keys B and Y. */
#ifndef SHEARK_BLUNOTE_H
#define SHEARK_BLUNOTE_H
#include <stddef.h>
#include <stdint.h>

typedef struct {
  unsigned char R[32];
  unsigned char P[32];
  unsigned char tag;
} BluKey;

/* 0 on success. Call once before any other blu_* function. */
int blu_init(void);
/* Parse 128 hex chars B||Y; 0 on success. Both must be valid ristretto255 points. */
int blu_set_address(const char *hex128);
int blu_enabled(void);
/* The key for a given scalar r (32 bytes LE, below L); 0 on success. */
int blu_key_from_r(const unsigned char r[32], BluKey *out);
/* Decode 2n hex chars into n bytes; 0 on success. */
int blu_hex_bytes(const char *hex, unsigned char *out, size_t n);
/* A fresh one-time key; 0 on success. */
int blu_new_key(BluKey *out);
/* The 48-bit binding of (R, P) on this 128-byte header (its nonce bytes ignored). */
uint64_t blu_bind(const unsigned char header[128], const BluKey *k);
/* Nonce for counter c (0..255) under binding `bind`, keeping the width byte of `width_hi`. */
uint64_t blu_nonce(uint64_t width_hi, uint64_t bind, unsigned c);
void blu_hex32(const unsigned char in[32], char out[65]);

#endif
