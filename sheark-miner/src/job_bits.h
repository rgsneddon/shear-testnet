#ifndef SHEAR_JOB_BITS_H
#define SHEAR_JOB_BITS_H
/* Widths come from the job only. A missing or non-positive field is refused.
   blockBits wins over bits. This does not invent a stand-in width. */
static inline int shear_job_widths(int has_share, int share_bits,
                                   int has_block, int block_bits,
                                   int has_bits, int bits,
                                   int *out_share, int *out_block) {
  if (!has_share || share_bits <= 0) return 0;
  int block = 0;
  if (has_block && block_bits > 0) block = block_bits;
  else if (has_bits && bits > 0) block = bits;
  else return 0;
  if (out_share) *out_share = share_bits;
  if (out_block) *out_block = block;
  return 1;
}
#endif
