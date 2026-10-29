/* Built with -DSHEAR_MAX_VM=8. Cache and VM allocation are forced to fail.
 * A failure must return -1 and must not yield an all-zero digest.
 * Zeros meet every target. shear_hash zero-fills today, so this exits 1.
 */
#include "randomx.h"
#include "shear_hash.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifndef SHEAR_MAX_VM
#error "build this test with -DSHEAR_MAX_VM=8"
#endif
#if SHEAR_MAX_VM != 8
#error "SHEAR_MAX_VM must be 8"
#endif

extern int shear_alloc_fail_max_vm(void);

static int g_fail_cache;
static int g_fail_vm;

static void unexpected(const char *name) {
  fprintf(stderr, "unexpected RandomX call %s\n", name);
}

randomx_flags randomx_get_flags(void) {
  unexpected("randomx_get_flags");
  return RANDOMX_FLAG_DEFAULT;
}

randomx_cache *randomx_alloc_cache(randomx_flags flags) {
  (void)flags;
  if (g_fail_cache) return NULL;
  return (randomx_cache *)(uintptr_t)1;
}

void randomx_init_cache(randomx_cache *cache, const void *key, size_t keySize) {
  (void)cache;
  (void)key;
  (void)keySize;
}

void randomx_release_cache(randomx_cache *cache) {
  (void)cache;
  unexpected("randomx_release_cache");
}

randomx_dataset *randomx_alloc_dataset(randomx_flags flags) {
  (void)flags;
  unexpected("randomx_alloc_dataset");
  return NULL;
}

void randomx_init_dataset(randomx_dataset *dataset, randomx_cache *cache,
                          unsigned long startItem, unsigned long itemCount) {
  (void)dataset;
  (void)cache;
  (void)startItem;
  (void)itemCount;
  unexpected("randomx_init_dataset");
}

unsigned long randomx_dataset_item_count(void) {
  unexpected("randomx_dataset_item_count");
  return 0;
}

void randomx_release_dataset(randomx_dataset *dataset) {
  (void)dataset;
  unexpected("randomx_release_dataset");
}

randomx_vm *randomx_create_vm(randomx_flags flags, randomx_cache *cache, randomx_dataset *dataset) {
  (void)flags;
  (void)cache;
  (void)dataset;
  if (g_fail_vm) return NULL;
  return (randomx_vm *)(uintptr_t)1;
}

void randomx_destroy_vm(randomx_vm *machine) {
  (void)machine;
  unexpected("randomx_destroy_vm");
}

void randomx_vm_set_cache(randomx_vm *machine, randomx_cache *cache) {
  (void)machine;
  (void)cache;
  unexpected("randomx_vm_set_cache");
}

void randomx_vm_set_dataset(randomx_vm *machine, randomx_dataset *dataset) {
  (void)machine;
  (void)dataset;
  unexpected("randomx_vm_set_dataset");
}

void randomx_calculate_hash(randomx_vm *machine, const void *input, size_t inputSize, void *output) {
  (void)machine;
  (void)input;
  (void)inputSize;
  (void)output;
  unexpected("randomx_calculate_hash");
}

void randomx_calculate_hash_first(randomx_vm *machine, const void *input, size_t inputSize) {
  (void)machine;
  (void)input;
  (void)inputSize;
  unexpected("randomx_calculate_hash_first");
}

void randomx_calculate_hash_next(randomx_vm *machine, const void *nextInput, size_t nextInputSize, void *output) {
  (void)machine;
  (void)nextInput;
  (void)nextInputSize;
  (void)output;
  unexpected("randomx_calculate_hash_next");
}

static int all_zero(const unsigned char *p) {
  for (int i = 0; i < 32; i++) {
    if (p[i]) return 0;
  }
  return 1;
}

/* 0 when this failure returns -1 and neither buffer is all zeros. */
static int expect_closed(const char *name, const unsigned char header[SHEAR_HEADER_LEN]) {
  unsigned char checked[32];
  unsigned char legacy[32];
  memset(checked, 0xa5, sizeof checked);
  int rc = shear_hash_checked(header, checked);
  int checked_zero = all_zero(checked);
  memset(legacy, 0xa5, sizeof legacy);
  shear_hash(header, legacy);
  int legacy_zero = all_zero(legacy);
  if (rc != -1 || checked_zero || legacy_zero) {
    fprintf(stderr, "%s fail-open rc=%d checked_zero=%d hash_zero=%d\n",
            name, rc, checked_zero, legacy_zero);
    return 1;
  }
  printf("%s rc=%d\n", name, rc);
  return 0;
}

int main(void) {
  int max_vm = shear_alloc_fail_max_vm();
  printf("max_vm=%d\n", max_vm);
  if (max_vm != 8) {
    fprintf(stderr, "SHEAR_MAX_VM build is %d, want 8\n", max_vm);
    return 1;
  }

  unsigned char header[SHEAR_HEADER_LEN];
  memset(header, 0, sizeof header);
  header[0] = 1;

  g_fail_cache = 1;
  g_fail_vm = 1;
  if (expect_closed("cache", header)) return 1;

  /* Same key is not live: cache alloc failed before g_have. A distinct
   * header still takes the init path if a later case left a key behind. */
  header[0] = 2;
  g_fail_cache = 0;
  g_fail_vm = 1;
  if (expect_closed("vm", header)) return 1;

  printf("allocation-failure-not-zero\n");
  return 0;
}
