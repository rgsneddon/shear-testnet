/*
 * ShearK-Miner — official SHE CPU miner for ShearHash-v3 (RandomX-lite).
 * Hashes the 128-byte Shear header. 1 hash = 1 tx.
 * Do not recut Shear-Miner 1.1 / 1.0.
 */
#if defined(__linux__)
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE
#endif
#endif
#include "shear_hash.h"
#include "job_bits.h"
#include "stratum_tls.h"
#include "blunote.h"
#include "rig.h"
#include "stats.h"
#include "../../crypto/share_stamp.h"

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#if !defined(_WIN32)
#include <sys/resource.h>
#endif
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#if defined(__linux__)
#include <sched.h>
#endif

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <io.h>
#define close_fd closesocket
#else
#include <arpa/inet.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <netdb.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/types.h>
#define close_fd close
#endif

#define DEFAULT_HOST "pool.shear.digital"
#define DEFAULT_PORT 443
#define LINE_CAP 8192
#define HEX_CAP (SHEAR_HEADER_LEN * 2 + 16)
#define QCAP 8192
/* PR146: up to 4 submits in flight, each matched to its ack by a unique
 * submit id (the pool echoes msg.id). One at a time with a busy back-off
 * left queued shares waiting past the job change that then dropped them. */
#define IN_FLIGHT_MAX 4
/* PR146: the pool's PREV_JOB_GRACE_MS (pool/src/pool.js) for a previous
 * job and for the previous share target (noteConnShareBits). */
#define SHARE_GRACE_MS 12000
#define DEFAULT_WORKER "worker"

static const char *g_user = NULL;
static char g_login[320];
static char g_dest[256];
/* R28 solo (b): the mining address B||Y, sent at login only with --solo. */
static char g_blu_addr[129];
static int g_solo = 0;
static char g_host_buf[256];
static const char *g_host = DEFAULT_HOST;
static int g_port = DEFAULT_PORT;
static int g_tls = 1;
static int g_require_tls = 0;
/* Default is stratum+ssl://pool.shear.digital:443. A tcp URL, a bare
   host:port, or --notls is cleartext and stays lab-only. */
static int g_cleartext_url = 0;
static const char *g_tls_ca = NULL;
static int g_threads = 0;
static int g_cpu_cores = 1;
static int g_cpu_threads = 1;
static volatile int g_stop = 0;
static atomic_uint_fast64_t g_hashes;
static uint64_t g_origin;

typedef struct {
  int gen;
  int share_bits;
  int block_bits;
  int height;
  char jobId[80];
  unsigned char header[SHEAR_HEADER_LEN];
  int have;
} JobSnap;

static pthread_mutex_t g_job_mu = PTHREAD_MUTEX_INITIALIZER;
static JobSnap g_main_job;
static JobSnap g_pending_job;
static int g_have_main = 0;
static int g_have_pending = 0;
static int g_job_gen = 0;
static atomic_int g_job_seq;
static atomic_int g_share_bits_live;
static atomic_int g_block_bits_live;
static atomic_int g_share_bind_dest;
static unsigned char g_note_commit[32];
static unsigned char g_dest20[20];
static char g_dest20_hex[41];
static int g_have_note = 0;
/* Bumped only when the live header restamps. Workers copy under the mutex
 * on that change, not on every nonce. */
static atomic_uint g_stamp_seq;

typedef struct {
  char jobId[80];
  uint64_t nonce;
  int share_bits;
  int gen;
  char hash[65];
  /* R28: the one-time key this nonce binds (BluNotes). */
  int have_key;
  BluKey key;
  uint64_t enq_ns; /* PR146: when the hit was queued, for the 12 s grace */
} Share;

static pthread_mutex_t g_q_mu = PTHREAD_MUTEX_INITIALIZER;
static Share g_q[QCAP];
static int g_qhead = 0;
static int g_qtail = 0;
static uint64_t g_meets = 0;
static int g_accepted = 0;
static int g_rejected = 0;
static int g_stale = 0;
static int g_blocks = 0;
static int g_color = 1;

#define C_RST "\033[0m"
#define C_DIM "\033[2m"
#define C_GRN "\033[1;92m"
#define C_YEL "\033[1;93m"
#define C_RED "\033[1;91m"
#define C_CYN "\033[1;96m"
#define C_MAG "\033[1;95m"
#define C_WHT "\033[1;97m"


static atomic_int g_inflight = 0;
typedef struct {
  int used;
  int id;
  uint64_t sent_ns;
  Share s;
} SentShare;
static SentShare g_sent_tab[IN_FLIGHT_MAX];
static int g_submit_id = 1; /* 1 is the login; submits use 2.. */
/* PR146: the parent block (header bytes 4..36) of recent job gens. */
#define GEN_RING 64
static int g_gen_ring_gen[GEN_RING];
static unsigned char g_gen_ring_parent[GEN_RING][32];
static int enqueue_front(const Share *s);
static _Atomic uint64_t g_dropped = 0;
static uint64_t g_submitted = 0;
static uint64_t g_round0 = 0;
/* R41: the hash rate everywhere is counted hashes over the last 10 s of
 * wall time (stats.c), in milli-H/s. The old EMA held its value when the
 * rate fell (a painted number); it is gone. */
static atomic_uint_fast64_t g_hs10_milli;
static double hs10(void) { return (double)atomic_load(&g_hs10_milli) / 1000.0; }
/* Local stats and rig (never sent: rig.h). */
static RigInfo g_rig;
static int g_redact = 0;
static int g_verbose = 0;
static int g_stats_interval = 60;
static int g_leave_free = -1;
static int g_tune_mode = 0; /* 0 cached or tune, 1 --retune, -1 --no-tune */
static const char *g_stats_file = NULL;
static double g_max_temp = 0;
static int g_threads_user = 0;
static char g_threads_why[256] = "";
static char g_mode_why[256] = "";
static char g_tune_table[512] = "";
static double g_init_s = -1;
static atomic_int g_print_req;
static atomic_int g_thermal_state; /* 0 ok, 1 reduced, 2 minimum */
static pthread_mutex_t g_st_mu = PTHREAD_MUTEX_INITIALIZER;
static uint64_t g_job_at_ns = 0;
static double g_lat_last = -1, g_lat_sum = 0;
static uint64_t g_lat_n = 0;
static uint64_t g_busy_until_ns = 0, g_busy_backoff_ns = 0;
static uint64_t g_busy_n = 0;
typedef struct { char name[40]; uint64_t n; } Reason;
static Reason g_rej_r[16], g_stl_r[8];
static void note_reason(Reason *t, int cap, const char *why) {
  pthread_mutex_lock(&g_st_mu);
  int i;
  for (i = 0; i < cap && t[i].name[0]; i++) if (!strcmp(t[i].name, why)) break;
  if (i < cap) {
    if (!t[i].name[0]) snprintf(t[i].name, sizeof(t[i].name), "%s", why);
    t[i].n++;
  }
  pthread_mutex_unlock(&g_st_mu);
}
static int g_height = 0;
static char g_last_job[80];
static uint64_t g_last_nonce = 0;
static char g_last_hash[65];
static char g_last_ack_hash[65];
static time_t g_t0;
static int g_cpu_map[256];
static int g_cpu_map_n = 0;
/* R41: the default --threads. Every logical CPU this process may run on
 * (SMT siblings add RandomX throughput), but no more threads than the L3
 * holds 2 MiB scratchpads. */
static int g_auto_threads = 0;
/* --max-temp: workers with tid >= this rest. */
static atomic_int g_active_threads = 1 << 30;

static void fmt_hashrate(double hs, char *buf, size_t n);

typedef struct {
  int fd;
  char buf[LINE_CAP];
  int buflen;
} Conn;

static void on_sig(int s) {
  (void)s;
  g_stop = 1;
}

static void usage(FILE *out) {
  fprintf(out,
          "ShearK-Miner %s (ShearHash-v3 light)\n"
          "Hashes the 128-byte Shear header. One proven share-hash mints units.\n\n"
          "  --user WORKER               required: a worker name (e.g. rig1), never an address\n"
          "  --blu shm1…                 required: your wallet's mining address (This wallet mines).\n"
          "                              It stays on this rig; each share carries a fresh one-time key.\n"
          "  --solo                      your own node's solo stratum: login sends the --blu\n"
          "                              address so the node pays its pot to a one-time key.\n"
          "                              Never use it with a public pool.\n"
          "  --pool host:port            default stratum+ssl://%s:%d\n"
          "  --threads N                 default: each logical CPU, one per 2 MiB of L3\n"
          "  --backend jit-full            default: 260 MiB dataset JIT (same digest as light)\n"
          "  --backend jit                light 128 MiB cache JIT\n"
          "  --backend interpreter\n"
          "  --pool stratum+ssl://host:port   TLS stratum (verifies CA or --tls-ca)\n"
          "  --pool stratum+tcp://host:port   cleartext (localhost / lab)\n"
          "  --tls / --notls             force TLS or cleartext\n"
          "  --require-tls               refuse a cleartext URL\n"
          "  --tls-ca FILE               PEM trust anchor\n"
          "  --notls                     plaintext (localhost or lab only)\n"
          "  --leave-free N              keep N CPUs free (default 1 on a desktop/laptop with 4+, else 0)\n"
          "  --retune / --no-tune        re-measure the best thread count / use the CPU count\n"
          "  --max-temp C                run fewer threads while the CPU is at or above C\n"
          "  --rig                       print this device's details and exit (local only)\n"
          "  --stats-interval S          print the stats table every S seconds (0 off; default 60)\n"
          "  --stats-file PATH           also write the stats as JSON to PATH (opt-in, local)\n"
          "  --redact                    mask host name, home paths and IPs in the output\n"
          "  --verbose                   every thread in the tables\n"
          "  type s + Enter (or SIGUSR1) print the stats table now\n"
          "  --bench [SECONDS]\n"
          "  --selftest\n"
          "  --verify HEADERHEX\n"
          "  --print-config\n"
          "  --help\n",
          SHEAR_VERSION, DEFAULT_HOST, DEFAULT_PORT);
}

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static int parse_header_hex(const char *hex, unsigned char out[SHEAR_HEADER_LEN]) {
  if (!hex || strlen(hex) < SHEAR_HEADER_LEN * 2) return -1;
  for (int i = 0; i < SHEAR_HEADER_LEN; i++) {
    int a = hex_nibble(hex[i * 2]);
    int b = hex_nibble(hex[i * 2 + 1]);
    if (a < 0 || b < 0) return -1;
    out[i] = (unsigned char)((a << 4) | b);
  }
  return 0;
}

static int valid_worker(const char *w) {
  size_t n = strlen(w);
  if (n < 1 || n > 32) return 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)w[i];
    if (!(isalnum(c) || c == '_' || c == '-')) return 0;
  }
  return 1;
}

/* Portable case-insensitive prefix test (no strncasecmp on every toolchain). */
static int prefix_ci(const char *s, size_t n, const char *pre) {
  size_t k = strlen(pre);
  if (n < k) return 0;
  for (size_t i = 0; i < k; i++) if (tolower((unsigned char)s[i]) != pre[i]) return 0;
  return 1;
}

static int all_hex(const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) if (hex_nibble(s[i]) < 0) return 0;
  return 1;
}

/* R28 option 2 (Russell 28 Oct): true when any dot-separated part of `s`
 * names a wallet (ssa1, she1, shear1, shm1, or a raw 32/64-byte hex key).
 * Such a login would hand the pool something linkable, so it is refused. */
static int names_address(const char *s) {
  const char *p = s;
  while (p && *p) {
    const char *dot = strchr(p, '.');
    size_t n = dot ? (size_t)(dot - p) : strlen(p);
    if (prefix_ci(p, n, "ssa1") || prefix_ci(p, n, "she1") || prefix_ci(p, n, "shm1") || prefix_ci(p, n, "shear1")) return 1;
    if ((n == 64 || n == 128) && all_hex(p, n)) return 1;
    p = dot ? dot + 1 : NULL;
  }
  return 0;
}

/* The pool login is a worker name only. 1 ok, 0 not a worker name, -1 an address. */
static int build_login(const char *user) {
  if (!user || !*user) return 0;
  if (names_address(user)) return -1;
  if (!valid_worker(user)) return 0;
  snprintf(g_login, sizeof(g_login), "%s", user);
  g_user = g_login;
  return 1;
}

static const char BECH32_CS[] = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

static uint32_t bech32_polymod(const unsigned char *v, size_t n) {
  static const uint32_t gens[5] = { 0x3b6a57b2u, 0x26508e6du, 0x1ea119fau, 0x3d4233ddu, 0x2a1462b3u };
  uint32_t chk = 1;
  for (size_t i = 0; i < n; i++) {
    uint32_t b = chk >> 25;
    chk = ((chk & 0x1ffffffu) << 5) ^ v[i];
    for (int j = 0; j < 5; j++) if ((b >> j) & 1) chk ^= gens[j];
  }
  return chk;
}

/* ssa1 dest20. Copy dest is dest20||B (body ~91). Take first 20 payload bytes. */
static int dest20_from_ssa1(const char *addr, unsigned char out[20]) {
  if (!addr || strncmp(addr, "ssa1", 4) != 0) return -1;
  const char *body = addr + 4;
  size_t blen = strlen(body);
  if (blen < 7 || blen > 160) return -1;
  unsigned char vals[168];
  for (size_t i = 0; i < blen; i++) {
    const char *p = strchr(BECH32_CS, body[i]);
    if (!p) return -1;
    vals[i] = (unsigned char)(p - BECH32_CS);
  }
  unsigned char chkbuf[8 + 168];
  size_t n = 0;
  const char *hrp = "ssa";
  for (size_t i = 0; hrp[i]; i++) chkbuf[n++] = (unsigned char)(hrp[i] >> 5);
  chkbuf[n++] = 0;
  for (size_t i = 0; hrp[i]; i++) chkbuf[n++] = (unsigned char)(hrp[i] & 31);
  memcpy(chkbuf + n, vals, blen);
  n += blen;
  if (bech32_polymod(chkbuf, n) != 1) return -1;
  size_t data_n = blen - 6;
  if (data_n < 2) return -1;
  unsigned acc = 0, bits = 0, got = 0;
  for (size_t i = 1; i < data_n; i++) {
    acc = (acc << 5) | vals[i];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (got < 20) out[got++] = (unsigned char)((acc >> bits) & 0xff);
    }
  }
  if (got != 20) return -1;
  return 0;
}

/* R28 mining address: shm1… is bech32 (the ssa checksum) of B‖Y. Writes the
 * 128-hex form for blu_set_address. 0 ok; -1 bad prefix, character, checksum
 * or length. Lowercase only, as the wallet prints it. */
static int shm1_to_hex(const char *addr, char hex[129]) {
  if (!addr || strncmp(addr, "shm1", 4) != 0) return -1;
  const char *body = addr + 4;
  size_t blen = strlen(body);
  if (blen != 1 + 103 + 6) return -1;
  unsigned char vals[110];
  for (size_t i = 0; i < blen; i++) {
    const char *p = body[i] ? strchr(BECH32_CS, body[i]) : NULL;
    if (!p) return -1;
    vals[i] = (unsigned char)(p - BECH32_CS);
  }
  unsigned char chkbuf[8 + 110];
  size_t n = 0;
  const char *hrp = "shm";
  for (size_t i = 0; hrp[i]; i++) chkbuf[n++] = (unsigned char)(hrp[i] >> 5);
  chkbuf[n++] = 0;
  for (size_t i = 0; hrp[i]; i++) chkbuf[n++] = (unsigned char)(hrp[i] & 31);
  memcpy(chkbuf + n, vals, blen);
  n += blen;
  if (bech32_polymod(chkbuf, n) != 1) return -1;
  if (vals[0] != 0) return -1;
  unsigned char out[64];
  unsigned acc = 0, bits = 0, got = 0;
  for (size_t i = 1; i < blen - 6; i++) {
    acc = (acc << 5) | vals[i];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (got >= 64) return -1;
      out[got++] = (unsigned char)((acc >> bits) & 0xff);
    }
  }
  if (got != 64 || (acc & ((1u << bits) - 1)) != 0) return -1;
  static const char *hx = "0123456789abcdef";
  for (int i = 0; i < 64; i++) {
    hex[i * 2] = hx[out[i] >> 4];
    hex[i * 2 + 1] = hx[out[i] & 0xf];
  }
  hex[128] = 0;
  return 0;
}

static void init_note_commit(void) {
  char addr[320];
  const char *src = g_dest[0] ? g_dest : g_login;
  snprintf(addr, sizeof(addr), "%s", src ? src : "");
  char *dot = strchr(addr, '.');
  if (dot) *dot = 0;
  unsigned char d20[20];
  if (dest20_from_ssa1(addr, d20) != 0) {
    g_have_note = 0;
    g_dest20_hex[0] = 0;
    return;
  }
  memcpy(g_dest20, d20, 20);
  static const char *hx = "0123456789abcdef";
  for (int i = 0; i < 20; i++) {
    g_dest20_hex[i * 2] = hx[d20[i] >> 4];
    g_dest20_hex[i * 2 + 1] = hx[d20[i] & 0xf];
  }
  g_dest20_hex[40] = 0;
  shear_note_commit(d20, g_note_commit);
  g_have_note = 1;
}

/* Credited width is the LE high byte. The clamp lives in share_stamp.h. */
static uint64_t stamp_share_nonce(uint64_t n) {
  int sb = atomic_load_explicit(&g_share_bits_live, memory_order_relaxed);
  return shear_stamp_share_nonce(n, sb);
}

static int credit_bits_of_nonce(uint64_t nonce) {
  return shear_credit_bits_of_nonce(nonce);
}

static int share_or_block_hit(const unsigned char hash[32], uint64_t nonce) {
  int sb = credit_bits_of_nonce(nonce);
  int bb = atomic_load_explicit(&g_block_bits_live, memory_order_relaxed);
  if (bb > 0 && shear_meets_target(hash, bb)) return 1;
  /* Share credit is the byte in this nonce, not a later vardiff dial.
   * dest-bound submit only when the job says shareBind=dest. */
  if (sb < 0) return 0;
  if (blu_enabled()) return shear_meets_target(hash, sb);
  if (atomic_load_explicit(&g_share_bind_dest, memory_order_relaxed) && g_have_note) {
    unsigned char bound[32];
    shear_share_bind(hash, g_note_commit, bound);
    return shear_meets_target(bound, sb);
  }
  return shear_meets_target(hash, sb);
}

static void device_inventory(void) {
#if defined(__APPLE__)
  FILE *fp = popen("sysctl -n hw.physicalcpu hw.logicalcpu", "r");
  if (fp) {
    int p = 0, l = 0;
    if (fscanf(fp, "%d %d", &p, &l) == 2) {
      if (p > 0) g_cpu_cores = p;
      if (l > 0) g_cpu_threads = l;
    }
    pclose(fp);
  }
#elif defined(_WIN32)
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  g_cpu_threads = (int)si.dwNumberOfProcessors;
  g_cpu_cores = g_cpu_threads;
#else
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  if (n > 0) g_cpu_threads = (int)n;
  g_cpu_cores = g_cpu_threads;
#if defined(__linux__)
  {
    int cpus[256], cores[256], seen[256], nn = 0, m = 0;
    memset(seen, 0, sizeof(seen));
    cpu_set_t allowed;
    CPU_ZERO(&allowed);
    int have_allowed = sched_getaffinity(0, sizeof(allowed), &allowed) == 0;
    long l3_bytes = 0;
    char l3_seen[64][64];
    int l3_n = 0;
    int all_seen[256], all_uniq = 0;
    memset(all_seen, 0, sizeof(all_seen));
    for (int cpu = 0; cpu < 256; cpu++) {
      char path[96];
      snprintf(path, sizeof(path), "/sys/devices/system/cpu/cpu%d/topology/core_id", cpu);
      FILE *f = fopen(path, "r");
      if (!f) break;
      int core = 0;
      if (fscanf(f, "%d", &core) != 1) {
        fclose(f);
        break;
      }
      fclose(f);
      /* cpuCores counts the whole device, as before. */
      if (!all_seen[core & 255]) {
        all_seen[core & 255] = 1;
        all_uniq++;
      }
      /* Pin only to CPUs this process may use (taskset, a cgroup cpuset). */
      if (have_allowed && !CPU_ISSET((unsigned)cpu, &allowed)) continue;
      cpus[nn] = cpu;
      cores[nn] = core;
      nn++;
      char lp[112], list[64] = "";
      snprintf(lp, sizeof(lp), "/sys/devices/system/cpu/cpu%d/cache/index3/shared_cpu_list", cpu);
      FILE *lf = fopen(lp, "r");
      if (!lf) continue;
      if (!fgets(list, sizeof(list), lf)) list[0] = 0;
      fclose(lf);
      int dup = 0;
      for (int k = 0; k < l3_n; k++) if (strcmp(l3_seen[k], list) == 0) dup = 1;
      if (dup || l3_n >= 64) continue;
      snprintf(l3_seen[l3_n++], sizeof(l3_seen[0]), "%s", list);
      snprintf(lp, sizeof(lp), "/sys/devices/system/cpu/cpu%d/cache/index3/size", cpu);
      lf = fopen(lp, "r");
      long kb = 0;
      char unit = 'K';
      if (lf) {
        if (fscanf(lf, "%ld%c", &kb, &unit) >= 1) {
          if (unit == 'M') kb *= 1024;
          l3_bytes += kb * 1024;
        }
        fclose(lf);
      }
    }
    g_auto_threads = nn;
    long cap = l3_bytes / (2L << 20);
    if (cap > 0 && g_auto_threads > cap) g_auto_threads = (int)cap;
    for (int i = 0; i < nn; i++) {
      int c = cores[i] & 255;
      if (seen[c]) continue;
      seen[c] = 1;
      g_cpu_map[m++] = cpus[i];
    }
    for (int i = 0; i < nn; i++) {
      int already = 0;
      for (int j = 0; j < m; j++) if (g_cpu_map[j] == cpus[i]) already = 1;
      if (!already) g_cpu_map[m++] = cpus[i];
    }
    g_cpu_map_n = m;
    if (all_uniq > 0) g_cpu_cores = all_uniq;
  }
#endif
#endif
  if (g_cpu_threads < 1) g_cpu_threads = 1;
  if (g_cpu_cores < 1) g_cpu_cores = 1;
  if (g_auto_threads < 1) g_auto_threads = g_cpu_threads;
}

static int tcp_connect(const char *host, int port) {
  char portstr[16];
  snprintf(portstr, sizeof(portstr), "%d", port);
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(host, portstr, &hints, &res) != 0) return -1;
  int fd = -1;
  for (struct addrinfo *p = res; p; p = p->ai_next) {
    fd = (int)socket(p->ai_family, p->ai_socktype, p->ai_protocol);
    if (fd < 0) continue;
    if (connect(fd, p->ai_addr, p->ai_addrlen) == 0) break;
    close_fd(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  return fd;
}

static void conn_close(Conn *c) {
  if (!c) return;
  if (stratum_tls_active()) stratum_tls_close();
  if (c->fd >= 0) {
    close_fd(c->fd);
    c->fd = -1;
  }
  c->buflen = 0;
}

static int set_nonblock(int fd) {
#if defined(_WIN32)
  u_long n = 1;
  return ioctlsocket(fd, FIONBIO, &n) == 0 ? 0 : -1;
#else
  int fl = fcntl(fd, F_GETFL, 0);
  if (fl < 0) return -1;
  return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
#endif
}

static int conn_open(Conn *c, const char *host, int port) {
  memset(c, 0, sizeof(*c));
  c->fd = -1;
  c->fd = tcp_connect(host, port);
  if (c->fd < 0) return -1;
  if (g_tls) {
    char err[160];
    err[0] = 0;
    if (stratum_tls_handshake(c->fd, host, g_tls_ca, NULL, err, sizeof(err)) != 0) {
      fprintf(stderr, "tls failed %s\n", err[0] ? err : "handshake");
      conn_close(c);
      return -1;
    }
  }
  if (set_nonblock(c->fd) != 0) {
    conn_close(c);
    return -1;
  }
  return 0;
}

static int conn_write(Conn *c, const char *buf, int n) {
  if (!c || c->fd < 0) return -1;
  if (stratum_tls_active()) return stratum_tls_write(buf, n);
  int w = (int)send(c->fd, buf, (size_t)n, 0);
  if (w == n) return 0;
#if defined(_WIN32)
  if (w < 0 && WSAGetLastError() == WSAEWOULDBLOCK) return 1;
#else
  if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 1;
#endif
  return -1;
}

static int conn_read(Conn *c) {
  if (!c || c->fd < 0) return -1;
  if (c->buflen >= LINE_CAP - 1) c->buflen = 0;
  int space = LINE_CAP - 1 - c->buflen;
  if (stratum_tls_active()) {
    int n = stratum_tls_read(c->buf + c->buflen, space);
    if (n > 0) {
      c->buflen += n;
      c->buf[c->buflen] = 0;
      return n;
    }
    return n;
  }
  int n = (int)recv(c->fd, c->buf + c->buflen, (size_t)space, 0);
  if (n > 0) {
    c->buflen += n;
    c->buf[c->buflen] = 0;
    return n;
  }
  if (n == 0) return -1;
#if defined(_WIN32)
  if (WSAGetLastError() == WSAEWOULDBLOCK) return 0;
#else
  if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
#endif
  return -1;
}

static const char *json_colon(const char *json, const char *key) {
  char pat[80];
  snprintf(pat, sizeof(pat), "\"%s\"", key);
  const char *p = json;
  size_t plen = strlen(pat);
  while ((p = strstr(p, pat))) {
    const char *q = p + plen;
    while (*q && isspace((unsigned char)*q)) q++;
    if (*q == ':') return q + 1;
    p++;
  }
  return NULL;
}

static int json_token(const char *json, const char *key, char *out, size_t cap) {
  const char *v = json_colon(json, key);
  if (!v || cap < 2) return 0;
  while (*v && isspace((unsigned char)*v)) v++;
  if (*v == '"') {
    v++;
    size_t n = 0;
    while (*v && *v != '"' && n + 1 < cap) {
      if (*v == '\\' && v[1]) v++;
      out[n++] = *v++;
    }
    out[n] = 0;
    return 1;
  }
  size_t n = 0;
  while (*v && *v != ',' && *v != '}' && *v != ']' && !isspace((unsigned char)*v) && n + 1 < cap) {
    out[n++] = *v++;
  }
  out[n] = 0;
  return n > 0;
}

static int json_int(const char *json, const char *key, int *out) {
  char tok[32];
  if (!json_token(json, key, tok, sizeof(tok))) return 0;
  *out = atoi(tok);
  return 1;
}

/* R41 (Russell 28 Oct): no rig or device data leaves this machine. The
 * login, stats and submit carry the worker name, the client name/version
 * the pool gates on, and the hash counters; never thread or core counts,
 * CPU, RAM, OS or host name (tests/test_rig_privacy_v12.js). */
static void identity_json(char *out, size_t cap, const char *login, int threads) {
  (void)threads;
  unsigned long long hashes = (unsigned long long)atomic_load_explicit(&g_hashes, memory_order_relaxed);
  snprintf(out, cap,
           "\"login\":\"%s\",\"name\":\"%s\",\"client\":\"%s\",\"version\":\"%s\",\"algorithm\":\"%s\","
           "\"hashes\":%llu,\"hashrate\":%.0f",
           login, SHEAR_MINER_NAME, SHEAR_CLIENT, SHEAR_VERSION, SHEAR_ALGO, hashes, hs10());
}

static int send_login(Conn *c, const char *login, int threads) {
  char ident[1400], line[3200], blu[160] = "";
  identity_json(ident, sizeof(ident), login, threads);
  /* Only a solo node gets the address; a pool learns nothing it could link. */
  if (g_solo && g_blu_addr[0]) snprintf(blu, sizeof(blu), ",\"bluAddr\":\"%s\"", g_blu_addr);
  int n = snprintf(line, sizeof(line),
                   "{\"id\":1,\"method\":\"login\",\"params\":{%s%s},%s%s}\n", ident, blu, ident, blu);
  return conn_write(c, line, n) == 0 ? 0 : -1;
}

static int send_stats(Conn *c, const char *login, int threads) {
  char ident[1400], line[3200];
  identity_json(ident, sizeof(ident), login, threads);
  int n = snprintf(line, sizeof(line),
                   "{\"id\":3,\"method\":\"stats\",\"params\":{%s},%s}\n", ident, ident);
  return conn_write(c, line, n);
}

static int send_submit(Conn *c, const char *login, int threads, int id, const char *jobId, uint64_t nonce, const char *hash, const BluKey *key) {
  char ident[1400], line[3900], keys[200] = "";
  identity_json(ident, sizeof(ident), login, threads);
  if (key) {
    char R[65], P[65];
    blu_hex32(key->R, R);
    blu_hex32(key->P, P);
    snprintf(keys, sizeof(keys), ",\"shareR\":\"%s\",\"shareP\":\"%s\",\"viewTag\":%u", R, P, (unsigned)key->tag);
  }
  int n = snprintf(line, sizeof(line),
                   "{\"id\":%d,\"method\":\"submit\",\"params\":{%s,\"jobId\":\"%s\",\"nonce\":\"%llu\",\"hash\":\"%s\"%s},"
                   "%s,\"jobId\":\"%s\",\"nonce\":\"%llu\",\"hash\":\"%s\"%s}\n",
                   id, ident, jobId, (unsigned long long)nonce, hash, keys,
                   ident, jobId, (unsigned long long)nonce, hash, keys);
  return conn_write(c, line, n);
}

static void promote_pending_job(void);

static void note_gen_parent_locked(int gen, const unsigned char header[SHEAR_HEADER_LEN]) {
  g_gen_ring_gen[gen % GEN_RING] = gen;
  memcpy(g_gen_ring_parent[gen % GEN_RING], header + 4, 32);
}

static void apply_job(const char *line) {
  char method[32] = "";
  json_token(line, "method", method, sizeof(method));
  char header_hex[HEX_CAP];
  int has_header = json_token(line, "header", header_hex, sizeof(header_hex));
  int is_job = strcmp(method, "job") == 0 || has_header;
  if (!is_job) return;
  JobSnap job;
  memset(&job, 0, sizeof(job));
  if (!json_token(line, "jobId", job.jobId, sizeof(job.jobId))) {
    json_token(line, "id", job.jobId, sizeof(job.jobId));
  }
  if (!has_header || parse_header_hex(header_hex, job.header) != 0) return;
  int sb = 0, bb = 0, bits = 0;
  int has_sb = json_int(line, "shareBits", &sb);
  int has_bb = json_int(line, "blockBits", &bb);
  int has_bits = json_int(line, "bits", &bits);
  json_int(line, "height", &job.height);
  if (!shear_job_widths(has_sb, sb, has_bb, bb, has_bits, bits, &job.share_bits, &job.block_bits)) return;
  {
    char bind[16] = "";
    json_token(line, "shareBind", bind, sizeof(bind));
    atomic_store_explicit(&g_share_bind_dest, strcmp(bind, "dest") == 0, memory_order_release);
  }
  if (!job.jobId[0]) snprintf(job.jobId, sizeof(job.jobId), "job");
  if (job.height > g_height) {
    g_height = job.height;
    g_round0 = (uint64_t)atomic_load_explicit(&g_hashes, memory_order_relaxed);
  }
  pthread_mutex_lock(&g_job_mu);
  if (g_have_main && g_main_job.have
      && memcmp(g_main_job.header, job.header, SHEAR_HEADER_LEN) == 0) {
    g_main_job.share_bits = job.share_bits;
    g_main_job.block_bits = job.block_bits;
    if (job.height > 0) g_main_job.height = job.height;
    if (job.jobId[0]) snprintf(g_main_job.jobId, sizeof(g_main_job.jobId), "%s", job.jobId);
    atomic_store_explicit(&g_share_bits_live, job.share_bits, memory_order_release);
    atomic_store_explicit(&g_block_bits_live, job.block_bits, memory_order_release);
    pthread_mutex_unlock(&g_job_mu);
    return;
  }
  /* Timestamp/nonce restamp: same RandomX K, but abort in-flight hashes so
     we never submit a digest for the previous header. Dropped gens are
     g_dropped, never g_rejected (aborted_stale). */
  if (g_have_main && g_main_job.have
      && memcmp(g_main_job.header, job.header, 100) == 0
      && memcmp(g_main_job.header + 108, job.header + 108, 4) == 0) {
    g_job_gen++;
    job.gen = g_job_gen;
    job.have = 1;
    note_gen_parent_locked(job.gen, job.header);
    g_main_job = job;
    atomic_store_explicit(&g_share_bits_live, job.share_bits, memory_order_release);
    atomic_store_explicit(&g_block_bits_live, job.block_bits, memory_order_release);
    atomic_store_explicit(&g_job_seq, g_job_gen, memory_order_release);
    atomic_fetch_add_explicit(&g_stamp_seq, 1, memory_order_release);
    pthread_mutex_unlock(&g_job_mu);
    return;
  }
  if (g_have_pending
      && memcmp(g_pending_job.header, job.header, 100) == 0
      && memcmp(g_pending_job.header + 108, job.header + 108, 4) == 0) {
    memcpy(g_pending_job.header, job.header, SHEAR_HEADER_LEN);
    g_pending_job.share_bits = job.share_bits;
    g_pending_job.block_bits = job.block_bits;
    if (job.height > 0) g_pending_job.height = job.height;
    if (job.jobId[0]) snprintf(g_pending_job.jobId, sizeof(g_pending_job.jobId), "%s", job.jobId);
    pthread_mutex_unlock(&g_job_mu);
    return;
  }
  /* New RandomX K: keep hashing the live job while the next epoch inits. */
  g_pending_job = job;
  g_have_pending = 1;
  pthread_mutex_unlock(&g_job_mu);
  if (shear_prepare(job.header) == 0) promote_pending_job();
}

static void install_live_job_locked(JobSnap job) {
  g_job_at_ns = st_now_ns();
  g_job_gen++;
  job.gen = g_job_gen;
  note_gen_parent_locked(job.gen, job.header);
  job.have = 1;
  g_main_job = job;
  g_have_main = 1;
  atomic_store_explicit(&g_share_bits_live, job.share_bits, memory_order_release);
  atomic_store_explicit(&g_block_bits_live, job.block_bits, memory_order_release);
  atomic_store_explicit(&g_job_seq, g_job_gen, memory_order_release);
}

static void promote_pending_job(void) {
  pthread_mutex_lock(&g_job_mu);
  if (!g_have_pending) {
    pthread_mutex_unlock(&g_job_mu);
    return;
  }
  JobSnap job = g_pending_job;
  pthread_mutex_unlock(&g_job_mu);
  if (!shear_epoch_ready(job.header)) return;
  if (shear_commit_epoch() != 0 && !shear_epoch_ready(job.header)) return;
  pthread_mutex_lock(&g_job_mu);
  if (!g_have_pending) {
    pthread_mutex_unlock(&g_job_mu);
    return;
  }
  job = g_pending_job;
  g_have_pending = 0;
  install_live_job_locked(job);
  pthread_mutex_unlock(&g_job_mu);
  if (g_color) {
    printf(C_CYN "job %s" C_RST " height=" C_CYN "%d" C_RST " shareBits=%d blockBits=%d algo=%s workers=%d backend=%s cpuCores=%d cpuThreads=%d\n",
           job.jobId, job.height, job.share_bits, job.block_bits, SHEAR_ALGO, g_threads,
           shear_hash_backend(), g_cpu_cores, g_cpu_threads);
  } else {
    printf("job %s height=%d shareBits=%d blockBits=%d algo=%s workers=%d backend=%s cpuCores=%d cpuThreads=%d\n",
           job.jobId, job.height, job.share_bits, job.block_bits, SHEAR_ALGO, g_threads,
           shear_hash_backend(), g_cpu_cores, g_cpu_threads);
  }
  fflush(stdout);
}

static void apply_ack(const char *line) {
  int msgid = 0;
  json_int(line, "id", &msgid);
  char status[80] = "";
  json_token(line, "status", status, sizeof(status));
  char err[160] = "";
  json_token(line, "error", err, sizeof(err));
  char note[200] = "";
  json_token(line, "message", note, sizeof(note));
  char low[160];
  snprintf(low, sizeof(low), "%s", err[0] ? err : status);
  for (char *p = low; *p; p++) *p = (char)tolower((unsigned char)*p);
  /* Login replies with status=OK. Only a submit ACK (in-flight share)
   * counts. Submit ids start at 2, so id 1 is always the login. */
  if (msgid == 1) {
    if (err[0] || note[0]) {
      fprintf(stderr, "pool refused login: %s\n", note[0] ? note : err);
    }
    return;
  }
  /* PR146: the in-flight submit this ack answers, by id; a pool that does
   * not echo ids gets the oldest (replies are in order). */
  SentShare acked;
  memset(&acked, 0, sizeof(acked));
  {
    int hit = -1;
    for (int i = 0; i < IN_FLIGHT_MAX; i++) {
      if (g_sent_tab[i].used && g_sent_tab[i].id == msgid) hit = i;
    }
    if (hit < 0) {
      for (int i = 0; i < IN_FLIGHT_MAX; i++) {
        if (g_sent_tab[i].used && (hit < 0 || g_sent_tab[i].sent_ns < g_sent_tab[hit].sent_ns)) hit = i;
      }
    }
    if (hit >= 0) {
      acked = g_sent_tab[hit];
      g_sent_tab[hit].used = 0;
      atomic_fetch_sub(&g_inflight, 1);
    }
  }
  int inflight = acked.used;
  if (inflight > 0 && acked.sent_ns) {
    pthread_mutex_lock(&g_st_mu);
    g_lat_last = (double)(st_now_ns() - acked.sent_ns) / 1e6;
    g_lat_sum += g_lat_last;
    g_lat_n++;
    pthread_mutex_unlock(&g_st_mu);
  }
  if (strstr(low, "ok") && !err[0]) {
    g_busy_backoff_ns = 0;
    if (inflight > 0) {
      g_accepted++;
      char blk[16] = "";
      json_token(line, "block", blk, sizeof(blk));
      json_token(line, "hash", g_last_ack_hash, sizeof(g_last_ack_hash));
      if (strcmp(blk, "true") == 0 || strcmp(blk, "1") == 0) {
        g_blocks++;
        uint64_t h = (uint64_t)atomic_load_explicit(&g_hashes, memory_order_relaxed);
        uint64_t round = h >= g_round0 ? h - g_round0 : h;
        g_round0 = h;
        double elapsed = (double)(time(NULL) - (g_t0 ? g_t0 : time(NULL)));
        if (elapsed < 1) elapsed = 1;
        char rate[32];
        fmt_hashrate(hs10(), rate, sizeof(rate));
        int height = g_height, sb = 0, bb = 0;
        char jobId[80];
        snprintf(jobId, sizeof(jobId), "%s", g_last_job[0] ? g_last_job : "-");
        pthread_mutex_lock(&g_job_mu);
        if (g_have_main && g_main_job.have) {
          if (g_main_job.height > 0) height = g_main_job.height;
          sb = g_main_job.share_bits;
          bb = g_main_job.block_bits;
          if (!g_last_job[0]) snprintf(jobId, sizeof(jobId), "%s", g_main_job.jobId);
        }
        pthread_mutex_unlock(&g_job_mu);
        char linebuf[768];
        snprintf(linebuf, sizeof(linebuf),
                 "BLOCKFOUND!!!  *** SHEAR BLOCK SEALED ***  height=%d job=%s nonce=%llu hash=%s "
                 "shareBits=%d blockBits=%d hashes=%llu round=%llu hashrate=%s accepted=%d rejected=%d "
                 "submitted=%llu blocks=%d dropped=%llu threads=%d cpuCores=%d cpuThreads=%d "
                 "backend=%s user=%s pool=%s:%d elapsed=%.0fs\n",
                 height, jobId, (unsigned long long)g_last_nonce,
                 g_last_ack_hash[0] ? g_last_ack_hash : (g_last_hash[0] ? g_last_hash : "-"),
                 sb, bb, (unsigned long long)h, (unsigned long long)round,
                 rate, g_accepted, g_rejected, (unsigned long long)g_submitted, g_blocks,
                 (unsigned long long)g_dropped, g_threads, g_cpu_cores, g_cpu_threads,
                 shear_hash_backend(), g_login, g_host, g_port, elapsed);
        if (g_color) {
          fputs("\033[1;91m\033[1;93m\033[1;92m", stdout);
          fputs(linebuf, stdout);
          fputs(C_RST, stdout);
          fflush(stdout);
        } else {
          fputs(linebuf, stdout);
          fflush(stdout);
        }
      } else if (g_color) {
        fprintf(stderr, C_GRN "accept" C_RST "\n");
      }
    }
    return;
  }
  if (strstr(low, "busy")) {
    if (inflight > 0) enqueue_front(&acked.s);
    /* R41: back off before re-sending (100 ms doubling to 2 s). A soak saw
     * 3910 busy replies in five minutes from an immediate re-send. */
    g_busy_n++;
    g_busy_backoff_ns = g_busy_backoff_ns ? g_busy_backoff_ns * 2 : 100000000ull;
    if (g_busy_backoff_ns > 2000000000ull) g_busy_backoff_ns = 2000000000ull;
    g_busy_until_ns = st_now_ns() + g_busy_backoff_ns;
    return;
  }
  if (strstr(low, "stale")) {
    if (inflight > 0) {
      g_stale++;
      note_reason(g_stl_r, 8, err[0] ? err : "stale");
    }
    if (g_color) fprintf(stderr, C_YEL "stale %s" C_RST "\n", err[0] ? err : (low[0] ? low : "stale"));
    else fprintf(stderr, "stale %s\n", err[0] ? err : (low[0] ? low : "stale"));
    return;
  }
  if (err[0] || strstr(low, "error") || strstr(low, "refus")) {
    if (inflight > 0) {
      g_rejected++;
      note_reason(g_rej_r, 16, err[0] ? err : (low[0] ? low : "unknown"));
    }
    if (g_color) fprintf(stderr, C_RED "reject %s" C_RST "\n", err[0] ? err : (low[0] ? low : "unknown"));
    else fprintf(stderr, "reject %s\n", err[0] ? err : (low[0] ? low : "unknown"));
    if (strstr(low, "old_miner") || strstr(low, "client")) {
      fprintf(stderr, "pool refused this client — use ShearHash\n");
    }
  }
}

static void handle_line(Conn *c, const char *line) {
  (void)c;
  if (!line || !line[0]) return;
  apply_job(line);
  char method[32] = "";
  json_token(line, "method", method, sizeof(method));
  if (strcmp(method, "job") != 0) apply_ack(line);
}

static void drain_lines(Conn *c) {
  char *start = c->buf;
  int remain = c->buflen;
  for (;;) {
    char *nl = memchr(start, '\n', (size_t)remain);
    if (!nl) break;
    *nl = 0;
    if (start[0]) handle_line(c, start);
    remain -= (int)(nl + 1 - start);
    start = nl + 1;
  }
  if (start != c->buf && remain > 0) memmove(c->buf, start, (size_t)remain);
  c->buflen = remain;
  c->buf[c->buflen] = 0;
}

static int copy_main_job(JobSnap *out) {
  pthread_mutex_lock(&g_job_mu);
  int ok = g_have_main;
  if (ok) *out = g_main_job;
  pthread_mutex_unlock(&g_job_mu);
  return ok;
}

static void outl(FILE *out, const char *fmt, ...);

static int enqueue_share(const char *jobId, uint64_t nonce, const unsigned char hash[32], int gen, const BluKey *key) {
  /* PR146: an all-zero digest is a failed hash call, never a share. */
  int allz = 1;
  for (int i = 0; i < 32; i++) allz &= hash[i] == 0;
  if (allz) {
    g_dropped++;
    return 0;
  }
  pthread_mutex_lock(&g_q_mu);
  int next = (g_qtail + 1) % QCAP;
  if (next == g_qhead) {
    g_dropped++;
    pthread_mutex_unlock(&g_q_mu);
    return 0;
  }
  g_meets++;
  Share *s = &g_q[g_qtail];
  snprintf(s->jobId, sizeof(s->jobId), "%s", jobId);
  s->nonce = nonce;
  s->gen = gen;
  s->share_bits = credit_bits_of_nonce(nonce);
  s->enq_ns = st_now_ns();
  s->have_key = key != NULL;
  if (key) s->key = *key;
  shear_hash_hex(hash, s->hash);
  snprintf(g_last_job, sizeof(g_last_job), "%s", jobId);
  g_last_nonce = nonce;
  snprintf(g_last_hash, sizeof(g_last_hash), "%s", s->hash);
  g_qtail = next;
  pthread_mutex_unlock(&g_q_mu);
  return 1;
}

static int dequeue_share(Share *out) {
  pthread_mutex_lock(&g_q_mu);
  if (g_qhead == g_qtail) {
    pthread_mutex_unlock(&g_q_mu);
    return 0;
  }
  *out = g_q[g_qhead];
  g_qhead = (g_qhead + 1) % QCAP;
  pthread_mutex_unlock(&g_q_mu);
  return 1;
}

static int enqueue_front(const Share *s) {
  pthread_mutex_lock(&g_q_mu);
  int prev = (g_qhead + QCAP - 1) % QCAP;
  if (prev == g_qtail) {
    pthread_mutex_unlock(&g_q_mu);
    return 0;
  }
  g_q[prev] = *s;
  g_qhead = prev;
  pthread_mutex_unlock(&g_q_mu);
  return 1;
}

static void *hash_worker(void *arg) {
  int tid = (int)(intptr_t)arg;
#if defined(__linux__)
  {
    cpu_set_t set;
    CPU_ZERO(&set);
    int cpu = tid;
    if (g_cpu_map_n > 0) cpu = g_cpu_map[tid % g_cpu_map_n];
    else {
      long ncpu = sysconf(_SC_NPROCESSORS_ONLN);
      if (ncpu < 1) ncpu = 1;
      cpu = tid % (int)ncpu;
    }
    CPU_SET((unsigned)cpu, &set);
    if (pthread_setaffinity_np(pthread_self(), sizeof(set), &set) == 0 && tid < ST_MAXT) g_tstat[tid].cpu = cpu;
  }
#endif
  /* R41 accounting: every digest a worker computes is counted once, as
   * checked (tested against the target) or discarded (its job changed
   * while it hashed). busy_ns is the time inside the hash calls. */
  ThreadStat *ts = &g_tstat[tid < ST_MAXT ? tid : ST_MAXT - 1];
  uint64_t n = g_origin + (uint64_t)tid;
  JobSnap job;
  memset(&job, 0, sizeof(job));
  int last_gen = -1;
  unsigned last_stamp = 0;
  unsigned char header[SHEAR_HEADER_LEN];
  unsigned char primed_hdr[SHEAR_HEADER_LEN];
  int primed = 0;
  uint64_t primed_n = 0;
  /* R28 BluNotes: each key binds at most 256 nonces on one header; a hit
   * or a header change moves on, so no two shares share a key. */
  BluKey key, primed_key;
  int have_key = 0;
  unsigned ctr = 0;
  uint64_t bind = 0;
  int bind_ok = 0;
  memset(&key, 0, sizeof(key));
  memset(&primed_key, 0, sizeof(primed_key));
  /* PR146: a job this thread could not hash (no VM: allocation failed or no
   * free slot) is skipped until the next job; never a zero digest. */
  int skip_gen = -1;
  while (!g_stop) {
    /* --max-temp: a worker above the active count rests (counted as idle). */
    if (tid >= atomic_load_explicit(&g_active_threads, memory_order_relaxed)) {
      primed = 0;
      usleep(100000);
      continue;
    }
    int seq = atomic_load_explicit(&g_job_seq, memory_order_acquire);
    unsigned stamp = atomic_load_explicit(&g_stamp_seq, memory_order_acquire);
    if (skip_gen >= 0 && seq == skip_gen) {
      usleep(100000);
      continue;
    }
    skip_gen = -1;
    if (seq != last_gen || !job.have) {
      primed = 0;
      if (!copy_main_job(&job)) {
        usleep(10000);
        continue;
      }
      last_gen = job.gen;
      last_stamp = atomic_load_explicit(&g_stamp_seq, memory_order_acquire);
      memcpy(header, job.header, SHEAR_HEADER_LEN);
      shear_bind(header);
      n = g_origin + (uint64_t)tid;
      bind_ok = 0;
      have_key = 0;
    } else if (stamp != last_stamp) {
      unsigned char live[SHEAR_HEADER_LEN];
      pthread_mutex_lock(&g_job_mu);
      int have_live = g_have_main && g_main_job.have;
      if (have_live) memcpy(live, g_main_job.header, SHEAR_HEADER_LEN);
      pthread_mutex_unlock(&g_job_mu);
      if (!have_live) {
        usleep(10000);
        continue;
      }
      last_stamp = stamp;
      /* hash_next returns the previous header's digest. Any restamp (even
       * same K / timestamp-only) must drop the in-flight pair. Submitting
       * that digest against the live header is pool bad_hash. */
      primed = 0;
      memcpy(header, live, SHEAR_HEADER_LEN);
      bind_ok = 0;
      have_key = 0;
    }
    uint64_t stamped = stamp_share_nonce(n);
    if (blu_enabled()) {
      if (!have_key || ctr >= 256) {
        if (blu_new_key(&key) != 0) {
          usleep(1000);
          continue;
        }
        have_key = 1;
        ctr = 0;
        bind_ok = 0;
      }
      if (!bind_ok) {
        bind = blu_bind(header, &key);
        bind_ok = 1;
      }
      stamped = blu_nonce(stamped, bind, ctr);
      ctr++;
    }
    shear_set_nonce(header, stamped);
    if (!primed) {
      uint64_t t0 = st_now_ns();
      int first_rc = shear_hash_first(header);
      if (first_rc != 0) {
        unsigned char hash[32];
        if (shear_hash_checked(header, hash) != 0) {
          outl(stderr, "ShearK-Miner: hash setup failed on this thread (thread %d, backend %s); skipping job %s\n",
               tid, shear_hash_backend(), job.jobId);
          skip_gen = last_gen;
          primed = 0;
          continue;
        }
        atomic_fetch_add_explicit(&ts->busy_ns, st_now_ns() - t0, memory_order_relaxed);
        atomic_fetch_add_explicit(&ts->hashes, 1, memory_order_relaxed);
        atomic_fetch_add_explicit(&g_hashes, 1, memory_order_relaxed);
        if (atomic_load_explicit(&g_job_seq, memory_order_acquire) == last_gen) {
          atomic_fetch_add_explicit(&ts->checked, 1, memory_order_relaxed);
          if (share_or_block_hit(hash, stamped)) {
            enqueue_share(job.jobId, stamped, hash, job.gen, blu_enabled() ? &key : NULL);
            have_key = 0;
          }
        } else {
          atomic_fetch_add_explicit(&ts->discarded, 1, memory_order_relaxed);
        }
        n += (uint64_t)g_threads;
        continue;
      }
      atomic_fetch_add_explicit(&ts->busy_ns, st_now_ns() - t0, memory_order_relaxed);
      primed = 1;
      primed_n = stamped;
      primed_key = key;
      memcpy(primed_hdr, header, SHEAR_HEADER_LEN);
      n += (uint64_t)g_threads;
      continue;
    }
    unsigned char hash[32];
    uint64_t t1 = st_now_ns();
    int next_rc = shear_hash_next(header, hash);
    atomic_fetch_add_explicit(&ts->busy_ns, st_now_ns() - t1, memory_order_relaxed);
    if (next_rc != 0) {
      primed = 0;
      continue;
    }
    atomic_fetch_add_explicit(&ts->hashes, 1, memory_order_relaxed);
    atomic_fetch_add_explicit(&g_hashes, 1, memory_order_relaxed);
    int live_gen = atomic_load_explicit(&g_job_seq, memory_order_acquire) == last_gen;
    atomic_fetch_add_explicit(live_gen ? &ts->checked : &ts->discarded, 1, memory_order_relaxed);
    if (live_gen && share_or_block_hit(hash, primed_n)) {
      unsigned char check[32];
      if (shear_hash_checked(primed_hdr, check) != 0) {
        g_dropped++;
        outl(stderr, "ShearK-Miner: hash setup failed on this thread (thread %d, backend %s); skipping job %s\n",
             tid, shear_hash_backend(), job.jobId);
        skip_gen = last_gen;
        primed = 0;
        continue;
      }
      if (memcmp(hash, check, 32) != 0) {
        memcpy(hash, check, 32);
        if (!share_or_block_hit(hash, primed_n)) {
          g_dropped++;
          primed_n = stamped;
          primed_key = key;
          memcpy(primed_hdr, header, SHEAR_HEADER_LEN);
          n += (uint64_t)g_threads;
          continue;
        }
      }
      enqueue_share(job.jobId, primed_n, hash, job.gen, blu_enabled() ? &primed_key : NULL);
      if (blu_enabled() && memcmp(primed_key.P, key.P, 32) == 0) have_key = 0;
    }
    primed_n = stamped;
    primed_key = key;
    memcpy(primed_hdr, header, SHEAR_HEADER_LEN);
    n += (uint64_t)g_threads;
  }
  return NULL;
}

static void seed_origin(void) {
#if defined(__APPLE__)
  arc4random_buf(&g_origin, sizeof(g_origin));
#else
  FILE *ur = fopen("/dev/urandom", "rb");
  if (!ur || fread(&g_origin, sizeof(g_origin), 1, ur) != 1) {
    g_origin = ((uint64_t)time(NULL) << 16) ^ (uint64_t)getpid();
  }
  if (ur) fclose(ur);
#endif
}

static void clear_jobs(void) {
  pthread_mutex_lock(&g_job_mu);
  g_have_main = 0;
  g_have_pending = 0;
  atomic_store_explicit(&g_job_seq, 0, memory_order_release);
  pthread_mutex_unlock(&g_job_mu);
  pthread_mutex_lock(&g_q_mu);
  g_qhead = g_qtail = 0;
  pthread_mutex_unlock(&g_q_mu);
  /* A new connection: nothing of the old one is in flight. */
  memset(g_sent_tab, 0, sizeof(g_sent_tab));
  atomic_store(&g_inflight, 0);
}

/* PR146: keep a queued share on the pool's terms. The live job at the live
 * target is always credited. Otherwise (a previous job, or a share target
 * that stepped up since the hit) the pool credits it for 12 s, and only on
 * the same parent block: a parent change is a stale share at any age. */
static int share_keep(double age_ms, int same_gen, int same_parent, int share_bits, int live_bits) {
  int step_up = live_bits > share_bits && share_bits > 0;
  if (same_gen && !step_up) return 1;
  if (!same_parent) return 0;
  return age_ms < (double)SHARE_GRACE_MS;
}

static int share_still_good(const Share *s) {
  int live_gen = atomic_load_explicit(&g_job_seq, memory_order_acquire);
  int live = atomic_load_explicit(&g_share_bits_live, memory_order_relaxed);
  int same_parent = 0;
  pthread_mutex_lock(&g_job_mu);
  if (g_have_main && g_main_job.have && g_gen_ring_gen[s->gen % GEN_RING] == s->gen) {
    same_parent = memcmp(g_gen_ring_parent[s->gen % GEN_RING], g_main_job.header + 4, 32) == 0;
  }
  pthread_mutex_unlock(&g_job_mu);
  double age_ms = (double)(st_now_ns() - s->enq_ns) / 1e6;
  return share_keep(age_ms, s->gen == live_gen, same_parent, s->share_bits, live);
}

static void flush_shares(Conn *mainc) {
  Share s;
  while (dequeue_share(&s)) {
    if (!share_still_good(&s)) {
      g_dropped++;
      continue;
    }
    int slot = -1;
    for (int i = 0; i < IN_FLIGHT_MAX; i++) {
      if (!g_sent_tab[i].used) {
        slot = i;
        break;
      }
    }
    if (slot < 0 || atomic_load_explicit(&g_inflight, memory_order_acquire) >= IN_FLIGHT_MAX
        || (g_busy_until_ns && st_now_ns() < g_busy_until_ns)) {
      enqueue_front(&s);
      return;
    }
    if (++g_submit_id >= 1000000000 || g_submit_id < 2) g_submit_id = 2;
    int wr = send_submit(mainc, g_login, g_threads, g_submit_id, s.jobId, s.nonce, s.hash, s.have_key ? &s.key : NULL);
    if (wr == 1) {
      enqueue_front(&s);
      return;
    }
    if (wr == 0) {
      g_sent_tab[slot].used = 1;
      g_sent_tab[slot].id = g_submit_id;
      g_sent_tab[slot].sent_ns = st_now_ns();
      g_sent_tab[slot].s = s;
      atomic_fetch_add_explicit(&g_inflight, 1, memory_order_relaxed);
      g_submitted++;
    }
  }
}

static void fmt_hashrate(double hs, char *buf, size_t n) {
  static const char *units[] = {
    "R/s", "kR/s", "mR/s", "gR/s", "tR/s", "pR/s", "eR/s", "zR/s",
  };
  int i = 0;
  if (!(hs > 0.0)) {
    snprintf(buf, n, "0.0 R/s");
    return;
  }
  while (hs >= 1000.0 && i < 7) {
    hs /= 1000.0;
    i += 1;
  }
  if (i == 0) snprintf(buf, n, "%.1f %s", hs, units[i]);
  else snprintf(buf, n, "%.2f %s", hs, units[i]);
}

static void print_config(void) {
  printf("{\"name\":\"%s\",\"client\":\"%s\",\"algorithm\":\"%s\",\"personalisation\":\"%s\","
         "\"version\":\"%s\",\"clientLogin\":\"direct\",\"feePct\":0,"
         "\"pool\":\"%s:%d\",\"headerBytes\":%d,\"magic\":\"%s\","
         "\"rxMode\":\"light\",\"rxCacheMiB\":%d,\"hugePages\":%s,"
         "\"threads\":%d,\"backend\":\"%s\",\"destBound\":%s,\"dest20\":\"%s\",\"tls\":%s}\n",
         SHEAR_MINER_NAME, SHEAR_CLIENT, SHEAR_ALGO, SHEAR_PERSONAL,
         SHEAR_VERSION, g_host, g_port, SHEAR_HEADER_LEN, SHEAR_MAGIC,
         SHEAR_RX_CACHE_MIB, shear_hash_huge_pages() ? "true" : "false",
         g_threads, shear_hash_backend(),
         g_have_note ? "true" : "false",
         g_have_note ? g_dest20_hex : "",
         g_tls ? "true" : "false");
}

/* ------------------------------------------------------------------ R41 */
/* Local rig banner, live stats, auto-tune and memory mode. Everything here
 * is printed or written locally; nothing reaches the network (rig.h). */

/* usleep() may refuse a second or more (BSD, macOS); this does not. */
static void sleep_ms(long ms) {
#if defined(_WIN32)
  Sleep((DWORD)ms);
#else
  struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {}
#endif
}

static const char *PHONE_MSG =
    "Mining on phones is not supported: it can overheat the device and damage the battery.\n"
    "Please mine on a desktop, laptop or server.";

static int cpu_node(int cpu) {
#if defined(__linux__)
  for (int nd = 0; nd < 64; nd++) {
    char p[96];
    snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/node%d", cpu, nd);
    if (access(p, F_OK) == 0) return nd;
  }
#else
  (void)cpu;
#endif
  return -1;
}

static long long self_rss(void) {
#if defined(__linux__)
  FILE *f = fopen("/proc/self/status", "r");
  if (!f) return -1;
  char line[256];
  long long kb = -1;
  while (fgets(line, sizeof(line), f)) {
    if (!strncmp(line, "VmRSS:", 6)) kb = atoll(line + 6);
  }
  fclose(f);
  return kb >= 0 ? kb * 1024 : -1;
#else
  return -1;
#endif
}

/* Print one line, masking host, home paths and IPs under --redact. */
static void outl(FILE *out, const char *fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  if (g_redact) rig_redact(buf, sizeof(buf), &g_rig);
  fputs(buf, out);
}

static const char *pool_shown(void) { return g_redact ? "<pool>" : g_host; }

static void build_flags(char *out, size_t n) {
  snprintf(out, n, "%s, %s"
#if defined(__x86_64__) && !defined(__AVX2__)
           ", x86-64 baseline (RandomX features chosen at run time)"
#elif defined(__AVX2__)
           ", -march with AVX2 (local build)"
#endif
           , __DATE__,
#if defined(__clang__)
           "clang " __clang_version__
#elif defined(__GNUC__)
           "gcc " __VERSION__
#else
           "unknown compiler"
#endif
  );
}

static void print_banner(FILE *out) {
  char hb[64];
  outl(out, "---- ShearK-Miner %s rig (local only: none of this is sent to the pool) ----\n", SHEAR_VERSION);
  /* rig_print redacts on its own. */
  rig_print(out, &g_rig, g_redact);
  char therm[160];
  rig_thermal("", therm, sizeof(therm), NULL);
  outl(out, "  %-15s %s\n", "thermal", therm);
  outl(out, "  %-15s %s; JIT %s; AES %s; huge pages %s\n", "RandomX", g_mode_why,
       strcmp(shear_hash_backend(), "interpreter") ? "on" : "off (interpreter)",
       shear_hash_hard_aes() ? "hardware" : "software",
       shear_hash_huge_pages() ? "hugetlb (reserved 2 MiB pages)"
#if defined(__linux__)
       : "none reserved; transparent huge pages asked for (madvise)");
#else
       : "not available (4K pages)");
#endif
  long long rss = self_rss();
  if (rss > 0) snprintf(hb, sizeof(hb), "%.0f MiB resident", (double)rss / (1 << 20));
  else snprintf(hb, sizeof(hb), "memory use unknown");
  if (g_init_s >= 0) outl(out, "  %-15s %.2f s to build the cache%s; %s\n", "RandomX init", g_init_s,
                          strcmp(shear_hash_backend(), "jit-full") ? "" : " and dataset", hb);
  else outl(out, "  %-15s unknown; %s\n", "RandomX init", hb);
  outl(out, "  %-15s %d used of %d usable (%s)\n", "threads", g_threads,
       g_rig.allowed > 0 ? g_rig.allowed : g_cpu_threads, g_threads_why);
  if (g_tune_table[0]) outl(out, "  %-15s %s\n", "auto-tune", g_tune_table);
  for (int i = 0; i < g_threads && (g_verbose || i < 16); i++) {
    int cpu = g_cpu_map_n > 0 ? g_cpu_map[i % g_cpu_map_n] : -1;
    int nd = cpu >= 0 ? cpu_node(cpu) : -1;
    char cs[16], ns[16];
    snprintf(cs, sizeof(cs), cpu >= 0 ? "%d" : "unpinned", cpu);
    snprintf(ns, sizeof(ns), nd >= 0 ? "%d" : "unknown", nd);
    outl(out, "  thread %-8d CPU %s, NUMA node %s, own RandomX VM and 2 MiB scratchpad\n", i, cs, ns);
  }
  if (!g_verbose && g_threads > 16) outl(out, "  (%d more threads; --verbose lists them)\n", g_threads - 16);
  char flags[256];
  build_flags(flags, sizeof(flags));
  char st[65];
  int ok = shear_selftest(st);
  outl(out, "  %-15s ShearK-Miner %s, %s; selftest %s %s\n", "version", SHEAR_VERSION, flags, ok ? "ok" : "FAIL", st);
  outl(out, "------------------------------------------------------------------------------\n");
  fflush(out);
}

static void fmt_rate_cell(double v, char *out, size_t n) {
  if (v < 0) snprintf(out, n, "%9s", "-");
  else snprintf(out, n, "%9.1f", v);
}

static void print_stats(FILE *out) {
  char a[16], b[16], c[16];
  double span = 0;
  fmt_rate_cell(stats_rate(-1, 10, &span), a, sizeof(a));
  fmt_rate_cell(stats_rate(-1, 60, NULL), b, sizeof(b));
  fmt_rate_cell(stats_rate(-1, 900, NULL), c, sizeof(c));
  double up = stats_uptime();
  outl(out, "---- stats  uptime %dh%02dm%02ds  (local only) ----\n", (int)(up / 3600), ((int)up / 60) % 60, (int)up % 60);
  outl(out, "  %-10s H/s  10s %s   60s %s   15m %s   threads %d active of %d\n", "hashrate", a, b, c,
       atomic_load(&g_active_threads) < g_threads ? atomic_load(&g_active_threads) : g_threads, g_threads);
  outl(out, "  %-10s %6s %9s %9s %9s %7s\n", "thread", "cpu", "10s H/s", "60s H/s", "15m H/s", "idle%");
  int nt = stats_threads();
  for (int i = 0; i < nt && (g_verbose || i < 32); i++) {
    char r10[16], r60[16], r900[16], cpu[16];
    fmt_rate_cell(stats_rate(i, 10, NULL), r10, sizeof(r10));
    fmt_rate_cell(stats_rate(i, 60, NULL), r60, sizeof(r60));
    fmt_rate_cell(stats_rate(i, 900, NULL), r900, sizeof(r900));
    double idle = stats_idle(i, 60);
    snprintf(cpu, sizeof(cpu), g_tstat[i].cpu >= 0 ? "%d" : "-", g_tstat[i].cpu);
    if (idle >= 0) outl(out, "  %-10d %6s %s %s %s %7.2f\n", i, cpu, r10, r60, r900, idle);
    else outl(out, "  %-10d %6s %s %s %s %7s\n", i, cpu, r10, r60, r900, "-");
  }
  char rej[256] = "", stl[160] = "";
  pthread_mutex_lock(&g_st_mu);
  for (int i = 0; i < 16 && g_rej_r[i].name[0]; i++) {
    char part[64];
    snprintf(part, sizeof(part), "%s%s %llu", rej[0] ? ", " : "", g_rej_r[i].name, (unsigned long long)g_rej_r[i].n);
    if (strlen(rej) + strlen(part) < sizeof(rej)) strcat(rej, part);
  }
  for (int i = 0; i < 8 && g_stl_r[i].name[0]; i++) {
    char part[64];
    snprintf(part, sizeof(part), "%s%s %llu", stl[0] ? ", " : "", g_stl_r[i].name, (unsigned long long)g_stl_r[i].n);
    if (strlen(stl) + strlen(part) < sizeof(stl)) strcat(stl, part);
  }
  double lat_last = g_lat_last, lat_mean = g_lat_n ? g_lat_sum / (double)g_lat_n : -1;
  pthread_mutex_unlock(&g_st_mu);
  outl(out, "  %-10s accepted %d   rejected %d%s%s%s   stale %d%s%s%s   dropped %llu   busy %llu   blocks %d\n", "shares",
       g_accepted, g_rejected, rej[0] ? " (" : "", rej, rej[0] ? ")" : "", g_stale, stl[0] ? " (" : "", stl, stl[0] ? ")" : "",
       (unsigned long long)g_dropped, (unsigned long long)g_busy_n, g_blocks);
  int sb = 0, bb = 0, height = g_height;
  char jobId[80] = "-";
  pthread_mutex_lock(&g_job_mu);
  if (g_have_main && g_main_job.have) {
    snprintf(jobId, sizeof(jobId), "%s", g_main_job.jobId);
    sb = g_main_job.share_bits;
    bb = g_main_job.block_bits;
    if (g_main_job.height > 0) height = g_main_job.height;
  }
  pthread_mutex_unlock(&g_job_mu);
  double age = g_job_at_ns ? (double)(st_now_ns() - g_job_at_ns) / 1e9 : -1;
  char lat[96];
  if (lat_last >= 0) snprintf(lat, sizeof(lat), "last %.0f ms, mean %.0f ms over %llu", lat_last, lat_mean, (unsigned long long)g_lat_n);
  else snprintf(lat, sizeof(lat), "no reply yet");
  outl(out, "  %-10s %s height %d shareBits %d blockBits %d age %s   pool %s latency %s\n", "job", jobId, height, sb, bb,
       age >= 0 ? (snprintf(c, sizeof(c), "%.0fs", age), c) : "-", pool_shown(), lat);
  uint64_t computed = stats_sum_hashes(), reported = atomic_load(&g_hashes);
  uint64_t checked = stats_sum_checked(), discarded = stats_sum_discarded();
  int okid = computed == reported && computed == checked + discarded;
  outl(out, "  %-10s computed %llu = reported %llu = checked %llu + discarded %llu  %s\n", "hashes",
       (unsigned long long)computed, (unsigned long long)reported, (unsigned long long)checked,
       (unsigned long long)discarded, okid ? "OK" : "MISMATCH");
  char therm[160];
  rig_thermal("", therm, sizeof(therm), NULL);
  int tst = atomic_load(&g_thermal_state);
  outl(out, "  %-10s %s%s\n", "thermal", therm,
       g_max_temp > 0 ? (tst == 2 ? "; above --max-temp: 1 thread" : tst == 1 ? "; above --max-temp: half the threads" : "; under --max-temp")
                      : "");
  fflush(out);
}

static void write_stats_file(void) {
  if (!g_stats_file) return;
  char tmp[600];
  snprintf(tmp, sizeof(tmp), "%s.tmp", g_stats_file);
  FILE *f = fopen(tmp, "w");
  if (!f) return;
  fprintf(f, "{\"version\":\"%s\",\"uptime\":%.1f,\"threads\":%d,\"hs10\":%.2f,\"hs60\":%.2f,\"hs900\":%.2f,",
          SHEAR_VERSION, stats_uptime(), g_threads, stats_rate(-1, 10, NULL), stats_rate(-1, 60, NULL), stats_rate(-1, 900, NULL));
  fprintf(f, "\"accepted\":%d,\"rejected\":%d,\"stale\":%d,\"dropped\":%llu,\"busy\":%llu,\"blocks\":%d,",
          g_accepted, g_rejected, g_stale, (unsigned long long)g_dropped, (unsigned long long)g_busy_n, g_blocks);
  fprintf(f, "\"hashes\":{\"computed\":%llu,\"reported\":%llu,\"checked\":%llu,\"discarded\":%llu},\"perThread\":[",
          (unsigned long long)stats_sum_hashes(), (unsigned long long)atomic_load(&g_hashes),
          (unsigned long long)stats_sum_checked(), (unsigned long long)stats_sum_discarded());
  for (int i = 0; i < stats_threads(); i++) {
    fprintf(f, "%s{\"tid\":%d,\"cpu\":%d,\"hashes\":%llu,\"hs10\":%.2f,\"hs60\":%.2f,\"idle60\":%.2f}", i ? "," : "", i,
            g_tstat[i].cpu, (unsigned long long)atomic_load(&g_tstat[i].hashes), stats_rate(i, 10, NULL), stats_rate(i, 60, NULL),
            stats_idle(i, 60));
  }
  fprintf(f, "]}\n");
  fclose(f);
  remove(g_stats_file);
  rename(tmp, g_stats_file);
}

#if !defined(_WIN32)
static void on_usr1(int s) {
  (void)s;
  atomic_store(&g_print_req, 1);
}
#endif

static void *stdin_thread(void *arg) {
  (void)arg;
  char line[64];
  while (!g_stop && fgets(line, sizeof(line), stdin)) {
    if (line[0] == 's' || line[0] == 'S') atomic_store(&g_print_req, 1);
  }
  return NULL;
}

static void *stats_thread(void *arg) {
  (void)arg;
  uint64_t last_print = st_now_ns(), last_file = 0, last_therm = 0;
  while (!g_stop) {
    sleep_ms(1000);
    stats_tick();
    double r = stats_rate(-1, 10, NULL);
    atomic_store(&g_hs10_milli, r > 0 ? (uint_fast64_t)(r * 1000.0) : 0);
    uint64_t now = st_now_ns();
    if (atomic_exchange(&g_print_req, 0) || (g_stats_interval > 0 && now - last_print >= (uint64_t)g_stats_interval * 1000000000ull)) {
      print_stats(stdout);
      last_print = now;
    }
    if (g_stats_file && now - last_file >= 10000000000ull) {
      write_stats_file();
      last_file = now;
    }
    if (g_max_temp > 0 && now - last_therm >= 5000000000ull) {
      last_therm = now;
      char t[160];
      double c = -1000;
      rig_thermal("", t, sizeof(t), &c);
      int st = atomic_load(&g_thermal_state), next = st;
      if (c > -999) {
        if (c >= g_max_temp + 3) next = 2;
        else if (c >= g_max_temp) next = st > 1 ? 2 : 1;
        else if (c <= g_max_temp - 5) next = 0;
      }
      if (next != st) {
        atomic_store(&g_thermal_state, next);
        int act = next == 0 ? g_threads : next == 1 ? (g_threads + 1) / 2 : 1;
        atomic_store(&g_active_threads, act);
        outl(stdout, "thermal %.1f C (--max-temp %.0f): %d of %d threads active\n", c, g_max_temp, act, g_threads);
      }
    }
  }
  return NULL;
}

/* PR146 P1-2: what this process may still allocate. rig.c caps
 * MemAvailable by the cgroup headroom (v2 memory.max on this process's
 * path, or v1 memory.limit_in_bytes); this adds RLIMIT_AS (ulimit -v)
 * less the address space already mapped. -1 unknown. */
static long long usable_mem(char *src, size_t n) {
  long long best = g_rig.mem_avail > 0 ? g_rig.mem_avail : -1;
  if (g_rig.mem_limit >= 0 && g_rig.mem_limit <= best) snprintf(src, n, "%s", g_rig.mem_limit_src);
  else snprintf(src, n, "%s", best > 0 ? "MemAvailable" : "unknown");
#if !defined(_WIN32)
  struct rlimit rl;
  if (getrlimit(RLIMIT_AS, &rl) == 0 && rl.rlim_cur != RLIM_INFINITY) {
    long long mapped = 0;
    FILE *f = fopen("/proc/self/status", "r");
    if (f) {
      char line[256];
      while (fgets(line, sizeof(line), f)) {
        if (!strncmp(line, "VmSize:", 7)) mapped = atoll(line + 7) * 1024;
      }
      fclose(f);
    }
    long long head = (long long)rl.rlim_cur > mapped ? (long long)rl.rlim_cur - mapped : 0;
    if (best < 0 || head < best) {
      best = head;
      snprintf(src, n, "RLIMIT_AS %lld, mapped %lld", (long long)rl.rlim_cur, mapped);
    }
  }
#endif
  return best;
}

/* RandomX mode: full (jit-full) needs the 260 MiB dataset plus the 128 MiB
 * cache, twice while the next block's pair is built, and a scratchpad per
 * thread. Light (jit) needs the cache only. PR146 P1-2: an explicit
 * --backend jit-full no longer skips the check; when the usable memory is
 * known to be short it runs light jit and says so (an OOM kill under a
 * cgroup gives no allocation failure to fall back from). */
static const char *choose_backend(const char *asked, int explicit, int threads) {
  long long need = 2LL * (260 + 128) * (1 << 20) + (long long)threads * (2 << 20) + (64LL << 20);
  char src[200];
  long long usable = usable_mem(src, sizeof(src));
  char avail[256];
  if (usable >= 0) snprintf(avail, sizeof(avail), "%.2f GiB usable (%s)", (double)usable / (1 << 30), src);
  else snprintf(avail, sizeof(avail), "usable memory unknown");
  int full = !strcmp(asked, "jit-full");
  if (full && usable >= 0 && usable < need) {
    if (explicit) {
      fprintf(stderr, "ShearK-Miner: --backend jit-full needs about %.2f GiB; %s; using light jit\n", (double)need / (1 << 30), avail);
    }
    snprintf(g_mode_why, sizeof(g_mode_why), "light, jit (full mode needs about %.2f GiB; %s)", (double)need / (1 << 30), avail);
    return "jit";
  }
  if (explicit) {
    snprintf(g_mode_why, sizeof(g_mode_why), "%s (--backend given; %s)", asked, avail);
    return asked;
  }
  snprintf(g_mode_why, sizeof(g_mode_why), "full, jit-full (needs about %.2f GiB; %s)", (double)need / (1 << 30), avail);
  return asked;
}

/* --------------------------------------------------------------- tune */

typedef struct {
  int tid;
  atomic_int *go;
  atomic_int *stop;
  atomic_int *count_on;
  uint64_t count;
} TuneArg;

static void *tune_worker(void *arg) {
  TuneArg *t = (TuneArg *)arg;
#if defined(__linux__)
  if (g_cpu_map_n > 0) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET((unsigned)g_cpu_map[t->tid % g_cpu_map_n], &set);
    pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
  }
#endif
  unsigned char hdr[SHEAR_HEADER_LEN], out[32];
  memset(hdr, 0, sizeof(hdr));
  hdr[0] = 1;
  uint64_t n = 1000 + (uint64_t)t->tid;
  int primed = 0;
  while (!atomic_load(t->go)) usleep(1000);
  while (!atomic_load(t->stop)) {
    shear_set_nonce(hdr, n);
    n += 256;
    if (!primed) {
      primed = shear_hash_first(hdr) == 0;
      continue;
    }
    if (shear_hash_next(hdr, out) != 0) {
      primed = 0;
      continue;
    }
    if (atomic_load_explicit(t->count_on, memory_order_relaxed)) t->count++;
  }
  return NULL;
}

static double tune_point(int k, double warm, double secs) {
  pthread_t th[ST_MAXT];
  TuneArg args[ST_MAXT];
  atomic_int go = 0, stop = 0, on = 0;
  if (k > ST_MAXT) k = ST_MAXT;
  for (int i = 0; i < k; i++) {
    args[i].tid = i;
    args[i].go = &go;
    args[i].stop = &stop;
    args[i].count_on = &on;
    args[i].count = 0;
    pthread_create(&th[i], NULL, tune_worker, &args[i]);
  }
  atomic_store(&go, 1);
  sleep_ms((long)(warm * 1000));
  uint64_t t0 = st_now_ns();
  atomic_store(&on, 1);
  sleep_ms((long)(secs * 1000));
  atomic_store(&on, 0);
  uint64_t t1 = st_now_ns();
  atomic_store(&stop, 1);
  uint64_t total = 0;
  for (int i = 0; i < k; i++) {
    pthread_join(th[i], NULL);
    total += args[i].count;
  }
  return (double)total / ((double)(t1 - t0) / 1e9);
}

static void tune_cache_path(char *out, size_t n) {
  out[0] = 0;
#if defined(_WIN32)
  const char *ad = getenv("APPDATA");
  if (ad) snprintf(out, n, "%s\\ShearK\\tune.txt", ad);
#elif defined(__APPLE__)
  const char *h = getenv("HOME");
  if (h) snprintf(out, n, "%s/Library/Application Support/ShearK/tune.txt", h);
#else
  const char *x = getenv("XDG_CONFIG_HOME"), *h = getenv("HOME");
  if (x && *x) snprintf(out, n, "%s/sheark/tune.txt", x);
  else if (h) snprintf(out, n, "%s/.config/sheark/tune.txt", h);
#endif
}

static void mkdir_parent(const char *path) {
  char d[600];
  snprintf(d, sizeof(d), "%s", path);
  for (char *p = d + 1; *p; p++) {
    if (*p == '/' || *p == '\\') {
      char c = *p;
      *p = 0;
#if defined(_WIN32)
      CreateDirectoryA(d, NULL);
#else
      mkdir(d, 0700);
#endif
      *p = c;
    }
  }
}

/* 1-minute load average before tuning (Linux), or -1. */
static double load1(void) {
#if defined(__linux__)
  FILE *f = fopen("/proc/loadavg", "r");
  double v = -1;
  if (f) {
    if (fscanf(f, "%lf", &v) != 1) v = -1;
    fclose(f);
  }
  return v;
#else
  return -1;
#endif
}

/* Which thread count is fastest on this device, measured, cached per
 * device and re-measured when the hardware or limits change. */
static int choose_threads(int dflt, const char *dflt_why) {
  char key[512];
  snprintf(key, sizeof(key), "v=%s|backend=%s|cpu=%s|logical=%d|usable=%d|quota=%.2f|l3=%lld|leave=%d",
           SHEAR_VERSION, shear_hash_backend(), g_rig.cpu_model, g_rig.logical, g_rig.allowed, g_rig.quota_cpus,
           g_rig.l3_total, g_leave_free);
  char path[600];
  tune_cache_path(path, sizeof(path));
  if (g_tune_mode == 0 && path[0]) {
    FILE *f = fopen(path, "r");
    if (f) {
      char line[1100];
      while (fgets(line, sizeof(line), f)) {
        char *tab = strchr(line, '\t');
        if (!tab) continue;
        *tab = 0;
        if (strcmp(line, key) != 0) continue;
        int t = atoi(tab + 1);
        char *table = strchr(tab + 1, '\t');
        char *when = table ? strchr(table + 1, '\t') : NULL;
        long long at = when ? atoll(when + 1) : 0;
        /* A result older than 7 days is measured again. */
        if (at <= 0 || (long long)time(NULL) - at > 7LL * 86400) continue;
        if (when) *when = 0;
        if (t >= 1 && t <= dflt) {
          fclose(f);
          if (table) {
            table++;
            table[strcspn(table, "\n")] = 0;
            snprintf(g_tune_table, sizeof(g_tune_table), "%s (cached)", table);
          }
          snprintf(g_threads_why, sizeof(g_threads_why), "auto-tune result for this device, cached; ceiling %s", dflt_why);
          return t;
        }
      }
      fclose(f);
    }
  }
  int cand[5], nc = 0;
  int phys = g_rig.physical;
  /* P-cores only, on a P/E (hybrid, Apple Silicon) part. */
  if (g_rig.perf_logical > 0 && g_rig.perf_logical < dflt && g_rig.perf_logical != phys) cand[nc++] = g_rig.perf_logical;
  if (phys > 0 && phys < dflt) cand[nc++] = phys;
  if (dflt - 1 >= 1 && dflt - 1 != phys && dflt - 1 > (phys > 0 ? phys : 0)) cand[nc++] = dflt - 1;
  cand[nc++] = dflt;
  if (nc == 1) {
    /* One candidate (no SMT, no spare count to try): nothing to measure. */
    snprintf(g_threads_why, sizeof(g_threads_why), "%s (one candidate: nothing to tune)", dflt_why);
    return dflt;
  }
  double busy = load1();
  /* Busy: more than a quarter of the usable CPUs (at least one) already in use. */
  double busy_cap = g_rig.allowed > 0 && g_rig.allowed / 4.0 > 1.0 ? g_rig.allowed / 4.0 : 1.0;
  int busy_box = busy >= 0 && busy > busy_cap;
  outl(stdout, "auto-tune: measuring %d thread counts on this device (%s)\n", nc,
       busy_box ? "the CPU is busy, so the result is not cached" : path[0] ? path : "not cached");
  double best = -1;
  int best_k = dflt;
  double rates[5];
  for (int i = 0; i < nc; i++) {
    rates[i] = tune_point(cand[i], 2.0, 5.0);
    outl(stdout, "auto-tune: %d threads %.1f H/s\n", cand[i], rates[i]);
  }
  for (int i = 0; i < nc; i++) {
    /* Prefer fewer threads unless more are at least 1.5% faster. */
    if (best < 0 || rates[i] > best * 1.015) {
      best = rates[i];
      best_k = cand[i];
    }
  }
  g_tune_table[0] = 0;
  for (int i = 0; i < nc; i++) {
    char part[64];
    snprintf(part, sizeof(part), "%s%d thr %.1f H/s%s", i ? ", " : "", cand[i], rates[i], cand[i] == best_k ? " *" : "");
    if (strlen(g_tune_table) + strlen(part) < sizeof(g_tune_table)) strcat(g_tune_table, part);
  }
  snprintf(g_threads_why, sizeof(g_threads_why), "auto-tune measured fastest; ceiling %s", dflt_why);
  if (busy_box) {
    char tail[64];
    snprintf(tail, sizeof(tail), "; load %.2f at start: not cached", busy);
    if (strlen(g_threads_why) + strlen(tail) < sizeof(g_threads_why)) strcat(g_threads_why, tail);
  }
  if (path[0] && !busy_box) {
    mkdir_parent(path);
    /* Keep other devices' lines; replace this key's. */
    char *keep = NULL;
    size_t keep_n = 0;
    FILE *f = fopen(path, "r");
    if (f) {
      char line[1100];
      while (fgets(line, sizeof(line), f)) {
        if (!strncmp(line, key, strlen(key)) && line[strlen(key)] == '\t') continue;
        size_t l = strlen(line);
        char *nk = realloc(keep, keep_n + l + 1);
        if (!nk) break;
        keep = nk;
        memcpy(keep + keep_n, line, l + 1);
        keep_n += l;
      }
      fclose(f);
    }
    f = fopen(path, "w");
    if (f) {
      if (keep) fputs(keep, f);
      fprintf(f, "%s\t%d\t%s\t%lld\n", key, best_k, g_tune_table, (long long)time(NULL));
      fclose(f);
    }
    free(keep);
  }
  return best_k;
}

static int mine_once(void) {
  Conn mainc;
  memset(&mainc, 0, sizeof(mainc));
  mainc.fd = -1;
  clear_jobs();
  if (conn_open(&mainc, g_host, g_port) != 0) {
    fprintf(stderr, "connect failed %s:%d\n", g_host, g_port);
    return -1;
  }
  if (send_login(&mainc, g_login, g_threads) != 0) {
    fprintf(stderr, "pool login failed\n");
    conn_close(&mainc);
    return -1;
  }
  time_t started = time(NULL);
  g_t0 = started;
  time_t last_stats = started;
  for (;;) {
    fd_set rfds;
    FD_ZERO(&rfds);
    int maxfd = -1;
    if (mainc.fd >= 0) {
      FD_SET(mainc.fd, &rfds);
      if (mainc.fd > maxfd) maxfd = mainc.fd;
    }
    struct timeval tv;
    tv.tv_sec = 0;
    tv.tv_usec = 50000;
    if (maxfd >= 0) select(maxfd + 1, &rfds, NULL, NULL, &tv);
    else usleep(50000);

    if (mainc.fd >= 0) {
      int r = conn_read(&mainc);
      if (r < 0) {
        fprintf(stderr, "main socket closed\n");
        break;
      }
      if (r > 0) drain_lines(&mainc);
    }
    /* PR146: send what the current job allows before a switch, then after. */
    flush_shares(&mainc);
    promote_pending_job();
    flush_shares(&mainc);
    time_t now = time(NULL);
    if (now != last_stats) {
      (void)send_stats(&mainc, g_login, g_threads);
      last_stats = now;
      uint64_t h = atomic_load_explicit(&g_hashes, memory_order_relaxed);
      char rate[32];
      fmt_hashrate(hs10(), rate, sizeof(rate));
      char jobId[80] = "-";
      int sb = 0, bb = 0, height = g_height;
      pthread_mutex_lock(&g_job_mu);
      if (g_have_main && g_main_job.have) {
        snprintf(jobId, sizeof(jobId), "%s", g_main_job.jobId);
        sb = g_main_job.share_bits;
        bb = g_main_job.block_bits;
        if (g_main_job.height > 0) height = g_main_job.height;
      }
      pthread_mutex_unlock(&g_job_mu);
      uint64_t round = h >= g_round0 ? h - g_round0 : h;
      double elapsed = (double)(now - (g_t0 ? g_t0 : now));
      if (elapsed < 1) elapsed = 1;
      if (g_color) {
        printf("hashes=" C_DIM "%llu" C_RST " round=" C_CYN "%llu" C_RST " hashrate=" C_WHT "%s" C_RST
               " accepted=" C_GRN "%d" C_RST " rejected=" C_RED "%d" C_RST
               " submitted=" C_DIM "%llu" C_RST " blocks=" C_MAG "%d" C_RST " dropped=" C_YEL "%llu" C_RST
               " threads=%d cpuCores=%d cpuThreads=%d "
               "job=" C_CYN "%s" C_RST " height=" C_CYN "%d" C_RST " shareBits=%d blockBits=%d backend=%s user=%s pool=%s:%d elapsed=%.0fs inflight=%d\n",
               (unsigned long long)h, (unsigned long long)round, rate, g_accepted, g_rejected,
               (unsigned long long)g_submitted, g_blocks, (unsigned long long)g_dropped,
               g_threads, g_cpu_cores, g_cpu_threads, jobId, height, sb, bb,
               shear_hash_backend(), g_login, g_host, g_port, elapsed,
               atomic_load(&g_inflight));
        fflush(stdout);
      } else {
        printf("hashes=%llu round=%llu hashrate=%s accepted=%d rejected=%d submitted=%llu blocks=%d dropped=%llu "
               "threads=%d cpuCores=%d cpuThreads=%d job=%s height=%d shareBits=%d blockBits=%d "
               "backend=%s user=%s pool=%s:%d elapsed=%.0fs inflight=%d\n",
               (unsigned long long)h, (unsigned long long)round, rate, g_accepted, g_rejected,
               (unsigned long long)g_submitted, g_blocks, (unsigned long long)g_dropped,
               g_threads, g_cpu_cores, g_cpu_threads, jobId, height, sb, bb,
               shear_hash_backend(), g_login, g_host, g_port, elapsed,
               atomic_load(&g_inflight));
        fflush(stdout);
      }
    }
    if (g_stop) break;
  }
  conn_close(&mainc);
  return 0;
}

int main(int argc, char **argv) {
  /* Russell 28 Oct: phones are refused before anything else runs: no
   * RandomX, no dataset, no socket. Local signals only, no override. */
  {
    char why[512];
    if (rig_is_phone("", NULL, why, sizeof(why))) {
      fprintf(stderr, "%s\n(detected: %s)\n", PHONE_MSG, why);
      return SHEARK_EXIT_PHONE;
    }
  }
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--stamp") == 0 && i + 1 < argc) {
      int bits = atoi(argv[++i]);
      unsigned long long low = (i + 1 < argc) ? strtoull(argv[++i], NULL, 0) : 1ull;
      uint64_t stamped = shear_stamp_share_nonce(low, bits);
      printf("%llu %d\n", (unsigned long long)stamped, shear_credit_bits_of_nonce(stamped));
      return 0;
    }
  }
  int do_selftest = 0;
  int do_cfg = 0;
  int bench_secs = 0;
  const char *backend_arg = "jit-full";
  int backend_explicit = 0;
  int do_rig = 0;
  const char *verify_hex = NULL;
  int want_help = 0;
  device_inventory();
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--backend") == 0 && i + 1 < argc) {
      backend_arg = argv[++i];
      backend_explicit = 1;
    }
    if (strcmp(argv[i], "--share-keep-vector") == 0 && i + 5 < argc) {
      /* PR146 test vector: AGE_MS SAME_GEN SAME_PARENT SHARE_BITS LIVE_BITS -> keep|drop. */
      int k = share_keep(atof(argv[i + 1]), atoi(argv[i + 2]), atoi(argv[i + 3]), atoi(argv[i + 4]), atoi(argv[i + 5]));
      printf("%s\n", k ? "keep" : "drop");
      return 0;
    }
    if (strcmp(argv[i], "--blu-vector") == 0 && i + 3 < argc) {
      /* R28 known-answer check against crypto/blunote.js: one key from a given r, and its binding. */
      BluKey k;
      unsigned char r[32], hdr[SHEAR_HEADER_LEN];
      if (blu_init() != 0 || blu_set_address(argv[i + 1]) != 0) return 2;
      if (blu_hex_bytes(argv[i + 2], r, 32) != 0 || blu_hex_bytes(argv[i + 3], hdr, SHEAR_HEADER_LEN) != 0) return 2;
      if (blu_key_from_r(r, &k) != 0) return 3;
      char R[65], P[65];
      blu_hex32(k.R, R);
      blu_hex32(k.P, P);
      printf("R %s\nP %s\ntag %u\nbind %llu\n", R, P, (unsigned)k.tag, (unsigned long long)blu_bind(hdr, &k));
      return 0;
    }
    if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) want_help = 1;
  }
  if (want_help) {
    usage(stdout);
    return 0;
  }
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--selftest") == 0) do_selftest = 1;
    else if (strcmp(argv[i], "--print-config") == 0) do_cfg = 1;
    else if (strcmp(argv[i], "--verify") == 0 && i + 1 < argc) verify_hex = argv[++i];
    else if (strcmp(argv[i], "--bench") == 0) {
      bench_secs = 1;
      if (i + 1 < argc && argv[i + 1][0] >= '1' && argv[i + 1][0] <= '9')
        bench_secs = atoi(argv[++i]);
    } else if (strcmp(argv[i], "--pool") == 0 && i + 1 < argc) {
      const char *spec = argv[++i];
      if (strncmp(spec, "stratum+ssl://", 14) == 0) {
        g_tls = 1;
        g_cleartext_url = 0;
        spec += 14;
      } else if (strncmp(spec, "stratum+tcp://", 14) == 0) {
        g_tls = 0;
        g_cleartext_url = 1;
        spec += 14;
      } else {
        g_tls = 0;
        g_cleartext_url = 1;
      }
      snprintf(g_host_buf, sizeof(g_host_buf), "%s", spec);
      char *colon = strrchr(g_host_buf, ':');
      if (colon && colon != g_host_buf && *(colon + 1)) {
        *colon = 0;
        g_port = atoi(colon + 1);
      }
      g_host = g_host_buf;
    } else if (strcmp(argv[i], "--tls") == 0) {
      g_tls = 1;
      g_cleartext_url = 0;
    } else if (strcmp(argv[i], "--require-tls") == 0) {
      g_require_tls = 1;
      g_tls = 1;
    } else if (strcmp(argv[i], "--tls-ca") == 0 && i + 1 < argc) {
      g_tls_ca = argv[++i];
    } else if (strcmp(argv[i], "--tls-pin") == 0) {
      fprintf(stderr, "tls pin refused\n");
      return 2;
    } else if (strcmp(argv[i], "--user") == 0 && i + 1 < argc) {
      g_user = argv[++i];
    } else if (strcmp(argv[i], "--dest") == 0) {
      /* R28 option 2: nothing names a payee to a pool. */
      fprintf(stderr, "--dest is retired: R28 pays one-time keys of your --blu mining address, never a dest.\n");
      return 2;
    } else if (strcmp(argv[i], "--blu") == 0 && i + 1 < argc) {
      const char *addr = argv[++i];
      char hex[129];
      if (strncmp(addr, "shm1", 4) == 0) {
        if (shm1_to_hex(addr, hex) != 0) {
          fprintf(stderr, "--blu: the shm1 mining address has a bad checksum or length. Copy it again from the wallet.\n");
          return 2;
        }
      } else if (strcmp(SHEAR_MAGIC, "shear-v1") != 0 && strlen(addr) == 128 && all_hex(addr, 128)) {
        /* Raw hex has no checksum; accepted off mainnet only. */
        snprintf(hex, sizeof(hex), "%s", addr);
      } else {
        fprintf(stderr, "--blu: need the shm1… mining address from the wallet (\"This wallet mines\").\n");
        return 2;
      }
      if (blu_init() != 0 || blu_set_address(hex) != 0) {
        fprintf(stderr, "--blu: the mining address is not two valid ristretto255 points. Copy it again from the wallet.\n");
        return 2;
      }
      snprintf(g_blu_addr, sizeof(g_blu_addr), "%s", addr);
    } else if (strcmp(argv[i], "--solo") == 0) {
      g_solo = 1;
    } else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) {
      g_threads = atoi(argv[++i]);
      if (g_threads < 1) g_threads = 1;
    } else if (strcmp(argv[i], "--backend") == 0 && i + 1 < argc) {
      i++;
    } else if (strcmp(argv[i], "--notls") == 0) {
      g_cleartext_url = 1;
      g_tls = 0;
    } else if (strcmp(argv[i], "--rig") == 0) {
      do_rig = 1;
    } else if (strcmp(argv[i], "--redact") == 0) {
      g_redact = 1;
    } else if (strcmp(argv[i], "--verbose") == 0) {
      g_verbose = 1;
    } else if (strcmp(argv[i], "--stats-interval") == 0 && i + 1 < argc) {
      g_stats_interval = atoi(argv[++i]);
    } else if (strcmp(argv[i], "--stats-file") == 0 && i + 1 < argc) {
      g_stats_file = argv[++i];
    } else if (strcmp(argv[i], "--leave-free") == 0 && i + 1 < argc) {
      g_leave_free = atoi(argv[++i]);
      if (g_leave_free < 0) g_leave_free = 0;
    } else if (strcmp(argv[i], "--retune") == 0) {
      g_tune_mode = 1;
    } else if (strcmp(argv[i], "--no-tune") == 0) {
      g_tune_mode = -1;
    } else if (strcmp(argv[i], "--max-temp") == 0 && i + 1 < argc) {
      g_max_temp = atof(argv[++i]);
    }
  }
  if (g_threads > shear_hash_max_threads()) {
    fprintf(stderr, "ShearK-Miner: --threads %d is above the %d hashing threads this build supports; using %d\n",
            g_threads, shear_hash_max_threads(), shear_hash_max_threads());
    g_threads = shear_hash_max_threads();
  }
  g_threads_user = g_threads;
  rig_detect(&g_rig, "", NULL);
  /* Leave a CPU for the user's own work on a desktop or laptop. */
  if (g_leave_free < 0) {
    int desk = !strcmp(g_rig.device_type, "desktop") || !strcmp(g_rig.device_type, "laptop");
    g_leave_free = desk && g_rig.allowed >= 4 ? 1 : 0;
  }
  /* Flag order must not matter. Refuse before the dataset alloc so a bad URL
     does not spend seconds on jit-full. print-config exits before mining. */
  if (g_solo && !g_blu_addr[0]) {
    fprintf(stderr, "--solo needs --blu: a solo node pays its pot to a one-time key of that address\n");
    return 2;
  }
  if (!do_selftest && !verify_hex && g_require_tls && (g_cleartext_url || !g_tls)) {
    fprintf(stderr, "requireTls: refusing cleartext\n");
    return 2;
  }
  {
    char why[256];
    int ceiling = rig_default_threads(&g_rig, g_leave_free, why, sizeof(why));
    if (!do_selftest && !verify_hex) backend_arg = choose_backend(backend_arg, backend_explicit, g_threads ? g_threads : ceiling);
  }
  uint64_t init0 = st_now_ns();
  if (shear_hash_set_backend(backend_arg) != 0) {
    /* PR146: no backend at all; mining on would hash nothing (or zeros). */
    fprintf(stderr, "ShearK-Miner: no hash backend could be set up for --backend %s; exiting\n", backend_arg);
    return 1;
  }
  g_init_s = (double)(st_now_ns() - init0) / 1e9;
  if (do_rig) {
    char why[256];
    int t = g_threads > 0 ? g_threads : rig_default_threads(&g_rig, g_leave_free, why, sizeof(why));
    g_threads = t;
    if (g_threads_user > 0) snprintf(g_threads_why, sizeof(g_threads_why), "user override --threads %d", g_threads_user);
    else snprintf(g_threads_why, sizeof(g_threads_why), "%s (mining auto-tunes from here)", why);
    print_banner(stdout);
    return 0;
  }
  if (do_selftest) {
    char hex[65];
    unsigned char header[SHEAR_HEADER_LEN];
    unsigned char k[32];
    char khex[65];
    memset(header, 0, SHEAR_HEADER_LEN);
    header[0] = 1;
    int ok = shear_selftest(hex);
    shear_key(header, k);
    shear_hash_hex(k, khex);
    printf("selftest %s %s backend=%s\n", ok ? "ok" : "fail", hex, shear_hash_backend());
    printf("k %s\n", khex);
    printf("client=%s algorithm=%s personalisation=%s\n", SHEAR_CLIENT, SHEAR_ALGO, SHEAR_PERSONAL);
    if (strcmp(hex, "5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066") == 0) {
      ok = 0;
    }
    return ok ? 0 : 1;
  }
  if (verify_hex) {
    char digest[65];
    char khex[65];
    if (shear_verify_header_hex(verify_hex, digest, khex) != 0) {
      fprintf(stderr, "bad header hex\n");
      return 1;
    }
    printf("digest %s\nk %s\n", digest, khex);
    return 0;
  }
  if (g_threads < 1) {
    char why[256];
    g_threads = rig_default_threads(&g_rig, g_leave_free, why, sizeof(why));
    snprintf(g_threads_why, sizeof(g_threads_why), "%s", why);
  } else {
    snprintf(g_threads_why, sizeof(g_threads_why), "user override --threads %d", g_threads);
  }
  if (do_cfg) {
    if (g_user && build_login(g_user) > 0) init_note_commit();
    print_config();
    return 0;
  }
  if (bench_secs > 0) {
    unsigned char header[SHEAR_HEADER_LEN];
    unsigned char hash[32];
    memset(header, 0, SHEAR_HEADER_LEN);
    header[0] = 1;
    time_t t0 = time(NULL);
    uint64_t n = 0, h = 0;
    int primed = 0;
    while (time(NULL) - t0 < bench_secs) {
      shear_set_nonce(header, n);
      if (!primed) {
        if (shear_hash_first(header) != 0) {
          shear_hash(header, hash);
          h += 1;
          n += 1;
          continue;
        }
        primed = 1;
        n += 1;
        continue;
      }
      if (shear_hash_next(header, hash) != 0) {
        primed = 0;
        continue;
      }
      h += 1;
      n += 1;
    }
    double secs = (double)bench_secs;
    printf("bench hashes=%llu rate=%.0f R/s backend=%s (%.0fs)\n",
           (unsigned long long)h, (double)h / secs, shear_hash_backend(), secs);
    return 0;
  }
  if (g_require_tls && !g_tls) {
    fprintf(stderr, "requireTls: refusing cleartext\n");
    return 2;
  }
  if (!g_user) {
    usage(stderr);
    return 2;
  }
  {
    /* R28 option 2: the login is a worker name; the mining address stays here. */
    int lr = build_login(g_user);
    if (lr < 0) {
      fprintf(stderr, "--user is a worker name (e.g. rig1). An address there would be sent to the pool;\n");
      fprintf(stderr, "your wallet's mining address goes in --blu, and the pool never sees it.\n");
      return 2;
    }
    if (lr == 0) {
      fprintf(stderr, "--user: a worker name of 1-32 letters, digits, _ or - (e.g. rig1)\n");
      return 2;
    }
  }
  if (!blu_enabled()) {
    fprintf(stderr, "--blu YOUR_MINING_ADDRESS is required: without it a pool refuses every share (need_key).\n");
    fprintf(stderr, "Wallet: turn on \"This wallet mines\" and copy the Mining address (shm1...).\n");
    return 2;
  }
  init_note_commit();
#if defined(_WIN32)
  {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
      fprintf(stderr, "WSAStartup failed\n");
      return 3;
    }
  }
#endif
  signal(SIGINT, on_sig);
#ifndef _WIN32
  signal(SIGTERM, on_sig);
  signal(SIGPIPE, SIG_IGN);
#endif
  seed_origin();
  {
    const char *term = getenv("TERM");
    if (getenv("NO_COLOR") || (term && strcmp(term, "dumb") == 0)) g_color = 0;
  }
  setvbuf(stdout, NULL, _IOLBF, 0);
#if defined(_WIN32)
  {
    HANDLE hout = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD mode = 0;
    if (hout && GetConsoleMode(hout, &mode))
      SetConsoleMode(hout, mode | 0x0004);
  }
#endif
  /* Threads: the user's --threads, else the measured best for this device
   * (auto-tune, cached), never above what the CPUs, quota and L3 allow. */
  if (g_threads_user <= 0) {
    char why[256];
    int ceiling = rig_default_threads(&g_rig, g_leave_free, why, sizeof(why));
    if (g_tune_mode >= 0 && strcmp(shear_hash_backend(), "interpreter") != 0) g_threads = choose_threads(ceiling, why);
    else {
      g_threads = ceiling;
      snprintf(g_threads_why, sizeof(g_threads_why), "%s (%s)", why, g_tune_mode < 0 ? "--no-tune" : "interpreter: not tuned");
    }
  }
  if (g_threads > shear_hash_max_threads()) {
    outl(stdout, "threads capped at %d (one RandomX VM per thread)\n", shear_hash_max_threads());
    g_threads = shear_hash_max_threads();
  }
  atomic_store(&g_active_threads, g_threads);
  printf("ShearK-Miner %s (ShearHash-v3 light)\n", SHEAR_VERSION);
  print_banner(stdout);
  outl(stdout, "%s://%s:%d user=%s dest=%s threads=%d coin=SHE algo=%s backend=%s hugePages=%s\n",
         g_tls ? "stratum+ssl" : "stratum+tcp",
         pool_shown(), g_port, g_login, g_dest[0] ? g_dest : "-", g_threads, SHEAR_ALGO,
         shear_hash_backend(), shear_hash_huge_pages() ? "yes" : "no");
  printf("device cpuCores=%d cpuThreads=%d", g_cpu_cores, g_cpu_threads);
  if (g_cpu_map_n > 0) {
    printf(" pin=");
    int show = g_threads < g_cpu_map_n ? g_threads : g_cpu_map_n;
    if (show > 16) show = 16;
    for (int i = 0; i < show; i++) printf("%s%d", i ? "," : "", g_cpu_map[i]);
  }
  printf("\n");
  fflush(stdout);
  int n = g_threads;
  pthread_t *th = calloc((size_t)n, sizeof(pthread_t));
  if (!th) return 1;
  stats_init(n);
  {
    pthread_t st;
    if (pthread_create(&st, NULL, stats_thread, NULL) == 0) pthread_detach(st);
#if !defined(_WIN32)
    signal(SIGUSR1, on_usr1);
    if (isatty(0)) {
      pthread_t in;
      if (pthread_create(&in, NULL, stdin_thread, NULL) == 0) pthread_detach(in);
    }
#else
    if (_isatty(0)) {
      pthread_t in;
      if (pthread_create(&in, NULL, stdin_thread, NULL) == 0) pthread_detach(in);
    }
#endif
  }
  for (int i = 0; i < n; i++) {
    if (pthread_create(&th[i], NULL, hash_worker, (void *)(intptr_t)i) != 0) {
      fprintf(stderr, "thread start failed\n");
      g_stop = 1;
      n = i;
      break;
    }
  }
  while (!g_stop) {
    mine_once();
    if (g_stop) break;
    printf("reconnect in 2s %s %d\n", g_host, g_port);
    fflush(stdout);
#if defined(_WIN32)
    Sleep(2000);
#else
    sleep(2);
#endif
  }
  g_stop = 1;
  for (int i = 0; i < n; i++) pthread_join(th[i], NULL);
  free(th);
  return 0;
}
