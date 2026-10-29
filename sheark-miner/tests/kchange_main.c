/* PSA k-change review (PR146): the miner's key-change path, driven hard.
 * Worker threads hash golden-corpus rows of the live key (shear_hash_checked
 * and the first/next pipeline) and check every digest; the main thread does
 * what the miner's main loop does on each new-key job: shear_prepare, poll
 * shear_epoch_ready, shear_commit_epoch, switch the live rows. The delay
 * between a commit and the next prepare runs through 0/1/5/20/100 ms and one
 * and two hash durations; KC_MID=1 also sends a second new key while a prep
 * is running (latest wins). It reports digest mismatches, the longest
 * shear_prepare call (the main loop must never wait on a prep), and RSS.
 * Built plain, with ASan+UBSan, or with TSan. Offline: no sockets.
 * usage: kchange_main GOLDEN BACKEND THREADS CHANGES */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "shear_hash.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAXR 64
#define MAXG 8
static unsigned char g_hdr[MAXR][SHEAR_HEADER_LEN];
static char g_dig[MAXR][65];
static int g_grp[MAXG][MAXR], g_grp_n[MAXG], g_ngrp = 0;
static atomic_int g_live = -1;
static atomic_int g_stop = 0;
static atomic_long g_ok = 0, g_bad = 0, g_refused = 0;

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static void sleep_ms(double ms) {
  if (ms <= 0) return;
  struct timespec ts = {(time_t)(ms / 1000), (long)((ms - (time_t)(ms / 1000) * 1000) * 1e6)};
  nanosleep(&ts, NULL);
}

static long rss_mb(void) {
  long pages = 0, rss = 0;
  FILE *f = fopen("/proc/self/statm", "r");
  if (!f) return -1;
  if (fscanf(f, "%ld %ld", &pages, &rss) != 2) rss = -1;
  fclose(f);
  return rss < 0 ? -1 : rss * (sysconf(_SC_PAGESIZE) / 1024) / 1024;
}

static int hexval(char c) { return c <= '9' ? c - '0' : (c | 32) - 'a' + 10; }

static int load(const char *path) {
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  char hx[600], dg[100];
  int n = 0;
  while (n < MAXR && fscanf(f, "%599s %99s", hx, dg) == 2) {
    if (strlen(hx) != SHEAR_HEADER_LEN * 2 || strlen(dg) != 64) continue;
    for (int i = 0; i < SHEAR_HEADER_LEN; i++) g_hdr[n][i] = (unsigned char)(hexval(hx[2 * i]) * 16 + hexval(hx[2 * i + 1]));
    strcpy(g_dig[n], dg);
    unsigned char k[32], k2[32];
    shear_key(g_hdr[n], k);
    int g = -1;
    for (int j = 0; j < g_ngrp; j++) {
      shear_key(g_hdr[g_grp[j][0]], k2);
      if (!memcmp(k, k2, 32)) g = j;
    }
    if (g < 0 && g_ngrp < MAXG) { g = g_ngrp++; g_grp_n[g] = 0; }
    if (g >= 0) g_grp[g][g_grp_n[g]++] = n;
    n++;
  }
  fclose(f);
  return n;
}

static void check(int row, const unsigned char out[32]) {
  char hex[65];
  shear_hash_hex(out, hex);
  if (strcmp(hex, g_dig[row]) == 0) atomic_fetch_add(&g_ok, 1);
  else {
    if (atomic_fetch_add(&g_bad, 1) < 5) fprintf(stderr, "bad digest row %d: %s want %s\n", row, hex, g_dig[row]);
  }
}

static void *worker(void *arg) {
  unsigned i = (unsigned)(uintptr_t)arg * 7u;
  while (!atomic_load(&g_stop)) {
    int g = atomic_load(&g_live);
    if (g < 0) { sleep_ms(1); continue; }
    int a = g_grp[g][i % g_grp_n[g]];
    int b = g_grp[g][(i + 1) % g_grp_n[g]];
    i++;
    unsigned char out[32];
    if (i & 1) {
      if (shear_hash_checked(g_hdr[a], out) == 0) check(a, out);
      else atomic_fetch_add(&g_refused, 1);
    } else {
      /* The miner's pipeline: next() returns the previous header's digest. */
      if (shear_hash_first(g_hdr[a]) == 0 && shear_hash_next(g_hdr[b], out) == 0) check(a, out);
      else atomic_fetch_add(&g_refused, 1);
    }
  }
  return NULL;
}

int main(int argc, char **argv) {
  if (argc < 5) { fprintf(stderr, "usage: %s GOLDEN BACKEND THREADS CHANGES\n", argv[0]); return 2; }
  setvbuf(stdout, NULL, _IONBF, 0);
  if (load(argv[1]) < 16 || g_ngrp < 3) { fprintf(stderr, "golden corpus: need >= 3 keys\n"); return 2; }
  if (shear_hash_set_backend(argv[2]) != 0) { fprintf(stderr, "no backend\n"); return 2; }
  int threads = atoi(argv[3]);
  int changes = atoi(argv[4]);
  int mid = getenv("KC_MID") && atoi(getenv("KC_MID"));
  if (threads < 1 || threads > 64) threads = 4;

  /* One hash duration on this backend, for the 1x and 2x delays. */
  unsigned char tmp[32];
  shear_hash_checked(g_hdr[0], tmp);
  double t0 = now_ms();
  for (int i = 0; i < 3; i++) shear_hash_checked(g_hdr[i % 2], tmp);
  double hash_ms = (now_ms() - t0) / 3;
  double delays[] = {0, 1, 5, 20, 100, hash_ms, 2 * hash_ms};
  int nd = (int)(sizeof(delays) / sizeof(delays[0]));
  const char *only = getenv("KC_DELAY_MS");

  pthread_t th[64];
  for (int t = 0; t < threads; t++) pthread_create(&th[t], NULL, worker, (void *)(uintptr_t)t);

  int cur = 0;
  /* First epoch. */
  shear_prepare(g_hdr[g_grp[cur][0]]);
  while (!shear_epoch_ready(g_hdr[g_grp[cur][0]])) sleep_ms(1);
  shear_commit_epoch();
  atomic_store(&g_live, cur);

  double max_prep = 0, max_ready = 0;
  long rss0 = -1, rss_max = 0;
  int never = 0;
  for (int i = 0; i < changes; i++) {
    int next = (cur + 1) % g_ngrp;
    const unsigned char *h = g_hdr[g_grp[next][0]];
    double a = now_ms();
    shear_prepare(h);
    double d = now_ms() - a;
    if (d > max_prep) max_prep = d;
    if (mid && i % 3 == 1) {
      /* A second new key while that prep runs: latest wins. */
      sleep_ms(2 + (i % 5) * 7);
      next = (next + 1) % g_ngrp;
      if (next == cur) next = (next + 1) % g_ngrp;
      h = g_hdr[g_grp[next][0]];
      a = now_ms();
      shear_prepare(h);
      d = now_ms() - a;
      if (d > max_prep) max_prep = d;
    }
    double r0 = now_ms();
    while (!shear_epoch_ready(h)) {
      if (now_ms() - r0 > 120000) { never = 1; break; }
      shear_prepare(h); /* the miner's main loop re-asks each pass */
      sleep_ms(1);
    }
    if (never) break;
    if (now_ms() - r0 > max_ready) max_ready = now_ms() - r0;
    shear_commit_epoch();
    atomic_store(&g_live, next);
    cur = next;
    double wait = only ? atof(only) : delays[i % nd];
    sleep_ms(wait);
    long r = rss_mb();
    if (i == 9) rss0 = r;
    if (r > rss_max) rss_max = r;
    if ((i + 1) % 100 == 0) printf("progress %d ok=%ld bad=%ld refused=%ld rss=%ldMB max_prepare_ms=%.1f\n", i + 1,
                                   atomic_load(&g_ok), atomic_load(&g_bad), atomic_load(&g_refused), r, max_prep);
  }
  atomic_store(&g_stop, 1);
  for (int t = 0; t < threads; t++) pthread_join(th[t], NULL);
  printf("kchange backend=%s threads=%d changes=%d hash_ms=%.2f ok=%ld bad=%ld refused=%ld max_prepare_ms=%.1f max_ready_ms=%.1f rss_base_mb=%ld rss_max_mb=%ld never_ready=%d\n",
         shear_hash_backend(), threads, changes, hash_ms, atomic_load(&g_ok), atomic_load(&g_bad), atomic_load(&g_refused),
         max_prep, max_ready, rss0, rss_max, never);
  return atomic_load(&g_bad) || never ? 1 : 0;
}
