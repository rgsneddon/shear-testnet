/* R41 live stats: every figure comes from a real counter. Hash rates are
 * counted hashes over wall time in a 10 s, 60 s or 15 min window: no
 * smoothing and no hold. Shown locally only (rig.h privacy rule). */
#ifndef SHEARK_STATS_H
#define SHEARK_STATS_H

#include <stdatomic.h>
#include <stdint.h>

#define ST_MAXT 256

/* One cache line per worker so counters never share a line. */
typedef struct {
  _Alignas(64) atomic_uint_fast64_t hashes; /* every computed digest */
  atomic_uint_fast64_t checked;   /* digests tested against the share/block target */
  atomic_uint_fast64_t discarded; /* digests of a job that changed while hashing */
  atomic_uint_fast64_t busy_ns;   /* time inside the hash calls */
  int cpu;                        /* pinned CPU, -1 none */
} ThreadStat;

extern ThreadStat g_tstat[ST_MAXT];

uint64_t st_now_ns(void);
void stats_init(int nthreads);
/* Called once a second by the network thread: one snapshot into the ring. */
void stats_tick(void);
/* Hashes per second over the last `secs` (10, 60, 900) for thread tid, or
 * all threads with tid < 0; the window shrinks to the run so far. -1 if
 * fewer than two snapshots. */
double stats_rate(int tid, int secs, double *span_out);
/* Percent of wall time a thread spent outside the hash calls. */
double stats_idle(int tid, int secs);
uint64_t stats_sum_hashes(void);
uint64_t stats_sum_checked(void);
uint64_t stats_sum_discarded(void);
int stats_threads(void);
double stats_uptime(void);

#endif
