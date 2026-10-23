#include "shear_hash.h"

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

static void v3_once(void) {
  if (g_ready) return;
  shear_hash_set_backend("interpreter");
  g_ready = 1;
}

#if defined(__GNUC__) || defined(__clang__)
__attribute__((constructor)) static void shear_v3_ctor(void) {
  v3_lock();
  v3_once();
  v3_unlock();
}
#endif

void shear_v3_hash(const unsigned char header[128], unsigned char out[32]) {
  v3_lock();
  v3_once();
  shear_hash(header, out);
  v3_unlock();
}
