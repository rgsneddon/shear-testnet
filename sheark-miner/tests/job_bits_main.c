#include <stdio.h>
#include <stdlib.h>
#include "../src/job_bits.h"

static void check(const char *name, int got, int want) {
  if (got != want) {
    fprintf(stderr, "%s got %d want %d\n", name, got, want);
    exit(1);
  }
}

int main(void) {
  int share = -1;
  int block = -1;
  check("both", shear_job_widths(1, 12, 1, 20, 1, 7, &share, &block), 1);
  check("share", share, 12);
  check("blockBits wins", block, 20);
  share = -1;
  block = -1;
  check("bits only", shear_job_widths(1, 9, 0, 0, 1, 30, &share, &block), 1);
  check("bits share", share, 9);
  check("bits block", block, 30);
  check("no share", shear_job_widths(0, 12, 1, 20, 1, 7, &share, &block), 0);
  check("zero share", shear_job_widths(1, 0, 1, 20, 0, 0, &share, &block), 0);
  check("neg share", shear_job_widths(1, -4, 1, 20, 0, 0, &share, &block), 0);
  check("no block", shear_job_widths(1, 11, 0, 16, 0, 16, &share, &block), 0);
  check("zero block", shear_job_widths(1, 11, 1, 0, 1, 0, &share, &block), 0);
  for (int width = 1; width <= 52; width += 1) {
    share = -1;
    block = -1;
    if (!shear_job_widths(1, width, 1, width + 3, 1, 8, &share, &block)) exit(1);
    if (share != width || block != width + 3) exit(1);
  }
  printf("job widths ok\n");
  return 0;
}
