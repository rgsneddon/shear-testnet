/* R41 rig detection: what this device is, shown to the user only.
 *
 * Privacy rule (Russell, 28 Oct): nothing here is ever sent to a pool, a
 * peer or any endpoint. It feeds the local banner, the local stats and the
 * default thread count. sheark-miner/tests/test_rig_privacy_v12.js captures
 * the miner's stratum traffic and fails if any of it appears there.
 *
 * Unknown values are the string "unknown" (or "unavailable" for live
 * sensors), never a guess. */
#ifndef SHEARK_RIG_H
#define SHEARK_RIG_H

#include <stdio.h>

/* Phones are refused (Russell, 28 Oct): mining overheats them and damages
 * the battery. No flag, env var or config bypasses it. Distinct exit code,
 * used for nothing else. */
#define SHEARK_EXIT_PHONE 86

#define RIG_S 160

typedef struct {
  char device_type[24];   /* desktop, laptop, server/VM, container, phone, unknown */
  char device_why[RIG_S];
  char os[RIG_S];
  char kernel[RIG_S];
  char arch[32];
  char virt[64];          /* hypervisor or "none" or "unknown" */
  char container[64];     /* docker, podman, lxc, kubernetes, "none", "unknown" */
  char cgroup_quota[96];  /* "none", "2.00 CPUs (200000/100000)", "unknown" */
  char affinity[RIG_S];   /* "0-7 (8 CPUs)" */
  char power[96];
  char hostname[96];
  char cpu_vendor[48];
  char cpu_model[RIG_S];
  char cpu_fms[64];       /* family/model/stepping, or ARM implementer/part */
  char features[RIG_S];
  int logical;            /* online logical CPUs, -1 unknown */
  int allowed;            /* CPUs this process may run on, -1 unknown */
  double quota_cpus;      /* cgroup quota in CPUs, 0 = none, -1 unknown */
  int physical;           /* physical cores, -1 unknown */
  char smt[16];           /* on, off, unknown */
  char pe_split[64];      /* "P 8 / E 16", "none", "unknown" */
  int perf_logical;       /* logical CPUs on performance cores when P/E is known, else -1 */
  char l1d[32], l2[32], l3[32];
  int l3_domains;         /* -1 unknown */
  long long l3_total;     /* bytes over all L3 domains, -1 unknown */
  int numa_nodes;         /* -1 unknown */
  char freq[96];          /* base / max / current MHz */
  char governor[48];
  long long mem_total;    /* bytes, -1 unknown */
  long long mem_avail;
  char hugepages[RIG_S];  /* hugetlb pool and THP mode */
  char msr[64];
} RigInfo;

/* Fixture hook for the detection tests (tests/rig_main.c): a root prefix
 * for every file read, and an env lookup. The miner itself always passes
 * root "" and env NULL (the real getenv); no option reaches these. */
typedef const char *(*rig_env_fn)(const char *name);

/* 1 if this is a phone (or tablet OS), with the signals that said so. */
int rig_is_phone(const char *root, rig_env_fn env, char *why, size_t n);
void rig_detect(RigInfo *r, const char *root, rig_env_fn env);
/* The banner. redact masks hostname, home paths and IPs. */
void rig_print(FILE *out, const RigInfo *r, int redact);
/* The default thread count and why, from what the device allows. */
int rig_default_threads(const RigInfo *r, int leave_free, char *why, size_t n);
/* Package temperature (C) and throttle state, or "unavailable". */
void rig_thermal(const char *root, char *out, size_t n, double *temp_c);
/* Mask hostname, /home/x, C:\Users\x and IPv4 addresses in place. */
void rig_redact(char *s, size_t cap, const RigInfo *r);

#endif
