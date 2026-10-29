/* R41 detection test driver: runs rig.c against a recorded fixture tree.
 *   rig_main ROOT [ENVFILE]
 * ROOT holds the files a host exposes (proc/, sys/, etc/, plus affinity and
 * arch, which a live host gets from sched_getaffinity and uname). ENVFILE
 * has NAME=VALUE lines standing in for the process environment. Only this
 * test binary can point rig.c at a fixture; the miner always reads the
 * real system (src/sheark_miner.c passes root "" and env NULL). */
#include "rig.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char g_env[64][256];
static int g_nenv = 0;

static const char *fixture_env(const char *name) {
  size_t k = strlen(name);
  for (int i = 0; i < g_nenv; i++) {
    if (!strncmp(g_env[i], name, k) && g_env[i][k] == '=') return g_env[i] + k + 1;
  }
  return NULL;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: rig_main ROOT [ENVFILE]\n");
    return 2;
  }
  if (argc > 2) {
    FILE *f = fopen(argv[2], "r");
    if (f) {
      while (g_nenv < 64 && fgets(g_env[g_nenv], sizeof(g_env[0]), f)) {
        g_env[g_nenv][strcspn(g_env[g_nenv], "\r\n")] = 0;
        if (g_env[g_nenv][0] && g_env[g_nenv][0] != '#') g_nenv++;
      }
      fclose(f);
    }
  }
  char why[512];
  int phone = rig_is_phone(argv[1], fixture_env, why, sizeof(why));
  printf("phone=%d\nphone_why=%s\n", phone, why);
  RigInfo r;
  rig_detect(&r, argv[1], fixture_env);
  char tw[256];
  int t = rig_default_threads(&r, 0, tw, sizeof(tw));
  printf("device_type=%s\nos=%s\nkernel=%s\narch=%s\nvirt=%s\ncontainer=%s\ncgroup_quota=%s\naffinity=%s\n", r.device_type, r.os,
         r.kernel, r.arch, r.virt, r.container, r.cgroup_quota, r.affinity);
  printf("cpu_vendor=%s\ncpu_model=%s\ncpu_fms=%s\nfeatures=%s\nlogical=%d\nallowed=%d\nphysical=%d\nsmt=%s\npe_split=%s\n",
         r.cpu_vendor, r.cpu_model, r.cpu_fms, r.features, r.logical, r.allowed, r.physical, r.smt, r.pe_split);
  printf("l1d=%s\nl2=%s\nl3=%s\nl3_domains=%d\nnuma_nodes=%d\nmem_total=%lld\nmem_avail=%lld\nhugepages=%s\ngovernor=%s\n", r.l1d,
         r.l2, r.l3, r.l3_domains, r.numa_nodes, r.mem_total, r.mem_avail, r.hugepages, r.governor);
  printf("mem_limit=%lld (%s)\n", r.mem_limit, r.mem_limit_src);
  printf("power=%s\nmsr=%s\ndefault_threads=%d\ndefault_why=%s\n", r.power, r.msr, t, tw);
  char therm[160];
  rig_thermal(argv[1], therm, sizeof(therm), NULL);
  printf("thermal=%s\n", therm);
  return 0;
}
