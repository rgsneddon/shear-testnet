/* R41 live stats. See stats.h. */
#include "stats.h"

#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

ThreadStat g_tstat[ST_MAXT];

#define RING 902 /* 15 min of 1 s snapshots, plus the ends */

typedef struct {
  uint64_t t_ns;
  uint64_t *hashes; /* per thread */
  uint64_t *busy;
} Snap;

static Snap g_ring[RING];
static int g_head = 0;  /* next slot */
static int g_count = 0; /* filled slots */
static int g_n = 0;
static uint64_t g_start_ns = 0;
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;

uint64_t st_now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

void stats_init(int nthreads) {
  if (nthreads > ST_MAXT) nthreads = ST_MAXT;
  if (nthreads < 1) nthreads = 1;
  pthread_mutex_lock(&g_mu);
  g_n = nthreads;
  for (int i = 0; i < RING; i++) {
    free(g_ring[i].hashes);
    free(g_ring[i].busy);
    g_ring[i].hashes = calloc((size_t)g_n, sizeof(uint64_t));
    g_ring[i].busy = calloc((size_t)g_n, sizeof(uint64_t));
  }
  for (int i = 0; i < ST_MAXT; i++) g_tstat[i].cpu = -1;
  g_head = g_count = 0;
  g_start_ns = st_now_ns();
  pthread_mutex_unlock(&g_mu);
  stats_tick();
}

void stats_tick(void) {
  pthread_mutex_lock(&g_mu);
  if (g_n > 0 && g_ring[g_head].hashes) {
    Snap *s = &g_ring[g_head];
    s->t_ns = st_now_ns();
    for (int i = 0; i < g_n; i++) {
      s->hashes[i] = atomic_load_explicit(&g_tstat[i].hashes, memory_order_relaxed);
      s->busy[i] = atomic_load_explicit(&g_tstat[i].busy_ns, memory_order_relaxed);
    }
    g_head = (g_head + 1) % RING;
    if (g_count < RING) g_count++;
  }
  pthread_mutex_unlock(&g_mu);
}

/* The newest snapshot and the one at least `secs` older (or the oldest). */
static int window(int secs, Snap **newest, Snap **older) {
  if (g_count < 2) return -1;
  int last = (g_head - 1 + RING) % RING;
  *newest = &g_ring[last];
  uint64_t want = (uint64_t)secs * 1000000000ull;
  int idx = last;
  for (int k = 1; k < g_count; k++) {
    int j = (last - k + RING) % RING;
    idx = j;
    if ((*newest)->t_ns - g_ring[j].t_ns >= want) break;
  }
  *older = &g_ring[idx];
  return (*newest)->t_ns > (*older)->t_ns ? 0 : -1;
}

double stats_rate(int tid, int secs, double *span_out) {
  pthread_mutex_lock(&g_mu);
  Snap *a, *b;
  double out = -1;
  if (window(secs, &a, &b) == 0) {
    uint64_t dh = 0;
    if (tid < 0) {
      for (int i = 0; i < g_n; i++) dh += a->hashes[i] - b->hashes[i];
    } else if (tid < g_n) {
      dh = a->hashes[tid] - b->hashes[tid];
    }
    double dt = (double)(a->t_ns - b->t_ns) / 1e9;
    out = (double)dh / dt;
    if (span_out) *span_out = dt;
  }
  pthread_mutex_unlock(&g_mu);
  return out;
}

double stats_idle(int tid, int secs) {
  pthread_mutex_lock(&g_mu);
  Snap *a, *b;
  double out = -1;
  if (window(secs, &a, &b) == 0 && tid >= 0 && tid < g_n) {
    double dt = (double)(a->t_ns - b->t_ns);
    double busy = (double)(a->busy[tid] - b->busy[tid]);
    out = 100.0 * (1.0 - busy / dt);
    if (out < 0) out = 0;
  }
  pthread_mutex_unlock(&g_mu);
  return out;
}

static uint64_t sum_field(int which) {
  uint64_t s = 0;
  for (int i = 0; i < g_n; i++) {
    atomic_uint_fast64_t *f = which == 0 ? &g_tstat[i].hashes : which == 1 ? &g_tstat[i].checked : &g_tstat[i].discarded;
    s += atomic_load_explicit(f, memory_order_relaxed);
  }
  return s;
}

uint64_t stats_sum_hashes(void) { return sum_field(0); }
uint64_t stats_sum_checked(void) { return sum_field(1); }
uint64_t stats_sum_discarded(void) { return sum_field(2); }
int stats_threads(void) { return g_n; }
double stats_uptime(void) { return g_start_ns ? (double)(st_now_ns() - g_start_ns) / 1e9 : 0; }
