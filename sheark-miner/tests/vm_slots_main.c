/* PR146 P1-3: per-thread RandomX VM slots are reused when a thread exits,
 * and a thread with no free slot is refused instead of sharing another
 * thread's VM. Built with -DSHEAR_MAX_VM=8 by test_pr146_fixes_v12.js. */
#define _POSIX_C_SOURCE 200809L
#include "shear_hash.h"
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static const char *getenv_backend(void) {
  const char *b = getenv("SHEAR_BACKEND");
  return b && *b ? b : "jit";
}

static const char *WANT = "e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4";
static pthread_barrier_t g_bar;
static int g_bad = 0, g_ok = 0, g_refused = 0;
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;

static void *worker(void *arg) {
  int hold = *(int *)arg;
  unsigned char h[SHEAR_HEADER_LEN], out[32];
  char hex[65];
  memset(h, 0, sizeof(h));
  h[0] = 1;
  int r = shear_hash_first(h);
  if (r == 0) {
    h[100] = 0;
    r = shear_hash_next(h, out);
  }
  pthread_mutex_lock(&g_mu);
  if (r == 0) {
    shear_hash_hex(out, hex);
    if (strcmp(hex, WANT) == 0) g_ok++;
    else g_bad++;
  } else {
    g_refused++;
  }
  pthread_mutex_unlock(&g_mu);
  if (hold) pthread_barrier_wait(&g_bar);
  return NULL;
}

static int round_of(int n, int hold) {
  pthread_t th[64];
  int one = hold;
  if (hold) pthread_barrier_init(&g_bar, NULL, (unsigned)n);
  for (int i = 0; i < n; i++) pthread_create(&th[i], NULL, worker, &one);
  for (int i = 0; i < n; i++) pthread_join(th[i], NULL);
  if (hold) pthread_barrier_destroy(&g_bar);
  return 0;
}

int main(void) {
  if (shear_hash_set_backend(getenv_backend()) != 0) return 2;
  printf("max_threads=%d\n", shear_hash_max_threads());
  /* 5 rounds of 6 threads: 30 threads over 8 slots, each slot reused. */
  for (int i = 0; i < 5; i++) round_of(6, 0);
  printf("reuse ok=%d bad=%d refused=%d\n", g_ok, g_bad, g_refused);
  g_ok = g_bad = g_refused = 0;
  /* 10 threads that all hold their slot at once: 8 hash, 2 are refused. */
  round_of(10, 1);
  printf("full ok=%d bad=%d refused=%d\n", g_ok, g_bad, g_refused);
  return 0;
}
