#include "shear_hash.h"

#include <string.h>

/* One native hash at a time. The RandomX cache is process-global, and the
 * key changes with the previous hash, so overlapping calls would rebuild it
 * under each other. */

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static SRWLOCK g_v3_lock = SRWLOCK_INIT;
static void v3_lock(void) { AcquireSRWLockExclusive(&g_v3_lock); }
static void v3_unlock(void) { ReleaseSRWLockExclusive(&g_v3_lock); }
#else
#include <pthread.h>
static pthread_mutex_t g_v3_lock = PTHREAD_MUTEX_INITIALIZER;
static void v3_lock(void) { pthread_mutex_lock(&g_v3_lock); }
static void v3_unlock(void) { pthread_mutex_unlock(&g_v3_lock); }
#endif

static int g_ready = 0;

/* The light JIT gives the interpreter's digest about four times faster per
 * hash (the Argon2 cache rebuild for each new key is the same either way).
 * It is used only after it reproduces the interpreter's digest on the
 * selftest header and on a header with every byte set; otherwise, or where
 * JIT memory is refused (shear_hash_set_backend falls back by itself), the
 * interpreter stays. The spec's rule holds: on disagreement, the light
 * interpreter wins. */
static void v3_once(void) {
  if (g_ready) return;
  unsigned char probe[2][128];
  unsigned char want[2][32];
  unsigned char got[32];
  memset(probe[0], 0, 128);
  probe[0][0] = 1;
  memset(probe[1], 0xa5, 128);
  probe[1][0] = 1;
  shear_hash_set_backend("interpreter");
  shear_hash(probe[0], want[0]);
  shear_hash(probe[1], want[1]);
  shear_hash_set_backend("jit");
  int same = strcmp(shear_hash_backend(), "jit") == 0;
  for (int i = 0; same && i < 2; i++) {
    shear_hash(probe[i], got);
    if (memcmp(got, want[i], 32) != 0) same = 0;
  }
  if (!same) shear_hash_set_backend("interpreter");
  g_ready = 1;
}

/* "jit" or "interpreter": the backend in use. */
const char *shear_v3_backend(void) {
  v3_lock();
  v3_once();
  const char *name = shear_hash_backend();
  v3_unlock();
  return name;
}

/* The load-time constructor only selects the interpreter (as before); the
 * JIT probe hashes, so it runs on the first hash call, not under the
 * dynamic loader's lock. */
#if defined(__GNUC__) || defined(__clang__)
__attribute__((constructor)) static void shear_v3_ctor(void) {
  v3_lock();
  shear_hash_set_backend("interpreter");
  v3_unlock();
}
#endif

void shear_v3_hash(const unsigned char header[128], unsigned char out[32]) {
  v3_lock();
  v3_once();
  shear_hash(header, out);
  v3_unlock();
}
