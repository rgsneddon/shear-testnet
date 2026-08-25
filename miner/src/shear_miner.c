/*
 * shear-miner — official SHE CPU miner. One login.
 * Hashes the 120-byte Shear header (ShearHash-v1).
 */
#if defined(__linux__)
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE
#endif
#endif
#include "shear_hash.h"
#include "sha256.h"

#include <ctype.h>
#include <errno.h>
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
#include <netdb.h>
#include <sys/socket.h>
#define close_fd close
#endif

#define DEFAULT_HOST "pool.shear.digital"
#define DEFAULT_PORT 1111
#define LINE_CAP 8192
#define HEX_CAP 256

static const char *g_user = NULL;
static char g_host_buf[256];
static const char *g_host = DEFAULT_HOST;
static int g_port = DEFAULT_PORT;
static int g_threads = 1;
static volatile int g_stop = 0;
static atomic_uint_fast64_t g_hashes;

typedef struct {
  int gen;
  int share_bits;
  int block_bits;
  char jobId[80];
  unsigned char header[SHEAR_HEADER_LEN];
  int have;
} JobSnap;

static pthread_mutex_t g_job_mu = PTHREAD_MUTEX_INITIALIZER;
static JobSnap g_job;

static void on_sig(int s) {
  (void)s;
  g_stop = 1;
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

static char *json_str(const char *json, const char *key, char *dst, size_t cap) {
  char pat[80];
  snprintf(pat, sizeof(pat), "\"%s\"", key);
  const char *p = strstr(json, pat);
  if (!p) return NULL;
  p = strchr(p + strlen(pat), ':');
  if (!p) return NULL;
  p++;
  while (*p && isspace((unsigned char)*p)) p++;
  if (*p == '"') {
    p++;
    size_t n = 0;
    while (*p && *p != '"' && n + 1 < cap) dst[n++] = *p++;
    dst[n] = 0;
    return dst;
  }
  size_t n = 0;
  while (*p && *p != ',' && *p != '}' && n + 1 < cap) dst[n++] = *p++;
  dst[n] = 0;
  return dst;
}

static int json_int(const char *json, const char *key, int fallback) {
  char buf[32];
  if (!json_str(json, key, buf, sizeof(buf))) return fallback;
  return atoi(buf);
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

static void print_config(void) {
  printf("{\"client\":\"%s\",\"algorithm\":\"%s\",\"version\":\"%s\","
         "\"clientLogin\":\"single\","
         "\"pool\":\"%s:%d\",\"headerBytes\":%d,\"magic\":\"shear-testnet-v1\","
         "\"threads\":%d,\"backend\":\"%s\"}\n",
         SHEAR_CLIENT, SHEAR_ALGO, SHEAR_VERSION, g_host, g_port, SHEAR_HEADER_LEN,
         g_threads, shear_hash_backend());
}

static int mine_once(int fd) {
  char line[LINE_CAP];
  snprintf(line, sizeof(line),
           "{\"id\":1,\"method\":\"login\",\"params\":{\"login\":\"%s\","
           "\"client\":\"%s\",\"version\":\"%s\",\"threads\":%d}}\n",
           g_user, SHEAR_CLIENT, SHEAR_VERSION, g_threads);
  if (send(fd, line, strlen(line), 0) <= 0) return -1;
  char buf[LINE_CAP];
  int n = (int)recv(fd, buf, sizeof(buf) - 1, 0);
  if (n <= 0) return -1;
  buf[n] = 0;
  char header_hex[HEX_CAP];
  char jobId[80];
  if (!json_str(buf, "header", header_hex, sizeof(header_hex))) return -2;
  json_str(buf, "jobId", jobId, sizeof(jobId));
  pthread_mutex_lock(&g_job_mu);
  if (parse_header_hex(header_hex, g_job.header) == 0) {
    snprintf(g_job.jobId, sizeof(g_job.jobId), "%s", jobId[0] ? jobId : "job");
    g_job.share_bits = json_int(buf, "shareBits", 8);
    g_job.block_bits = json_int(buf, "blockBits", json_int(buf, "bits", 16));
    g_job.gen++;
    g_job.have = 1;
  }
  pthread_mutex_unlock(&g_job_mu);

  unsigned char tmpl[SHEAR_HEADER_LEN];
  memcpy(tmpl, g_job.header, SHEAR_HEADER_LEN);
  int submitted = 0;
  for (uint64_t nonce = 0; nonce + (uint64_t)SHEAR_X8 <= 400000 && !g_stop;
       nonce += (uint64_t)SHEAR_X8) {
    unsigned char headers[SHEAR_X8][SHEAR_HEADER_LEN];
    unsigned char hashes[SHEAR_X8][32];
    for (int k = 0; k < SHEAR_X8; k++) {
      memcpy(headers[k], tmpl, SHEAR_HEADER_LEN);
      shear_set_nonce(headers[k], nonce + (uint64_t)k);
    }
    shear_hash_x8(headers, hashes);
    atomic_fetch_add(&g_hashes, (unsigned)SHEAR_X8);
    /* 1 hash = 1 tx: each meeting nonce is its own share. Never fold the batch. */
    for (int k = 0; k < SHEAR_X8; k++) {
      if (!shear_meets_target(hashes[k], g_job.share_bits)) continue;
      snprintf(line, sizeof(line),
               "{\"id\":2,\"method\":\"submit\",\"params\":{\"jobId\":\"%s\",\"nonce\":\"%llu\"}}\n",
               g_job.jobId, (unsigned long long)(nonce + (uint64_t)k));
      send(fd, line, strlen(line), 0);
      n = (int)recv(fd, buf, sizeof(buf) - 1, 0);
      if (n > 0) {
        buf[n] = 0;
        fputs(buf, stdout);
      }
      submitted++;
    }
  }
  return submitted > 0 ? 0 : 1;
}

int main(int argc, char **argv) {
  int do_selftest = 0;
  int do_cfg = 0;
  int do_mine = 0;
  int bench_secs = 0;
  const char *backend_arg = "auto";
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--backend") == 0 && i + 1 < argc) backend_arg = argv[++i];
  }
  if (sha256_select_backend(backend_arg) != 0 &&
      strcmp(backend_arg, "auto") != 0 && strcmp(backend_arg, "scalar") != 0 &&
      strcmp(backend_arg, "scalar-x8") != 0) {
    fprintf(stderr, "unknown or unavailable --backend %s; using %s\n", backend_arg,
            sha256_backend_name());
  }
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--selftest") == 0) do_selftest = 1;
    else if (strcmp(argv[i], "--print-config") == 0) do_cfg = 1;
    else if (strcmp(argv[i], "--bench") == 0) {
      bench_secs = 1;
      if (i + 1 < argc && argv[i + 1][0] >= '1' && argv[i + 1][0] <= '9')
        bench_secs = atoi(argv[++i]);
    }
    else if (strcmp(argv[i], "--pool") == 0 && i + 1 < argc) {
      snprintf(g_host_buf, sizeof(g_host_buf), "%s", argv[++i]);
      char *colon = strrchr(g_host_buf, ':');
      if (colon && colon != g_host_buf && *(colon + 1)) {
        *colon = 0;
        g_port = atoi(colon + 1);
      }
      g_host = g_host_buf;
    } else if (strcmp(argv[i], "--user") == 0 && i + 1 < argc) {
      g_user = argv[++i];
      do_mine = 1;
    } else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) {
      g_threads = atoi(argv[++i]);
      if (g_threads < 1) g_threads = 1;
    } else if (strcmp(argv[i], "--backend") == 0 && i + 1 < argc) {
      i++;
    } else if (strcmp(argv[i], "--notls") == 0) {
      /* plaintext stratum (local / testnet default path) */
    }
  }
  if (do_selftest) {
    char hex[65];
    int ok = shear_selftest(hex);
    printf("selftest %s %s backend=%s\n", ok ? "ok" : "fail", hex, shear_hash_backend());
    printf("client=%s algorithm=%s\n", SHEAR_CLIENT, SHEAR_ALGO);
    if (ok) printf("x8-independent ok\n");
    return ok ? 0 : 1;
  }
  if (do_cfg) {
    print_config();
    return 0;
  }
  if (bench_secs > 0) {
    unsigned char headers[SHEAR_X8][SHEAR_HEADER_LEN];
    unsigned char hashes[SHEAR_X8][32];
    for (int k = 0; k < SHEAR_X8; k++) {
      memset(headers[k], 0, SHEAR_HEADER_LEN);
      headers[k][0] = 1;
    }
    time_t t0 = time(NULL);
    uint64_t n = 0, h = 0;
    while (time(NULL) - t0 < bench_secs) {
      for (int k = 0; k < SHEAR_X8; k++) shear_set_nonce(headers[k], n + (uint64_t)k);
      shear_hash_x8(headers, hashes);
      h += (uint64_t)SHEAR_X8;
      n += (uint64_t)SHEAR_X8;
    }
    double secs = (double)bench_secs;
    printf("bench hashes=%llu rate=%.0f H/s backend=%s (%.0fs)\n",
           (unsigned long long)h, (double)h / secs, shear_hash_backend(), secs);
    return 0;
  }
  if (!do_mine) {
    fprintf(stderr, "usage: shear-miner --selftest | --print-config | --bench [SECONDS] | --pool host:port --user she1...|shp1... [--threads N] [--backend auto|scalar] [--notls]\n");
    return 2;
  }
  /* shear1 is rest-frame and is never a login. she1 silent ID and shp1 dests are. */
  if (strncmp(g_user, "shear1", 6) == 0
      || !((strncmp(g_user, "she1", 4) == 0) || (strncmp(g_user, "shp1", 4) == 0))) {
    fprintf(stderr, "user must be she1... or shp1... (not shear1)\n");
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
#endif
  setvbuf(stdout, NULL, _IOLBF, 0);
  printf("shear-miner %s pool=%s:%d threads=%d\n", SHEAR_VERSION, g_host, g_port, g_threads);
  fflush(stdout);
  while (!g_stop) {
    int fd = tcp_connect(g_host, g_port);
    if (fd < 0) {
      fprintf(stderr, "connect failed %s:%d\n", g_host, g_port);
      fflush(stderr);
#if defined(_WIN32)
      Sleep(2000);
#else
      sleep(2);
#endif
      continue;
    }
    printf("connected %s:%d\n", g_host, g_port);
    fflush(stdout);
    while (!g_stop) {
      uint64_t before = atomic_load(&g_hashes);
      int rc = mine_once(fd);
      uint64_t after = atomic_load(&g_hashes);
      printf("hashes=%llu delta=%llu\n",
             (unsigned long long)after, (unsigned long long)(after - before));
      fflush(stdout);
      if (rc < 0) break;
    }
    close_fd(fd);
  }
  return 0;
}
