/*
 * rxbench (R41): ShearHash-v3 throughput and identity bench for ShearK-Miner.
 *
 * Links the miner's own shear_hash.o and librandomx, and drives the same
 * hash_first/hash_next pipeline the miner's workers use. Measurement only:
 * it opens no socket and writes nothing but stdout.
 *
 *   rxbench [--backend jit-full|jit|interpreter] [--threads 1,2,4] [--secs 20]
 *           [--warm 3] [--pin core|seq|none] [--epochs N] [--golden FILE]
 *
 * Every point ends with an identity check: each thread re-hashes its last
 * pipelined header with shear_hash() and compares the digest. --golden FILE
 * hashes "header digest" lines through the pipelined path and fails on any
 * mismatch.
 */
#if defined(__linux__)
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#endif
#include "shear_hash.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#if defined(__linux__)
#include <sched.h>
#include <unistd.h>
#endif
#if defined(_WIN32)
#include <windows.h>
#endif

#define MAXT 256

/* Defined in shear_hash.c; not in shear_hash.h. */
extern const char SHEAR_SELFTEST_HASH[];

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static int g_map[MAXT];
static int g_map_n = 0;
static int g_ncpu = 1;
static const char *g_pin = "core";

/* The miner's placement (device_inventory): one CPU per physical core first,
 * then the SMT siblings. */
static void cpu_map(void) {
#if defined(__linux__)
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  g_ncpu = n > 0 ? (int)n : 1;
  int cpus[MAXT], cores[MAXT], seen[4096], nn = 0, m = 0;
  memset(seen, 0, sizeof(seen));
  for (int cpu = 0; cpu < MAXT; cpu++) {
    char path[96];
    snprintf(path, sizeof(path), "/sys/devices/system/cpu/cpu%d/topology/core_id", cpu);
    FILE *f = fopen(path, "r");
    if (!f) break;
    int core = 0;
    if (fscanf(f, "%d", &core) != 1) core = cpu;
    fclose(f);
    cpus[nn] = cpu;
    cores[nn] = core;
    nn++;
  }
  for (int i = 0; i < nn; i++) {
    int c = cores[i] & 4095;
    if (seen[c]) continue;
    seen[c] = 1;
    g_map[m++] = cpus[i];
  }
  for (int i = 0; i < nn; i++) {
    int already = 0;
    for (int j = 0; j < m; j++) if (g_map[j] == cpus[i]) already = 1;
    if (!already) g_map[m++] = cpus[i];
  }
  g_map_n = m;
#elif defined(_WIN32)
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  g_ncpu = (int)si.dwNumberOfProcessors;
#endif
}

static void pin_self(int tid) {
#if defined(__linux__)
  if (strcmp(g_pin, "none") == 0) return;
  int cpu = tid % g_ncpu;
  if (strcmp(g_pin, "core") == 0 && g_map_n > 0) cpu = g_map[tid % g_map_n];
  cpu_set_t set;
  CPU_ZERO(&set);
  CPU_SET((unsigned)cpu, &set);
  pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
#else
  (void)tid;
#endif
}

/* Package energy (RAPL/powercap) in microjoules, or -1 when unreadable. */
static double rapl_uj(void) {
#if defined(__linux__)
  double sum = 0;
  int got = 0;
  for (int i = 0; i < 8; i++) {
    char path[96];
    snprintf(path, sizeof(path), "/sys/class/powercap/intel-rapl:%d/energy_uj", i);
    FILE *f = fopen(path, "r");
    if (!f) continue;
    unsigned long long v = 0;
    if (fscanf(f, "%llu", &v) == 1) {
      sum += (double)v;
      got = 1;
    }
    fclose(f);
  }
  return got ? sum : -1;
#else
  return -1;
#endif
}

static void mem_stats(long *rss_kb, long *thp_kb) {
  *rss_kb = -1;
  *thp_kb = -1;
#if defined(__linux__)
  FILE *f = fopen("/proc/self/smaps_rollup", "r");
  if (!f) return;
  char line[256];
  while (fgets(line, sizeof(line), f)) {
    long v;
    if (sscanf(line, "Rss: %ld kB", &v) == 1) *rss_kb = v;
    else if (sscanf(line, "AnonHugePages: %ld kB", &v) == 1) *thp_kb = v;
  }
  fclose(f);
#endif
}

typedef struct {
  int tid;
  int nthreads;
  uint64_t count;
  unsigned char last_hdr[SHEAR_HEADER_LEN];
  unsigned char last_out[32];
  int have_last;
  int ident_bad;
} Worker;

static atomic_int g_go;
static atomic_int g_stop;
static atomic_int g_counting;
static unsigned char g_header[SHEAR_HEADER_LEN];

static void *worker(void *arg) {
  Worker *w = (Worker *)arg;
  pin_self(w->tid);
  unsigned char hdr[SHEAR_HEADER_LEN], prev[SHEAR_HEADER_LEN], out[32];
  memcpy(hdr, g_header, SHEAR_HEADER_LEN);
  uint64_t n = (uint64_t)w->tid + 1000;
  int primed = 0;
  while (!atomic_load(&g_go)) { }
  while (!atomic_load_explicit(&g_stop, memory_order_relaxed)) {
    shear_set_nonce(hdr, n);
    n += (uint64_t)w->nthreads;
    if (!primed) {
      if (shear_hash_first(hdr) != 0) {
        shear_hash(hdr, out);
        if (atomic_load_explicit(&g_counting, memory_order_relaxed)) w->count++;
        continue;
      }
      primed = 1;
      memcpy(prev, hdr, SHEAR_HEADER_LEN);
      continue;
    }
    if (shear_hash_next(hdr, out) != 0) {
      primed = 0;
      continue;
    }
    if (atomic_load_explicit(&g_counting, memory_order_relaxed)) w->count++;
    memcpy(w->last_hdr, prev, SHEAR_HEADER_LEN);
    memcpy(w->last_out, out, 32);
    w->have_last = 1;
    memcpy(prev, hdr, SHEAR_HEADER_LEN);
  }
  if (w->have_last) {
    unsigned char check[32];
    shear_hash(w->last_hdr, check);
    if (memcmp(check, w->last_out, 32) != 0) w->ident_bad = 1;
  }
  return NULL;
}

static int run_point(const char *backend, int nthreads, double secs, double warm) {
  Worker *ws = calloc((size_t)nthreads, sizeof(Worker));
  pthread_t *th = calloc((size_t)nthreads, sizeof(pthread_t));
  if (!ws || !th) return 1;
  atomic_store(&g_go, 0);
  atomic_store(&g_stop, 0);
  atomic_store(&g_counting, 0);
  for (int i = 0; i < nthreads; i++) {
    ws[i].tid = i;
    ws[i].nthreads = nthreads;
    pthread_create(&th[i], NULL, worker, &ws[i]);
  }
  atomic_store(&g_go, 1);
  struct timespec ts = {(time_t)warm, (long)((warm - (double)(time_t)warm) * 1e9)};
  nanosleep(&ts, NULL);
  double e0 = rapl_uj();
  double t0 = now_s();
  atomic_store(&g_counting, 1);
  struct timespec ts2 = {(time_t)secs, (long)((secs - (double)(time_t)secs) * 1e9)};
  nanosleep(&ts2, NULL);
  atomic_store(&g_counting, 0);
  double t1 = now_s();
  double e1 = rapl_uj();
  long rss = -1, thp = -1;
  mem_stats(&rss, &thp);
  atomic_store(&g_stop, 1);
  uint64_t total = 0, mn = UINT64_MAX, mx = 0;
  int bad = 0;
  for (int i = 0; i < nthreads; i++) {
    pthread_join(th[i], NULL);
    total += ws[i].count;
    if (ws[i].count < mn) mn = ws[i].count;
    if (ws[i].count > mx) mx = ws[i].count;
    bad |= ws[i].ident_bad;
  }
  double dt = t1 - t0;
  double hs = (double)total / dt;
  char watts[32] = "na";
  if (e0 >= 0 && e1 >= e0) snprintf(watts, sizeof(watts), "%.1f", (e1 - e0) / 1e6 / dt);
  printf("point backend=%s threads=%d pin=%s secs=%.1f hashes=%llu hs=%.1f hs_per_thread=%.1f "
         "min_thread_hs=%.1f max_thread_hs=%.1f watts=%s rss_kb=%ld thp_kb=%ld hugepages=%d identity=%s\n",
         backend, nthreads, g_pin, dt, (unsigned long long)total, hs, hs / nthreads,
         (double)mn / dt, (double)mx / dt, watts, rss, thp, shear_hash_huge_pages(), bad ? "FAIL" : "ok");
  fflush(stdout);
  free(ws);
  free(th);
  return bad;
}

/* Time a K switch the way the miner does it: prepare in the background,
 * poll until ready, commit, and time the first pipelined hash after it. */
static int run_epochs(int n) {
  unsigned char hdr[SHEAR_HEADER_LEN], out[32];
  memcpy(hdr, g_header, SHEAR_HEADER_LEN);
  double sum = 0, mx = 0;
  for (int i = 0; i < n; i++) {
    hdr[4] = (unsigned char)(i + 1);
    hdr[5] = (unsigned char)((i + 1) >> 8);
    double t0 = now_s();
    int r = shear_prepare(hdr);
    if (r < 0) {
      printf("epoch prepare failed\n");
      return 1;
    }
    while (!shear_epoch_ready(hdr)) {
      struct timespec ts = {0, 1000000};
      nanosleep(&ts, NULL);
    }
    shear_commit_epoch();
    double t1 = now_s();
    shear_hash(hdr, out);
    double t2 = now_s();
    double d = t1 - t0;
    sum += d;
    if (d > mx) mx = d;
    printf("epoch i=%d ready_s=%.3f first_hash_s=%.4f\n", i, d, t2 - t1);
  }
  printf("epochs n=%d mean_ready_s=%.3f max_ready_s=%.3f backend=%s\n", n, sum / n, mx, shear_hash_backend());
  fflush(stdout);
  return 0;
}

static int hex_bytes(const char *hex, unsigned char *out, int n) {
  for (int i = 0; i < n; i++) {
    unsigned b;
    if (sscanf(hex + 2 * i, "%2x", &b) != 1) return -1;
    out[i] = (unsigned char)b;
  }
  return 0;
}

/* Lines: "<256 hex header> <64 hex digest>". Each header goes through
 * hash_first then hash_next (the miner's pipelined path) and plain
 * shear_hash; both must equal the stored digest. */
static int run_golden(const char *path) {
  FILE *f = fopen(path, "r");
  if (!f) {
    printf("golden: cannot open %s\n", path);
    return 1;
  }
  char hh[300], dh[80];
  unsigned char prev[SHEAR_HEADER_LEN];
  char prev_want[65];
  int have_prev = 0, n = 0, bad = 0, piped = 0;
  unsigned char hdr[SHEAR_HEADER_LEN], out[32];
  char got[65];
  while (fscanf(f, "%299s %79s", hh, dh) == 2) {
    if (strlen(hh) != SHEAR_HEADER_LEN * 2 || strlen(dh) != 64 || hex_bytes(hh, hdr, SHEAR_HEADER_LEN) != 0) {
      printf("golden: bad line %d\n", n);
      fclose(f);
      return 1;
    }
    shear_hash(hdr, out);
    shear_hash_hex(out, got);
    if (strcmp(got, dh) != 0) {
      printf("golden FAIL plain line=%d got=%s want=%s\n", n, got, dh);
      bad++;
    }
    /* Pipelined: prime prev, then next(hdr) returns prev's digest. */
    if (have_prev) {
      if (shear_hash_first(prev) == 0 && shear_hash_next(hdr, out) == 0) {
        shear_hash_hex(out, got);
        piped++;
        if (strcmp(got, prev_want) != 0) {
          printf("golden FAIL pipelined line=%d got=%s want=%s\n", n - 1, got, prev_want);
          bad++;
        }
      }
    }
    memcpy(prev, hdr, SHEAR_HEADER_LEN);
    snprintf(prev_want, sizeof(prev_want), "%s", dh);
    have_prev = 1;
    n++;
  }
  fclose(f);
  printf("golden n=%d pipelined=%d bad=%d backend=%s %s\n", n, piped, bad, shear_hash_backend(),
         bad || n == 0 || piped == 0 ? "FAIL" : "ok");
  fflush(stdout);
  return bad || n == 0 || piped == 0;
}

int main(int argc, char **argv) {
  const char *backend = "jit-full";
  const char *threads = "1";
  const char *golden = NULL;
  double secs = 20, warm = 3;
  int epochs = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--backend") && i + 1 < argc) backend = argv[++i];
    else if (!strcmp(argv[i], "--threads") && i + 1 < argc) threads = argv[++i];
    else if (!strcmp(argv[i], "--secs") && i + 1 < argc) secs = atof(argv[++i]);
    else if (!strcmp(argv[i], "--warm") && i + 1 < argc) warm = atof(argv[++i]);
    else if (!strcmp(argv[i], "--pin") && i + 1 < argc) g_pin = argv[++i];
    else if (!strcmp(argv[i], "--epochs") && i + 1 < argc) epochs = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--golden") && i + 1 < argc) golden = argv[++i];
    else {
      fprintf(stderr, "usage: rxbench [--backend B] [--threads 1,2] [--secs S] [--warm S] [--pin core|seq|none] [--epochs N] [--golden FILE]\n");
      return 2;
    }
  }
  cpu_map();
  double t0 = now_s();
  if (shear_hash_set_backend(backend) != 0) {
    printf("backend %s unavailable\n", backend);
    return 1;
  }
  memset(g_header, 0, SHEAR_HEADER_LEN);
  g_header[0] = 1;
  unsigned char out[32];
  char hex[65];
  shear_hash(g_header, out);
  double t1 = now_s();
  shear_hash_hex(out, hex);
  int ok = strcmp(hex, SHEAR_SELFTEST_HASH) == 0;
  printf("init backend=%s want=%s got=%s init_s=%.3f hugepages=%d selftest=%s\n", backend,
         shear_hash_backend(), hex, t1 - t0, shear_hash_huge_pages(), ok ? "ok" : "FAIL");
  if (!ok) return 1;
  int rc = 0;
  if (golden) rc |= run_golden(golden);
  if (epochs > 0) rc |= run_epochs(epochs);
  /* Back to the selftest header for the throughput points. */
  shear_hash(g_header, out);
  char list[256];
  snprintf(list, sizeof(list), "%s", threads);
  for (char *tok = strtok(list, ","); tok; tok = strtok(NULL, ",")) {
    int n = atoi(tok);
    if (n < 1 || n > MAXT) continue;
    rc |= run_point(shear_hash_backend(), n, secs, warm);
  }
  return rc;
}
