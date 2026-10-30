#include "shear_hash.h"

#include <stdio.h>
#include <string.h>

#if defined(__ANDROID__)
#include <android/log.h>
#endif
#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

/* The wallet uses RandomX only to check header PoW, in LIGHT mode with the
 * INTERPRETER (Russell, 28 Oct): no JIT, no full dataset, on every
 * platform. The JIT probe this library once ran in-process could not be made
 * crash-safe (a fault in the probe kills the app: Samsung S24 Ultra,
 * Android 16, 28 Oct), so the wallet never selects the JIT. On Android and
 * iOS that is also enforced at compile time below.
 *
 * One native hash at a time. The RandomX cache is process-global, and the
 * key changes with the previous hash, so overlapping calls would rebuild it
 * under each other. */

#if defined(__ANDROID__) || (defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE)
#define SHEAR_V3_MOBILE 1
#else
#define SHEAR_V3_MOBILE 0
#endif

#define SHEAR_V3_BACKEND "interpreter"
#define SHEAR_V3_MODE "light"

/* Compile-time guard: a mobile build has exactly one backend name, the
 * interpreter. */
#if SHEAR_V3_MOBILE
_Static_assert(sizeof(SHEAR_V3_BACKEND) == sizeof("interpreter"), "mobile wallet: interpreter only");
#endif

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

static void v3_log(const char *line) {
#if defined(__ANDROID__)
  __android_log_print(ANDROID_LOG_INFO, "shear_v3", "%s", line);
#else
  fprintf(stderr, "shear_v3: %s\n", line);
#endif
}

static int g_ready = 0;

static void v3_once(void) {
  if (g_ready) return;
  shear_hash_set_backend(SHEAR_V3_BACKEND);
  /* The light interpreter, or the library refuses to hash (shear_v3_hash
   * then writes zeros, which the Dart side reads as "no digest"). */
  g_ready = strcmp(shear_hash_backend(), SHEAR_V3_BACKEND) == 0 ? 1 : -1;
  v3_log(g_ready == 1 ? "backend=interpreter mode=light" : "backend refused: not the light interpreter");
}

#if defined(__GNUC__) || defined(__clang__)
__attribute__((constructor)) static void shear_v3_ctor(void) {
  v3_lock();
  v3_once();
  v3_unlock();
}
#endif

/* "interpreter" when the light interpreter is in use, else "none". */
const char *shear_v3_backend(void) {
  v3_lock();
  v3_once();
  const char *name = g_ready == 1 ? SHEAR_V3_BACKEND : "none";
  v3_unlock();
  return name;
}

/* "light". */
const char *shear_v3_mode(void) { return SHEAR_V3_MODE; }

/* A request for any backend but the interpreter is refused and logged; the
 * interpreter stays. Returns 0 when [name] is the interpreter, -1 else. */
int shear_v3_request_backend(const char *name) {
  if (name && strcmp(name, SHEAR_V3_BACKEND) == 0) return 0;
  char line[96];
  snprintf(line, sizeof line, "refused backend request \"%.40s\": interpreter only", name ? name : "(null)");
  v3_log(line);
  return -1;
}

void shear_v3_hash(const unsigned char header[128], unsigned char out[32]) {
  v3_lock();
  v3_once();
  if (g_ready == 1) {
    shear_hash(header, out);
  } else {
    memset(out, 0, 32);
  }
  v3_unlock();
}
