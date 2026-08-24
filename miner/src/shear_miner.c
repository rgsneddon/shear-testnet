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
#define close_fd closesocket
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#define close_fd close
#endif

#define DEFAULT_HOST "pool.shear.digital"
#define DEFAULT_PORT 1111
#define MAX_THREADS 256
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
         "\"pool\":\"%s:%d\",\"headerBytes\":%d,\"magic\":\"shear-testnet-v1\"}\n",
         SHEAR_CLIENT, SHEAR_ALGO, SHEAR_VERSION, g_host, g_port, SHEAR_HEADER_LEN);
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

  unsigned char header[SHEAR_HEADER_LEN];
  unsigned char hash[32];
  memcpy(header, g_job.header, SHEAR_HEADER_LEN);
  for (uint64_t nonce = 0; nonce < 400000 && !g_stop; nonce++) {
    shear_set_nonce(header, nonce);
    shear_hash(header, hash);
    atomic_fetch_add(&g_hashes, 1);
    if (shear_meets_target(hash, g_job.share_bits)) {
      snprintf(line, sizeof(line),
               "{\"id\":2,\"method\":\"submit\",\"params\":{\"jobId\":\"%s\",\"nonce\":\"%llu\"}}\n",
               g_job.jobId, (unsigned long long)nonce);
      send(fd, line, strlen(line), 0);
      n = (int)recv(fd, buf, sizeof(buf) - 1, 0);
      if (n > 0) {
        buf[n] = 0;
        fputs(buf, stdout);
      }
      return 0;
    }
  }
  return 1;
}

int main(int argc, char **argv) {
  int do_selftest = 0;
  int do_cfg = 0;
  int do_mine = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--selftest") == 0) do_selftest = 1;
    else if (strcmp(argv[i], "--print-config") == 0) do_cfg = 1;
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
      if (g_threads > MAX_THREADS) g_threads = MAX_THREADS;
    } else if (strcmp(argv[i], "--notls") == 0) {
      /* plaintext stratum (local / testnet default path) */
    }
  }
  if (do_selftest) {
    char hex[65];
    int ok = shear_selftest(hex);
    printf("selftest %s %s\n", ok ? "ok" : "fail", hex);
    printf("client=%s algorithm=%s\n", SHEAR_CLIENT, SHEAR_ALGO);
    return ok ? 0 : 1;
  }
  if (do_cfg) {
    print_config();
    return 0;
  }
  if (!do_mine) {
    fprintf(stderr, "usage: shear-miner --selftest | --print-config | --pool host:port --user sdcard1...|she1... [--threads N] [--notls]\n");
    return 2;
  }
  /* she1 is a string prefix of rest-frame shear1 — reject shear1 first. */
  if (strncmp(g_user, "shear1", 6) == 0
      || (strncmp(g_user, "sdcard1", 7) != 0 && strncmp(g_user, "she1", 4) != 0)) {
    fprintf(stderr, "user dest must be sdcard1... or she1...\n");
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
  int fd = tcp_connect(g_host, g_port);
  if (fd < 0) {
    fprintf(stderr, "connect failed %s:%d\n", g_host, g_port);
    return 3;
  }
  int rc = mine_once(fd);
  close_fd(fd);
  return rc < 0 ? 4 : 0;
}
