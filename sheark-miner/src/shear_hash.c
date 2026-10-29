#if defined(__linux__)
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#endif
#include "shear_hash.h"
#include "sha256.h"
#include "sha512.h"
#include "randomx.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#include <windows.h>
#else
#include <unistd.h>
#endif
#if defined(__linux__)
#include <sys/mman.h>
#endif

static const char V1_SELFTEST[] =
    "5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066";

const char SHEAR_SELFTEST_HASH[] =
    "e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4";

#define SHEAR_MAX_VM 256

static pthread_rwlock_t g_rx;
static pthread_once_t g_rx_once = PTHREAD_ONCE_INIT;
static pthread_key_t g_vm_key;
static int g_key_ok = 0;
static randomx_cache *g_cache = NULL;
static randomx_dataset *g_dataset = NULL;
static unsigned char g_k[32];
static int g_have = 0;
static atomic_uint g_gen;
static atomic_int g_in_hash;
static randomx_flags g_flags = RANDOMX_FLAG_DEFAULT;
static const char *g_backend = "interpreter";
static randomx_vm *g_vms[SHEAR_MAX_VM];
static atomic_int g_tid_n;

typedef struct {
  randomx_vm *vm;
  unsigned gen;
  unsigned epoch;
  int tid;
  int primed;
} RxTls;

static atomic_uint g_epoch;
static pthread_mutex_t g_prep_mu = PTHREAD_MUTEX_INITIALIZER;
static atomic_int g_prep_state; /* 0 idle, 1 running, 2 ready */
static pthread_t g_prep_th;
static int g_prep_join;
static unsigned char g_prep_want_k[32];
static unsigned char g_prep_k[32];
static randomx_cache *g_prep_cache;
static randomx_dataset *g_prep_dataset;
static randomx_cache *g_stale_cache;
static randomx_dataset *g_stale_dataset;

static void rx_lock_init(void) {
#if defined(__linux__)
  pthread_rwlockattr_t a;
  pthread_rwlockattr_init(&a);
  pthread_rwlockattr_setkind_np(&a, PTHREAD_RWLOCK_PREFER_WRITER_NONRECURSIVE_NP);
  pthread_rwlock_init(&g_rx, &a);
  pthread_rwlockattr_destroy(&a);
#else
  pthread_rwlock_init(&g_rx, NULL);
#endif
}

static void cpu_relax(void) {
#if defined(_MSC_VER)
  _mm_pause();
#elif defined(__x86_64__) || defined(__i386__)
  __asm__ __volatile__("pause");
#elif defined(__aarch64__)
  __asm__ __volatile__("yield");
#endif
}

static void rx_wr(void) {
  pthread_once(&g_rx_once, rx_lock_init);
  pthread_rwlock_wrlock(&g_rx);
}

static void rx_un(void) {
  pthread_rwlock_unlock(&g_rx);
}

/* Invalidate VMs, then wait for in-flight calculate_hash* to finish before
 * the writer mutates cache/VMs. Hashers bump g_in_hash instead of rdlock. */
static void wait_hash_idle(void) {
  while (atomic_load_explicit(&g_in_hash, memory_order_acquire) != 0) {
    cpu_relax();
  }
}

static void exclusive_begin(void) {
  rx_wr();
  atomic_fetch_add_explicit(&g_gen, 1, memory_order_release);
  wait_hash_idle();
}

static int hash_enter(unsigned gen, randomx_vm *vm, int tid) {
  atomic_fetch_add_explicit(&g_in_hash, 1, memory_order_acq_rel);
  if (atomic_load_explicit(&g_gen, memory_order_acquire) != gen ||
      tid < 0 || tid >= SHEAR_MAX_VM || g_vms[tid] != vm) {
    atomic_fetch_sub_explicit(&g_in_hash, 1, memory_order_release);
    return -1;
  }
  return 0;
}

static void hash_leave(void) {
  atomic_fetch_sub_explicit(&g_in_hash, 1, memory_order_release);
}

void shear_hash_hex(const unsigned char hash[32], char hex[65]) {
  static const char *digits = "0123456789abcdef";
  for (int i = 0; i < 32; i++) {
    hex[i * 2] = digits[hash[i] >> 4];
    hex[i * 2 + 1] = digits[hash[i] & 15];
  }
  hex[64] = 0;
}

void shear_set_nonce(unsigned char header[SHEAR_HEADER_LEN], uint64_t nonce) {
  for (int i = 0; i < 8; i++) {
    header[112 + i] = (unsigned char)(nonce & 0xff);
    nonce >>= 8;
  }
}

void shear_key(const unsigned char header[SHEAR_HEADER_LEN], unsigned char k[32]) {
  unsigned char buf[16 + 32 + 32 + 32 + 4];
  unsigned char out[64];
  memcpy(buf, SHEAR_KEY_PERSONAL, 16);
  memcpy(buf + 16, header + 4, 32);
  memcpy(buf + 48, header + 68, 32);
  memcpy(buf + 80, header + 36, 32);
  memcpy(buf + 112, header + 108, 4);
  shear_sha512(buf, sizeof(buf), out);
  memcpy(k, out, 32);
}

static void tls_free(void *p) {
  RxTls *t = (RxTls *)p;
  if (!t) return;
  free(t);
}

/* R41: once, then lock-free. It took g_key_mu on every hash call, one
 * process-wide mutex every worker passed through per digest. */
static pthread_once_t g_key_once = PTHREAD_ONCE_INIT;
static void make_tls_key(void) {
  if (pthread_key_create(&g_vm_key, tls_free) == 0) g_key_ok = 1;
}

static void ensure_tls_key(void) {
  pthread_once(&g_key_once, make_tls_key);
}

static RxTls *tls_slot(void) {
  ensure_tls_key();
  if (!g_key_ok) return NULL;
  RxTls *tls = (RxTls *)pthread_getspecific(g_vm_key);
  if (!tls) {
    tls = (RxTls *)calloc(1, sizeof(*tls));
    if (!tls) return NULL;
    tls->tid = -1;
    pthread_setspecific(g_vm_key, tls);
  }
  if (tls->tid < 0) {
    int n = atomic_fetch_add_explicit(&g_tid_n, 1, memory_order_relaxed);
    if (n >= SHEAR_MAX_VM) n = SHEAR_MAX_VM - 1;
    tls->tid = n;
  }
  return tls;
}

static void destroy_all_vms_locked(void) {
  int n = atomic_load_explicit(&g_tid_n, memory_order_relaxed);
  if (n > SHEAR_MAX_VM) n = SHEAR_MAX_VM;
  for (int i = 0; i < n; i++) {
    if (g_vms[i]) {
      randomx_destroy_vm(g_vms[i]);
      g_vms[i] = NULL;
    }
  }
}

static void release_rx_pair(randomx_cache **c, randomx_dataset **d);

static void drop_cache_locked(void) {
  destroy_all_vms_locked();
  pthread_mutex_lock(&g_prep_mu);
  if (g_prep_join) {
    pthread_mutex_unlock(&g_prep_mu);
    pthread_join(g_prep_th, NULL);
    pthread_mutex_lock(&g_prep_mu);
    g_prep_join = 0;
  }
  release_rx_pair(&g_prep_cache, &g_prep_dataset);
  release_rx_pair(&g_stale_cache, &g_stale_dataset);
  atomic_store_explicit(&g_prep_state, 0, memory_order_release);
  pthread_mutex_unlock(&g_prep_mu);
  if (g_dataset) {
    randomx_release_dataset(g_dataset);
    g_dataset = NULL;
  }
  if (g_cache) {
    randomx_release_cache(g_cache);
    g_cache = NULL;
  }
  g_have = 0;
  atomic_fetch_add_explicit(&g_gen, 1, memory_order_release);
}

/* What this CPU has, from randomx_get_flags() at run time: AES-NI or the
 * ARMv8 crypto extension, Argon2 SSSE3/AVX2. SHEARK_TEST_SOFT_AES (bench
 * builds only) hides hardware AES so the soft-AES path can be checked
 * against the golden corpus on any host. */
static randomx_flags cpu_flags(void) {
  randomx_flags f = randomx_get_flags();
#if defined(SHEARK_TEST_SOFT_AES)
  f = (randomx_flags)(f & ~RANDOMX_FLAG_HARD_AES);
#endif
  return f;
}

static randomx_flags flags_interpreter(void) {
  randomx_flags f = cpu_flags();
  f = (randomx_flags)(f & ~RANDOMX_FLAG_FULL_MEM);
  f = (randomx_flags)(f & ~RANDOMX_FLAG_JIT);
  f = (randomx_flags)(f | RANDOMX_FLAG_LARGE_PAGES);
  return f;
}

/* Fastest path this book will accept: compiled light VM + hardware AES +
 * 2 MiB pages over the 128 MiB cache. jit-full is the 260 MiB dataset;
 * RandomX light-verify is the same digest (selftest matches). Keep
 * RANDOMX_FLAG_SECURE when get_flags set it (Apple aarch64 W^X).
 * R41: hardware AES only when the CPU has it. Forcing the flag ran AES-NI
 * (or ARMv8 AES) instructions on a CPU without them: SIGILL, e.g. on a
 * Raspberry Pi 4 or a VM whose CPU model hides AES. Soft AES is the same
 * digest. */
static randomx_flags flags_jit_light(void) {
  randomx_flags f = cpu_flags();
  f = (randomx_flags)(f & ~RANDOMX_FLAG_FULL_MEM);
  f = (randomx_flags)(f | RANDOMX_FLAG_JIT | RANDOMX_FLAG_LARGE_PAGES);
  return f;
}

static randomx_flags flags_jit_full(void) {
  randomx_flags f = flags_jit_light();
  f = (randomx_flags)(f | RANDOMX_FLAG_FULL_MEM);
  return f;
}

/* R41: with no reserved 2 MiB pages (hugetlb), the dataset falls back to 4K
 * pages. Ask the kernel for transparent huge pages on it before it is first
 * written, so the random dataset reads stop missing the TLB. Advice only: the
 * kernel may decline (THP "never"), and the bytes are the same either way. */
static void advise_thp(void *p, size_t n) {
#if defined(__linux__) && defined(MADV_HUGEPAGE)
  const uintptr_t huge = (uintptr_t)2 << 20;
  uintptr_t a = ((uintptr_t)p + huge - 1) & ~(huge - 1);
  uintptr_t e = ((uintptr_t)p + n) & ~(huge - 1);
  if (p && e > a) (void)madvise((void *)a, (size_t)(e - a), MADV_HUGEPAGE);
#else
  (void)p;
  (void)n;
#endif
}

/* The 4K fallback message says what the dataset gets instead. */
static void note_no_hugepages(void) {
#if defined(__linux__)
  char mode[128] = "";
  FILE *f = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (f) {
    if (!fgets(mode, sizeof(mode), f)) mode[0] = 0;
    fclose(f);
  }
  if (strstr(mode, "[never]")) {
    fprintf(stderr, "ShearK-Miner: huge pages unavailable (none reserved) and transparent huge pages are off; using 4K pages\n");
  } else {
    fprintf(stderr, "ShearK-Miner: huge pages unavailable (none reserved); using 4K pages with transparent huge pages\n");
  }
#else
  fprintf(stderr, "ShearK-Miner: huge pages unavailable, using 4K pages\n");
#endif
}

static randomx_cache *alloc_cache(randomx_flags flags) {
  return randomx_alloc_cache(flags);
}

typedef struct {
  randomx_dataset *ds;
  randomx_cache *cache;
  unsigned long start;
  unsigned long count;
} DsSlice;

static void *dataset_slice(void *arg) {
  DsSlice *s = (DsSlice *)arg;
  randomx_init_dataset(s->ds, s->cache, s->start, s->count);
  return NULL;
}

static int init_dataset_on(randomx_cache *cache, randomx_dataset **ds_out) {
  if (!(g_flags & RANDOMX_FLAG_FULL_MEM)) {
    if (ds_out) *ds_out = NULL;
    return 0;
  }
  if (!cache || !ds_out) return -1;
  randomx_dataset *ds = *ds_out;
  if (!ds) {
    ds = (g_flags & RANDOMX_FLAG_LARGE_PAGES) ? randomx_alloc_dataset(g_flags) : NULL;
    if (!ds) {
      ds = randomx_alloc_dataset((randomx_flags)(g_flags & ~RANDOMX_FLAG_LARGE_PAGES));
      if (ds) advise_thp(randomx_get_dataset_memory(ds), (size_t)randomx_dataset_item_count() * RANDOMX_DATASET_ITEM_SIZE);
    }
  }
  if (!ds) {
    fprintf(stderr, "ShearK-Miner: dataset alloc failed\n");
    return -1;
  }
  *ds_out = ds;
  unsigned long n = randomx_dataset_item_count();
  int t = 4;
#if !defined(_WIN32)
  long ncpu = sysconf(_SC_NPROCESSORS_ONLN);
  if (ncpu >= 2 && ncpu < t) t = (int)ncpu;
#endif
  if (t < 1) t = 1;
  if (t == 1) {
    randomx_init_dataset(ds, cache, 0, n);
    return 0;
  }
  pthread_t th[8];
  DsSlice sl[8];
  if (t > 8) t = 8;
  unsigned long chunk = (n + (unsigned long)t - 1) / (unsigned long)t;
  int launched = 0;
  for (int i = 0; i < t; i++) {
    unsigned long start = (unsigned long)i * chunk;
    if (start >= n) break;
    unsigned long count = chunk;
    if (start + count > n) count = n - start;
    sl[i].ds = ds;
    sl[i].cache = cache;
    sl[i].start = start;
    sl[i].count = count;
    if (pthread_create(&th[launched], NULL, dataset_slice, &sl[i]) == 0) launched++;
    else randomx_init_dataset(ds, cache, start, count);
  }
  for (int i = 0; i < launched; i++) pthread_join(th[i], NULL);
  return 0;
}

static int init_dataset_locked(void) {
  return init_dataset_on(g_cache, &g_dataset);
}

static void release_rx_pair(randomx_cache **c, randomx_dataset **d) {
  if (d && *d) {
    randomx_release_dataset(*d);
    *d = NULL;
  }
  if (c && *c) {
    randomx_release_cache(*c);
    *c = NULL;
  }
}

static randomx_vm *create_vm_locked(void) {
  randomx_dataset *ds = (g_flags & RANDOMX_FLAG_FULL_MEM) ? g_dataset : NULL;
  if ((g_flags & RANDOMX_FLAG_FULL_MEM) && !ds) return NULL;
  randomx_vm *vm = randomx_create_vm(g_flags, g_cache, ds);
  if (!vm && (g_flags & RANDOMX_FLAG_LARGE_PAGES)) {
    vm = randomx_create_vm((randomx_flags)(g_flags & ~RANDOMX_FLAG_LARGE_PAGES), g_cache, ds);
  }
  return vm;
}

static int init_cache_locked(const unsigned char k[32]);
static int backend_matches_selftest_locked(void);

/* Why the last stand_up_locked() failed, for the fallback log line. */
static const char *g_standup_why = "";

/* Stand up one backend from scratch: cache (2 MiB pages first, then 4K),
 * the probe key, the dataset when FULL_MEM, and a probe VM (W^X retry with
 * RANDOMX_FLAG_SECURE). 0 when it works; on failure everything is dropped
 * and g_standup_why says what failed. */
static int stand_up_locked(randomx_flags f) {
  unsigned char header[SHEAR_HEADER_LEN];
  unsigned char k[32];
  drop_cache_locked();
  g_flags = f;
  g_standup_why = "";
  g_cache = alloc_cache(g_flags);
  if (!g_cache && (g_flags & RANDOMX_FLAG_LARGE_PAGES)) {
    g_flags = (randomx_flags)(g_flags & ~RANDOMX_FLAG_LARGE_PAGES);
    g_cache = alloc_cache(g_flags);
    if (g_cache) note_no_hugepages();
  }
  if (!g_cache) {
    g_standup_why = "cache alloc failed";
    return -1;
  }
  memset(header, 0, SHEAR_HEADER_LEN);
  header[0] = 1;
  shear_key(header, k);
  if (init_cache_locked(k) != 0) {
    g_standup_why = (g_flags & RANDOMX_FLAG_FULL_MEM) ? "dataset alloc failed" : "cache init failed";
    drop_cache_locked();
    return -1;
  }
  if (g_flags & RANDOMX_FLAG_JIT) {
    randomx_vm *probe = create_vm_locked();
    if (!probe) {
      g_flags = (randomx_flags)(g_flags | RANDOMX_FLAG_SECURE);
      probe = create_vm_locked();
    }
    if (!probe) {
      g_standup_why = "JIT VM create failed";
      drop_cache_locked();
      return -1;
    }
    randomx_destroy_vm(probe);
  }
  return 0;
}

/* PR146 fix (P1-1): jit-full -> light JIT -> interpreter, in that order.
 * A dataset that cannot be allocated (cgroup/ulimit/RAM) used to drop
 * straight to the interpreter (~140x slower than jit-full, ~17x slower than
 * light JIT); it now lands on light JIT and the log line says why. */
int shear_hash_set_backend(const char *name) {
  randomx_flags next = flags_jit_light();
  const char *label = "jit";
  if (name && (strcmp(name, "jit") == 0 || strcmp(name, "auto") == 0)) {
    next = flags_jit_light();
    label = "jit";
  } else if (name && strcmp(name, "jit-full") == 0) {
    next = flags_jit_full();
    label = "jit-full";
    fprintf(stderr, "ShearK-Miner: jit-full uses the 260 MiB dataset; pool/node still light-verify (same digest)\n");
  } else if (name && strcmp(name, "interpreter") == 0) {
    next = flags_interpreter();
    label = "interpreter";
  }
  exclusive_begin();
  int ok = -1;
  if (next & RANDOMX_FLAG_FULL_MEM) {
    if (stand_up_locked(next) == 0) {
      if (backend_matches_selftest_locked()) {
        ok = 0;
      } else {
        drop_cache_locked();
        fprintf(stderr, "ShearK-Miner: dataset path failed selftest, using light JIT\n");
      }
    } else {
      unsigned long mib = (unsigned long)(((unsigned long long)randomx_dataset_item_count() * RANDOMX_DATASET_ITEM_SIZE) >> 20);
      fprintf(stderr, "ShearK-Miner: jit-full unavailable (%s, %lu MiB dataset); using light JIT\n", g_standup_why, mib);
    }
    if (ok != 0) {
      next = flags_jit_light();
      label = "jit";
    }
  }
  if (ok != 0 && (next & RANDOMX_FLAG_JIT)) {
    if (stand_up_locked(next) == 0) {
      ok = 0;
    } else {
      fprintf(stderr, "ShearK-Miner: light JIT unavailable (%s); using interpreter\n", g_standup_why);
      next = flags_interpreter();
      label = "interpreter";
    }
  }
  if (ok != 0) {
    if (stand_up_locked(next) == 0) {
      ok = 0;
    } else {
      fprintf(stderr, "ShearK-Miner: interpreter unavailable (%s); no hash backend\n", g_standup_why);
      label = "none";
    }
  }
  g_backend = label;
  rx_un();
  return ok;
}

const char *shear_hash_backend(void) {
  return g_backend;
}

int shear_hash_huge_pages(void) {
  return (g_flags & RANDOMX_FLAG_LARGE_PAGES) ? 1 : 0;
}

int shear_hash_hard_aes(void) {
  return (g_flags & RANDOMX_FLAG_HARD_AES) ? 1 : 0;
}

static int init_cache_locked(const unsigned char k[32]) {
  if (!g_cache) {
    g_cache = alloc_cache(g_flags);
    if (!g_cache && (g_flags & RANDOMX_FLAG_LARGE_PAGES)) {
      g_flags = (randomx_flags)(g_flags & ~RANDOMX_FLAG_LARGE_PAGES);
      g_cache = alloc_cache(g_flags);
      note_no_hugepages();
    }
    if (!g_cache && (g_flags & RANDOMX_FLAG_JIT)) {
      g_flags = flags_interpreter();
      g_backend = "interpreter";
      g_cache = alloc_cache(g_flags);
      if (!g_cache && (g_flags & RANDOMX_FLAG_LARGE_PAGES)) {
        g_flags = (randomx_flags)(g_flags & ~RANDOMX_FLAG_LARGE_PAGES);
        g_cache = alloc_cache(g_flags);
      }
    }
    if (!g_cache) return -1;
  }
  randomx_init_cache(g_cache, k, 32);
  if (g_flags & RANDOMX_FLAG_FULL_MEM) {
    if (init_dataset_locked() != 0) return -1;
  }
  memcpy(g_k, k, 32);
  g_have = 1;
  atomic_fetch_add_explicit(&g_gen, 1, memory_order_release);
  return 0;
}

static int backend_matches_selftest_locked(void) {
  unsigned char header[SHEAR_HEADER_LEN];
  unsigned char hash[32];
  char hex[65];
  memset(header, 0, SHEAR_HEADER_LEN);
  header[0] = 1;
  randomx_vm *vm = create_vm_locked();
  if (!vm) {
    fprintf(stderr, "ShearK-Miner: dataset VM create failed flags=%u dataset=%p\n",
            (unsigned)g_flags, (void *)g_dataset);
    return 0;
  }
  randomx_calculate_hash(vm, header, SHEAR_HEADER_LEN, hash);
  randomx_destroy_vm(vm);
  shear_hash_hex(hash, hex);
  if (strcmp(hex, SHEAR_SELFTEST_HASH) != 0) {
    fprintf(stderr, "ShearK-Miner: dataset digest %s expected %s\n", hex, SHEAR_SELFTEST_HASH);
    return 0;
  }
  return 1;
}

static void prep_join_locked(void) {
  if (g_prep_join) {
    pthread_mutex_unlock(&g_prep_mu);
    pthread_join(g_prep_th, NULL);
    pthread_mutex_lock(&g_prep_mu);
    g_prep_join = 0;
  }
}

static void *prep_thread(void *arg) {
  (void)arg;
  unsigned char k[32];
  pthread_mutex_lock(&g_prep_mu);
  memcpy(k, g_prep_want_k, 32);
  pthread_mutex_unlock(&g_prep_mu);
  randomx_cache *cache = alloc_cache(g_flags);
  if (!cache && (g_flags & RANDOMX_FLAG_LARGE_PAGES)) {
    cache = alloc_cache((randomx_flags)(g_flags & ~RANDOMX_FLAG_LARGE_PAGES));
  }
  if (!cache) {
    atomic_store_explicit(&g_prep_state, 0, memory_order_release);
    return NULL;
  }
  randomx_init_cache(cache, k, 32);
  randomx_dataset *ds = NULL;
  if (init_dataset_on(cache, &ds) != 0) {
    randomx_release_cache(cache);
    atomic_store_explicit(&g_prep_state, 0, memory_order_release);
    return NULL;
  }
  pthread_mutex_lock(&g_prep_mu);
  if (memcmp(k, g_prep_want_k, 32) != 0) {
    pthread_mutex_unlock(&g_prep_mu);
    release_rx_pair(&cache, &ds);
    atomic_store_explicit(&g_prep_state, 0, memory_order_release);
    return NULL;
  }
  release_rx_pair(&g_prep_cache, &g_prep_dataset);
  g_prep_cache = cache;
  g_prep_dataset = ds;
  memcpy(g_prep_k, k, 32);
  atomic_store_explicit(&g_prep_state, 2, memory_order_release);
  pthread_mutex_unlock(&g_prep_mu);
  return NULL;
}

int shear_prepare(const unsigned char header[SHEAR_HEADER_LEN]) {
  unsigned char k[32];
  shear_key(header, k);
  if (g_have && memcmp(g_k, k, 32) == 0) return 0;
  pthread_mutex_lock(&g_prep_mu);
  int st = atomic_load_explicit(&g_prep_state, memory_order_acquire);
  if (st == 2 && memcmp(g_prep_k, k, 32) == 0) {
    pthread_mutex_unlock(&g_prep_mu);
    return 0;
  }
  if (st == 1 && memcmp(g_prep_want_k, k, 32) == 0) {
    pthread_mutex_unlock(&g_prep_mu);
    return 1;
  }
  memcpy(g_prep_want_k, k, 32);
  if (st == 1 || g_prep_join) prep_join_locked();
  release_rx_pair(&g_stale_cache, &g_stale_dataset);
  atomic_store_explicit(&g_prep_state, 1, memory_order_release);
  if (pthread_create(&g_prep_th, NULL, prep_thread, NULL) != 0) {
    atomic_store_explicit(&g_prep_state, 0, memory_order_release);
    pthread_mutex_unlock(&g_prep_mu);
    return -1;
  }
  g_prep_join = 1;
  pthread_mutex_unlock(&g_prep_mu);
  return 1;
}

int shear_epoch_ready(const unsigned char header[SHEAR_HEADER_LEN]) {
  unsigned char k[32];
  shear_key(header, k);
  if (g_have && memcmp(g_k, k, 32) == 0) return 1;
  if (atomic_load_explicit(&g_prep_state, memory_order_acquire) == 2 && memcmp(g_prep_k, k, 32) == 0) return 1;
  return 0;
}

int shear_commit_epoch(void) {
  pthread_mutex_lock(&g_prep_mu);
  if (atomic_load_explicit(&g_prep_state, memory_order_acquire) != 2 || !g_prep_cache) {
    pthread_mutex_unlock(&g_prep_mu);
    return -1;
  }
  if (g_have && memcmp(g_k, g_prep_k, 32) == 0) {
    release_rx_pair(&g_prep_cache, &g_prep_dataset);
    atomic_store_explicit(&g_prep_state, 0, memory_order_release);
    pthread_mutex_unlock(&g_prep_mu);
    return 0;
  }
  release_rx_pair(&g_stale_cache, &g_stale_dataset);
  g_stale_cache = g_cache;
  g_stale_dataset = g_dataset;
  g_cache = g_prep_cache;
  g_dataset = g_prep_dataset;
  g_prep_cache = NULL;
  g_prep_dataset = NULL;
  memcpy(g_k, g_prep_k, 32);
  g_have = 1;
  atomic_store_explicit(&g_prep_state, 0, memory_order_release);
  atomic_fetch_add_explicit(&g_epoch, 1, memory_order_release);
  pthread_mutex_unlock(&g_prep_mu);
  return 0;
}

int shear_bind(const unsigned char header[SHEAR_HEADER_LEN]) {
  unsigned char k[32];
  RxTls *tls = tls_slot();
  if (!tls) return -1;
  shear_key(header, k);
  unsigned gen = atomic_load_explicit(&g_gen, memory_order_acquire);
  unsigned epoch = atomic_load_explicit(&g_epoch, memory_order_acquire);
  int tid = tls->tid;
  if (g_vms[tid] && g_have && tls->gen == gen && tls->epoch == epoch && memcmp(g_k, k, 32) == 0) {
    tls->vm = g_vms[tid];
    tls->primed = 0;
    return 0;
  }
  if (g_vms[tid] && g_have && memcmp(g_k, k, 32) == 0) {
    if (g_flags & RANDOMX_FLAG_FULL_MEM) randomx_vm_set_dataset(g_vms[tid], g_dataset);
    else randomx_vm_set_cache(g_vms[tid], g_cache);
    tls->vm = g_vms[tid];
    tls->gen = gen;
    tls->epoch = epoch;
    tls->primed = 0;
    return 0;
  }

  rx_wr();
  if (!g_have || memcmp(g_k, k, 32) != 0) {
    atomic_fetch_add_explicit(&g_gen, 1, memory_order_release);
    wait_hash_idle();
    if (init_cache_locked(k) != 0) {
      rx_un();
      return -1;
    }
    int nvm = atomic_load_explicit(&g_tid_n, memory_order_relaxed);
    if (nvm > SHEAR_MAX_VM) nvm = SHEAR_MAX_VM;
    for (int i = 0; i < nvm; i++) {
      if (!g_vms[i]) continue;
      if (g_flags & RANDOMX_FLAG_FULL_MEM) randomx_vm_set_dataset(g_vms[i], g_dataset);
      else randomx_vm_set_cache(g_vms[i], g_cache);
    }
  }
  tid = tls->tid;
  if (!g_vms[tid]) g_vms[tid] = create_vm_locked();
  tls->vm = g_vms[tid];
  tls->gen = atomic_load_explicit(&g_gen, memory_order_relaxed);
  tls->primed = 0;
  rx_un();
  return tls->vm ? 0 : -1;
}

static randomx_vm *hot_vm(RxTls *tls, unsigned *gen_out) {
  unsigned gen = atomic_load_explicit(&g_gen, memory_order_acquire);
  int tid = tls->tid;
  randomx_vm *vm = (tid >= 0 && tid < SHEAR_MAX_VM) ? g_vms[tid] : NULL;
  if (!vm || tls->gen != gen) return NULL;
  *gen_out = gen;
  return vm;
}

void shear_hash(const unsigned char header[SHEAR_HEADER_LEN], unsigned char out[32]) {
  RxTls *tls = tls_slot();
  if (!tls) {
    memset(out, 0, 32);
    return;
  }
  for (;;) {
    if (shear_bind(header) != 0) {
      memset(out, 0, 32);
      return;
    }
    unsigned gen = 0;
    randomx_vm *vm = hot_vm(tls, &gen);
    if (!vm) continue;
    if (hash_enter(gen, vm, tls->tid) != 0) continue;
    randomx_calculate_hash(vm, header, SHEAR_HEADER_LEN, out);
    hash_leave();
    tls->primed = 0;
    return;
  }
}

int shear_hash_first(const unsigned char header[SHEAR_HEADER_LEN]) {
  RxTls *tls = tls_slot();
  if (!tls) return -1;
  if (shear_bind(header) != 0) return -1;
  unsigned gen = 0;
  randomx_vm *vm = hot_vm(tls, &gen);
  if (!vm) return -1;
  if (hash_enter(gen, vm, tls->tid) != 0) {
    tls->primed = 0;
    return -1;
  }
  randomx_calculate_hash_first(vm, header, SHEAR_HEADER_LEN);
  hash_leave();
  tls->primed = 1;
  return 0;
}

int shear_hash_next(const unsigned char header[SHEAR_HEADER_LEN], unsigned char out[32]) {
  RxTls *tls = tls_slot();
  if (!tls || !tls->primed) return -1;
  unsigned char k[32];
  shear_key(header, k);
  if (!g_have || memcmp(g_k, k, 32) != 0) {
    tls->primed = 0;
    return -1;
  }
  unsigned gen = 0;
  randomx_vm *vm = hot_vm(tls, &gen);
  if (!vm) {
    tls->primed = 0;
    return -1;
  }
  if (hash_enter(gen, vm, tls->tid) != 0) {
    tls->primed = 0;
    return -1;
  }
  randomx_calculate_hash_next(vm, header, SHEAR_HEADER_LEN, out);
  hash_leave();
  tls->primed = 1;
  return 0;
}

static int shear_meets_lz(const unsigned char hash[32], int bits) {
  if (bits <= 0) return 1;
  if (bits > 256) bits = 256;
  int full = bits / 8;
  int rem = bits % 8;
  for (int i = 0; i < full; i++) {
    if (hash[i] != 0) return 0;
  }
  if (!rem) return 1;
  return hash[full] < (1 << (8 - rem));
}

void shear_note_commit(const unsigned char dest20[20], unsigned char out[32]) {
  static const char dst[] = "shear-note-commit-v1";
  unsigned char msg[sizeof(dst) - 1 + 20];
  memcpy(msg, dst, sizeof(dst) - 1);
  memcpy(msg + sizeof(dst) - 1, dest20, 20);
  shear_sha256(msg, sizeof(msg), out);
}

void shear_share_bind(const unsigned char rx[32], const unsigned char note_commit[32], unsigned char out[32]) {
  static const char dst[] = "shear-share-dest-v1";
  unsigned char msg[sizeof(dst) - 1 + 32 + 32];
  memcpy(msg, dst, sizeof(dst) - 1);
  memcpy(msg + sizeof(dst) - 1, rx, 32);
  memcpy(msg + sizeof(dst) - 1 + 32, note_commit, 32);
  shear_sha256(msg, sizeof(msg), out);
}

int shear_meets_target(const unsigned char hash[32], int bits) {
  /* Q16.16 packed work on the header after v4. Share bits stay 8–256.
   * The miner submits every shareBits hit; the node applies the fractional
   * target. Local packed check uses floor(LZ) so a share is never dropped. */
  if (bits >= 65536) {
    int lz = (int)((unsigned)bits / 65536u);
    return shear_meets_lz(hash, lz);
  }
  return shear_meets_lz(hash, bits);
}

static int parse_header_hex(const char *hex, unsigned char out[SHEAR_HEADER_LEN]) {
  if (!hex || strlen(hex) < SHEAR_HEADER_LEN * 2) return -1;
  for (int i = 0; i < SHEAR_HEADER_LEN; i++) {
    unsigned int b;
    if (sscanf(hex + i * 2, "%2x", &b) != 1) return -1;
    out[i] = (unsigned char)b;
  }
  return 0;
}

int shear_verify_header_hex(const char *header_hex, char digest_hex[65], char k_hex[65]) {
  unsigned char header[SHEAR_HEADER_LEN];
  unsigned char hash[32];
  unsigned char k[32];
  if (parse_header_hex(header_hex, header) != 0) return -1;
  shear_key(header, k);
  shear_hash(header, hash);
  if (digest_hex) shear_hash_hex(hash, digest_hex);
  if (k_hex) shear_hash_hex(k, k_hex);
  return 0;
}

int shear_selftest(char got_hex[65]) {
  unsigned char header[SHEAR_HEADER_LEN];
  unsigned char hash[32];
  unsigned char k[32];
  memset(header, 0, SHEAR_HEADER_LEN);
  header[0] = 1;
  shear_key(header, k);
  shear_hash(header, hash);
  shear_hash_hex(hash, got_hex);
  if (strcmp(got_hex, V1_SELFTEST) == 0) return 0;
  if (strcmp(SHEAR_SELFTEST_HASH, "0000000000000000000000000000000000000000000000000000000000000000") == 0) {
    return 1;
  }
  if (strcmp(got_hex, SHEAR_SELFTEST_HASH) != 0) return 0;
  /* hash_next must equal shear_hash of the previous header. A mismatch is
   * the live pool's bad_hash: claimed digest is not ShearHash-v3(header). */
  {
    unsigned char h0[SHEAR_HEADER_LEN], h1[SHEAR_HEADER_LEN];
    unsigned char full[32], piped[32];
    memcpy(h0, header, SHEAR_HEADER_LEN);
    memcpy(h1, header, SHEAR_HEADER_LEN);
    shear_set_nonce(h0, 1);
    shear_set_nonce(h1, 2);
    shear_hash(h0, full);
    if (shear_hash_first(h0) != 0) return 0;
    if (shear_hash_next(h1, piped) != 0) return 0;
    if (memcmp(full, piped, 32) != 0) return 0;
  }
  return 1;
}
