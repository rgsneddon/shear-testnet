/*
 * ShearK-Miner — official SHE CPU miner for ShearHash-v2 (RandomX-lite).
 * Hashes the 128-byte Shear header. 1 hash = 1 tx.
 * Do not recut Shear-Miner 1.1 / 1.0.
 */
#if defined(__linux__)
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE
#endif
#endif
#include "shear_hash.h"

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#define close_fd closesocket
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/types.h>
#define close_fd close
#endif

#define DEFAULT_HOST "pool.shear.digital"
#define DEFAULT_PORT 1111
#define LINE_CAP 8192
#define HEX_CAP (SHEAR_HEADER_LEN * 2 + 16)
#define QCAP 8192
#define IN_FLIGHT_MAX 4096
#define DEFAULT_WORKER "worker"

static const char *g_user = NULL;
static char g_login[200];
static char g_host_buf[256];
static const char *g_host = DEFAULT_HOST;
static int g_port = DEFAULT_PORT;
static int g_threads = 1;
static int g_cpu_cores = 1;
static int g_cpu_threads = 1;
static volatile int g_stop = 0;
static atomic_uint_fast64_t g_hashes;
static uint64_t g_origin;

typedef struct {
  int gen;
  int share_bits;
  int block_bits;
  char jobId[80];
  unsigned char header[SHEAR_HEADER_LEN];
  int have;
} JobSnap;

static pthread_mutex_t g_job_mu = PTHREAD_MUTEX_INITIALIZER;
static JobSnap g_main_job;
static int g_have_main = 0;
static int g_job_gen = 0;

typedef struct {
  char jobId[80];
  uint64_t nonce;
} Share;

static pthread_mutex_t g_q_mu = PTHREAD_MUTEX_INITIALIZER;
static Share g_q[QCAP];
static int g_qhead = 0;
static int g_qtail = 0;
static uint64_t g_meets = 0;
static int g_accepted = 0;
static int g_rejected = 0;
static int g_blocks = 0;
static time_t g_rainbow_until = 0;
static int g_color = 1;

#define C_RST "\033[0m"
#define C_GRN "\033[32m"
#define C_YEL "\033[33m"
#define C_RED "\033[31m"

static const char *C_RAIN[] = {
  "\033[31m", "\033[33m", "\033[32m", "\033[36m", "\033[34m", "\033[35m",
};
static atomic_int g_inflight = 0;
static uint64_t g_dropped = 0;
static uint64_t g_submitted = 0;
static time_t g_t0;

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
          "ShearK-Miner %s (ShearHash-v2 light)\n"
          "Hashes the 128-byte Shear header. 1 hash = 1 tx.\n\n"
          "  --user she1…|ssa1….worker   required (not shear1)\n"
          "  --pool host:port            default %s:%d\n"
          "  --threads N                 no 256 farm cap\n"
          "  --backend auto|interpreter|jit\n"
          "  --notls                     plaintext (default on this pool)\n"
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

static int is_shear_login(const char *a, size_t n) {
  if (n < 8) return 0;
  if (n >= 6 && strncmp(a, "shear1", 6) == 0) return 0;
  if (!(strncmp(a, "she1", 4) == 0 || strncmp(a, "ssa1", 4) == 0)) return 0;
  return 1;
}

static int build_login(const char *user) {
  if (!user) return 0;
  const char *dot = strchr(user, '.');
  size_t alen = dot ? (size_t)(dot - user) : strlen(user);
  if (!is_shear_login(user, alen)) return 0;
  const char *worker = DEFAULT_WORKER;
  char wbuf[40];
  if (dot) {
    snprintf(wbuf, sizeof(wbuf), "%s", dot + 1);
    if (!valid_worker(wbuf)) return 0;
    worker = wbuf;
  }
  snprintf(g_login, sizeof(g_login), "%.*s.%s", (int)alen, user, worker);
  g_user = g_login;
  return 1;
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
#endif
  if (g_cpu_threads < 1) g_cpu_threads = 1;
  if (g_cpu_cores < 1) g_cpu_cores = 1;
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
  if (set_nonblock(c->fd) != 0) {
    conn_close(c);
    return -1;
  }
  return 0;
}

static int conn_write(Conn *c, const char *buf, int n) {
  if (!c || c->fd < 0) return -1;
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

static void identity_json(char *out, size_t cap, const char *login, int threads) {
  unsigned long long hashes = (unsigned long long)atomic_load_explicit(&g_hashes, memory_order_relaxed);
  double elapsed = (double)(time(NULL) - (g_t0 ? g_t0 : time(NULL)));
  if (elapsed < 1) elapsed = 1;
  double hs = (double)hashes / elapsed;
  snprintf(out, cap,
           "\"login\":\"%s\",\"threads\":%d,\"cpuCores\":%d,\"cpuThreads\":%d,"
           "\"name\":\"%s\",\"client\":\"%s\",\"version\":\"%s\",\"algorithm\":\"%s\","
           "\"hashes\":%llu,\"hashrate\":%.0f",
           login, threads, g_cpu_cores, g_cpu_threads,
           SHEAR_MINER_NAME, SHEAR_CLIENT, SHEAR_VERSION, SHEAR_ALGO,
           hashes, hs);
}

static int send_login(Conn *c, const char *login, int threads) {
  char ident[640], line[1200];
  identity_json(ident, sizeof(ident), login, threads);
  int n = snprintf(line, sizeof(line),
                   "{\"id\":1,\"method\":\"login\",\"params\":{%s},%s}\n", ident, ident);
  return conn_write(c, line, n) == 0 ? 0 : -1;
}

static int send_submit(Conn *c, const char *login, int threads, const char *jobId, uint64_t nonce) {
  char ident[640], line[1400];
  identity_json(ident, sizeof(ident), login, threads);
  int n = snprintf(line, sizeof(line),
                   "{\"id\":2,\"method\":\"submit\",\"params\":{%s,\"jobId\":\"%s\",\"nonce\":\"%llu\"},"
                   "%s,\"jobId\":\"%s\",\"nonce\":\"%llu\"}\n",
                   ident, jobId, (unsigned long long)nonce,
                   ident, jobId, (unsigned long long)nonce);
  return conn_write(c, line, n);
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
  int sb = 8, bb = 16, bits = 0;
  json_int(line, "shareBits", &sb);
  json_int(line, "blockBits", &bb);
  json_int(line, "bits", &bits);
  job.share_bits = sb > 0 ? sb : 8;
  job.block_bits = bb > 0 ? bb : (bits > 0 ? bits : 16);
  if (!job.jobId[0]) snprintf(job.jobId, sizeof(job.jobId), "job");
  pthread_mutex_lock(&g_job_mu);
  g_job_gen++;
  job.gen = g_job_gen;
  job.have = 1;
  g_main_job = job;
  g_have_main = 1;
  pthread_mutex_unlock(&g_job_mu);
  printf("job %s shareBits=%d blockBits=%d algo=%s workers=%d\n",
         job.jobId, job.share_bits, job.block_bits, SHEAR_ALGO, g_threads);
  fflush(stdout);
}

static void rainbow_puts(const char *s) {
  int i = 0;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p > 32) {
      fputs(C_RAIN[i % 6], stdout);
      i++;
    }
    fputc((int)*p, stdout);
  }
  fputs(C_RST, stdout);
  fflush(stdout);
}

static void apply_ack(const char *line) {
  int msgid = 0;
  json_int(line, "id", &msgid);
  char status[80] = "";
  json_token(line, "status", status, sizeof(status));
  char err[160] = "";
  json_token(line, "error", err, sizeof(err));
  char low[160];
  snprintf(low, sizeof(low), "%s", err[0] ? err : status);
  for (char *p = low; *p; p++) *p = (char)tolower((unsigned char)*p);
  int inflight = atomic_load(&g_inflight);
  /* Login replies with status=OK. Only a submit ACK (in-flight share) counts. */
  if (msgid == 1 && inflight <= 0) return;
  if (strstr(low, "ok") && !err[0]) {
    if (inflight > 0) {
      g_accepted++;
      atomic_fetch_sub(&g_inflight, 1);
      char blk[16] = "";
      json_token(line, "block", blk, sizeof(blk));
      if (strcmp(blk, "true") == 0 || strcmp(blk, "1") == 0) {
        g_blocks++;
        g_rainbow_until = time(NULL) + 8;
        if (g_color) rainbow_puts("blockfound\n");
        else {
          printf("blockfound\n");
          fflush(stdout);
        }
      }
    }
    return;
  }
  if (err[0] || strstr(low, "error") || strstr(low, "refus")) {
    if (inflight > 0) {
      g_rejected++;
      atomic_fetch_sub(&g_inflight, 1);
    }
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

static int enqueue_share(const char *jobId, uint64_t nonce) {
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
  uint64_t n = g_origin + (uint64_t)tid;
  JobSnap job;
  memset(&job, 0, sizeof(job));
  int last_gen = -1;
  while (!g_stop) {
    if (!copy_main_job(&job)) {
      usleep(10000);
      continue;
    }
    if (job.gen != last_gen) {
      last_gen = job.gen;
      n = g_origin + (uint64_t)tid;
    }
    unsigned char header[SHEAR_HEADER_LEN];
    unsigned char hash[32];
    memcpy(header, job.header, SHEAR_HEADER_LEN);
    shear_set_nonce(header, n);
    shear_hash(header, hash);
    atomic_fetch_add_explicit(&g_hashes, 1, memory_order_relaxed);
    JobSnap live;
    if (copy_main_job(&live) && live.gen == job.gen) {
      if (shear_meets_target(hash, job.share_bits)) {
        enqueue_share(job.jobId, n);
      }
    }
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
  pthread_mutex_unlock(&g_job_mu);
  pthread_mutex_lock(&g_q_mu);
  g_qhead = g_qtail = 0;
  pthread_mutex_unlock(&g_q_mu);
}

static void flush_shares(Conn *mainc) {
  Share s;
  while (dequeue_share(&s)) {
    int wr = send_submit(mainc, g_login, g_threads, s.jobId, s.nonce);
    if (wr == 1) {
      enqueue_front(&s);
      return;
    }
    if (wr == 0) {
      atomic_fetch_add_explicit(&g_inflight, 1, memory_order_relaxed);
      g_submitted++;
    }
  }
}

static void fmt_hashrate(double hs, char *buf, size_t n) {
  static const char *units[] = {
    "H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s", "ZH/s",
  };
  int i = 0;
  if (!(hs > 0.0)) {
    snprintf(buf, n, "0.0 H/s");
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
         "\"rxMode\":\"light\",\"rxCacheMiB\":%d,"
         "\"threads\":%d,\"backend\":\"%s\"}\n",
         SHEAR_MINER_NAME, SHEAR_CLIENT, SHEAR_ALGO, SHEAR_PERSONAL,
         SHEAR_VERSION, g_host, g_port, SHEAR_HEADER_LEN, SHEAR_MAGIC,
         SHEAR_RX_CACHE_MIB, g_threads, shear_hash_backend());
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
    flush_shares(&mainc);
    time_t now = time(NULL);
    if (now != last_stats) {
      last_stats = now;
      uint64_t h = atomic_load_explicit(&g_hashes, memory_order_relaxed);
      static uint64_t rate_h0;
      static time_t rate_t0;
      static double smooth_hs;
      if (rate_t0 == 0) {
        rate_h0 = h;
        rate_t0 = now;
      }
      double dt = (double)(now - rate_t0);
      if (dt < 1) dt = 1;
      double inst = (double)(h - rate_h0) / dt;
      if (smooth_hs <= 0) smooth_hs = inst;
      else {
        double alpha = 1.0 - exp(-dt / 3.0);
        smooth_hs += alpha * (inst - smooth_hs);
      }
      if (dt >= 2) {
        rate_h0 = h;
        rate_t0 = now;
      }
      char rate[32];
      fmt_hashrate(smooth_hs, rate, sizeof(rate));
      char jobId[80] = "-";
      int sb = 0, bb = 0;
      pthread_mutex_lock(&g_job_mu);
      if (g_have_main && g_main_job.have) {
        snprintf(jobId, sizeof(jobId), "%s", g_main_job.jobId);
        sb = g_main_job.share_bits;
        bb = g_main_job.block_bits;
      }
      pthread_mutex_unlock(&g_job_mu);
      if (g_color && time(NULL) < g_rainbow_until) {
        char linebuf[512];
        snprintf(linebuf, sizeof(linebuf),
                 "hashes=%llu hashrate=%s accepted=%d rejected=%d submitted=%llu threads=%d job=%s shareBits=%d blockBits=%d\n",
                 (unsigned long long)h, rate, g_accepted, g_rejected,
                 (unsigned long long)g_submitted, g_threads, jobId, sb, bb);
        rainbow_puts(linebuf);
      } else if (g_color) {
        printf("hashes=" C_GRN "%llu" C_RST " hashrate=" C_GRN "%s" C_RST
               " accepted=" C_YEL "%d" C_RST " rejected=" C_RED "%d" C_RST
               " submitted=%llu threads=%d job=%s shareBits=%d blockBits=%d\n",
               (unsigned long long)h, rate, g_accepted, g_rejected,
               (unsigned long long)g_submitted, g_threads, jobId, sb, bb);
        fflush(stdout);
      } else {
        printf("hashes=%llu hashrate=%s accepted=%d rejected=%d submitted=%llu threads=%d job=%s shareBits=%d blockBits=%d\n",
               (unsigned long long)h, rate, g_accepted, g_rejected,
               (unsigned long long)g_submitted, g_threads, jobId, sb, bb);
        fflush(stdout);
      }
    }
    if (g_stop) break;
  }
  conn_close(&mainc);
  return 0;
}

int main(int argc, char **argv) {
  int do_selftest = 0;
  int do_cfg = 0;
  int bench_secs = 0;
  const char *backend_arg = "auto";
  const char *verify_hex = NULL;
  device_inventory();
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--backend") == 0 && i + 1 < argc) backend_arg = argv[++i];
  }
  if (shear_hash_set_backend(backend_arg) != 0) {
    fprintf(stderr, "unknown or unavailable --backend %s; using %s\n", backend_arg,
            shear_hash_backend());
  }
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
      usage(stdout);
      return 0;
    }
    if (strcmp(argv[i], "--selftest") == 0) do_selftest = 1;
    else if (strcmp(argv[i], "--print-config") == 0) do_cfg = 1;
    else if (strcmp(argv[i], "--verify") == 0 && i + 1 < argc) verify_hex = argv[++i];
    else if (strcmp(argv[i], "--bench") == 0) {
      bench_secs = 1;
      if (i + 1 < argc && argv[i + 1][0] >= '1' && argv[i + 1][0] <= '9')
        bench_secs = atoi(argv[++i]);
    } else if (strcmp(argv[i], "--pool") == 0 && i + 1 < argc) {
      snprintf(g_host_buf, sizeof(g_host_buf), "%s", argv[++i]);
      char *colon = strrchr(g_host_buf, ':');
      if (colon && colon != g_host_buf && *(colon + 1)) {
        *colon = 0;
        g_port = atoi(colon + 1);
      }
      g_host = g_host_buf;
    } else if (strcmp(argv[i], "--user") == 0 && i + 1 < argc) {
      g_user = argv[++i];
    } else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) {
      g_threads = atoi(argv[++i]);
      if (g_threads < 1) g_threads = 1;
    } else if (strcmp(argv[i], "--backend") == 0 && i + 1 < argc) {
      i++;
    } else if (strcmp(argv[i], "--notls") == 0) {
      /* plaintext stratum (Shear pool default) */
    }
  }
  if (do_selftest) {
    char hex[65];
    unsigned char header[SHEAR_HEADER_LEN];
    unsigned char k[32];
    char khex[65];
    memset(header, 0, SHEAR_HEADER_LEN);
    header[0] = 1;
    shear_hash_set_backend("interpreter");
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
  if (do_cfg) {
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
    while (time(NULL) - t0 < bench_secs) {
      shear_set_nonce(header, n);
      shear_hash(header, hash);
      h += 1;
      n += 1;
    }
    double secs = (double)bench_secs;
    printf("bench hashes=%llu rate=%.0f H/s backend=%s (%.0fs)\n",
           (unsigned long long)h, (double)h / secs, shear_hash_backend(), secs);
    return 0;
  }
  if (!g_user) {
    usage(stderr);
    return 2;
  }
  if (!build_login(g_user)) {
    fprintf(stderr, "user must be she1... or ssa1... (not shear1)\n");
    return 2;
  }
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
  printf("ShearK-Miner %s (ShearHash-v2 light)\n", SHEAR_VERSION);
  printf("tcp://%s:%d user=%s threads=%d coin=SHE algo=%s\n",
         g_host, g_port, g_login, g_threads, SHEAR_ALGO);
  printf("device cpuCores=%d cpuThreads=%d\n", g_cpu_cores, g_cpu_threads);
  fflush(stdout);
  int n = g_threads;
  pthread_t *th = calloc((size_t)n, sizeof(pthread_t));
  if (!th) return 1;
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
