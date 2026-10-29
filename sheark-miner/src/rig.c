/* R41 rig detection. See rig.h: local display only, never sent anywhere. */
#if defined(__linux__)
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#endif
#include "rig.h"

#include <ctype.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#else
#include <sys/utsname.h>
#include <unistd.h>
#endif
#if defined(__linux__)
#include <dirent.h>
#include <sched.h>
#endif
#if defined(__APPLE__)
#include <TargetConditionals.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#endif
#if defined(__x86_64__) || defined(__i386__)
#include <cpuid.h>
#define RIG_X86 1
#endif

#define UNK "unknown"

static void put(char *dst, size_t n, const char *s) { snprintf(dst, n, "%s", s ? s : UNK); }

static const char *real_env(const char *name) { return getenv(name); }

static void trim(char *s) {
  size_t n = strlen(s);
  while (n && (s[n - 1] == '\n' || s[n - 1] == '\r' || s[n - 1] == ' ' || s[n - 1] == '\t')) s[--n] = 0;
  size_t i = 0;
  while (s[i] == ' ' || s[i] == '\t') i++;
  if (i) memmove(s, s + i, strlen(s + i) + 1);
}

/* Read a whole small file under root into buf; 0 on success. */
static int rd(const char *root, const char *path, char *buf, size_t n) {
  char full[512];
  snprintf(full, sizeof(full), "%s%s", root ? root : "", path);
  FILE *f = fopen(full, "rb");
  if (!f) return -1;
  size_t got = fread(buf, 1, n - 1, f);
  fclose(f);
  buf[got] = 0;
  return 0;
}

static int rd_line(const char *root, const char *path, char *buf, size_t n) {
  if (rd(root, path, buf, n) != 0) return -1;
  char *nl = strchr(buf, '\n');
  if (nl) *nl = 0;
  trim(buf);
  return 0;
}

static int exists(const char *root, const char *path) {
  char full[512];
  snprintf(full, sizeof(full), "%s%s", root ? root : "", path);
  FILE *f = fopen(full, "rb");
  if (f) {
    fclose(f);
    return 1;
  }
#if !defined(_WIN32)
  return access(full, F_OK) == 0;
#else
  return GetFileAttributesA(full) != INVALID_FILE_ATTRIBUTES;
#endif
}

/* "0-3,8-11" -> 8 CPUs. */
static int list_count(const char *s) {
  int n = 0;
  const char *p = s;
  while (*p) {
    while (*p == ',' || *p == ' ' || *p == '\n') p++;
    if (!isdigit((unsigned char)*p)) break;
    long a = strtol(p, (char **)&p, 10), b = a;
    if (*p == '-') b = strtol(p + 1, (char **)&p, 10);
    if (b >= a) n += (int)(b - a + 1);
  }
  return n;
}

static void human_bytes(long long v, char *out, size_t n) {
  if (v < 0) {
    put(out, n, UNK);
    return;
  }
  if (v >= (1LL << 30) && v % (1LL << 30) == 0) snprintf(out, n, "%lld GiB", v >> 30);
  else if (v >= (1LL << 30)) snprintf(out, n, "%.1f GiB", (double)v / (1 << 30));
  else if (v >= (1LL << 20)) snprintf(out, n, "%.1f MiB", (double)v / (1 << 20));
  else snprintf(out, n, "%lld KiB", v >> 10);
}

/* Field "key : value" from /proc/cpuinfo text (first match). */
static int cpuinfo_field(const char *text, const char *key, char *out, size_t n) {
  size_t k = strlen(key);
  const char *p = text;
  while (p && *p) {
    if (strncmp(p, key, k) == 0) {
      /* The key exactly: only blanks may sit between it and the colon
       * ("model" must not match "model name"). */
      const char *c = p + k;
      while (*c == ' ' || *c == '\t') c++;
      const char *e = strchr(p, '\n');
      if (*c == ':' && (!e || c < e)) {
        size_t len = e ? (size_t)(e - c - 1) : strlen(c + 1);
        if (len >= n) len = n - 1;
        memcpy(out, c + 1, len);
        out[len] = 0;
        trim(out);
        return 0;
      }
    }
    p = strchr(p, '\n');
    if (p) p++;
  }
  return -1;
}

static int has_word(const char *list, const char *w) {
  size_t k = strlen(w);
  const char *p = list;
  while ((p = strstr(p, w))) {
    int left = p == list || p[-1] == ' ' || p[-1] == '\t';
    int right = p[k] == 0 || p[k] == ' ' || p[k] == '\n' || p[k] == '\t';
    if (left && right) return 1;
    p += k;
  }
  return 0;
}

/* ------------------------------------------------------------------ phones */

int rig_is_phone(const char *root, rig_env_fn env, char *why, size_t n) {
  char sig[512] = "";
  int hits = 0;
#define SIG(s) do { hits++; if (strlen(sig) + strlen(s) + 3 < sizeof(sig)) { if (sig[0]) strcat(sig, ", "); strcat(sig, s); } } while (0)
  if (!env) env = real_env;
#if defined(__ANDROID__)
  SIG("built for Android (Bionic libc)");
#endif
#if defined(__APPLE__) && defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE && !(defined(TARGET_OS_MACCATALYST) && TARGET_OS_MACCATALYST)
  SIG("built for iOS/iPadOS");
#endif
  const char *v;
  if ((v = env("ANDROID_ROOT")) && *v) SIG("ANDROID_ROOT is set");
  if ((v = env("ANDROID_DATA")) && *v) SIG("ANDROID_DATA is set");
  if ((v = env("TERMUX_VERSION")) && *v) SIG("TERMUX_VERSION is set");
  if ((v = env("PREFIX")) && strstr(v, "com.termux")) SIG("PREFIX is a Termux path");
  if (exists(root, "/system/build.prop")) SIG("/system/build.prop");
  if (exists(root, "/system/bin/getprop")) SIG("/system/bin/getprop");
  if (exists(root, "/data/data/com.termux")) SIG("/data/data/com.termux");
  if (exists(root, "/apex/com.android.runtime")) SIG("/apex/com.android.runtime");
  {
    char rel[256] = "";
#if !defined(_WIN32)
    if (root && *root) {
      rd_line(root, "/proc/sys/kernel/osrelease", rel, sizeof(rel));
    } else {
      struct utsname u;
      if (uname(&u) == 0) snprintf(rel, sizeof(rel), "%s", u.release);
    }
#endif
    if (strstr(rel, "-android")) SIG("an Android kernel (uname -r)");
  }
#undef SIG
  if (why) snprintf(why, n, "%s", hits ? sig : "no phone signal");
  return hits > 0;
}

/* -------------------------------------------------------------------- x86 */

#if defined(RIG_X86)
static void x86_cpu(RigInfo *r) {
  unsigned a, b, c, d;
  char vendor[13] = {0};
  if (__get_cpuid(0, &a, &b, &c, &d)) {
    memcpy(vendor, &b, 4);
    memcpy(vendor + 4, &d, 4);
    memcpy(vendor + 8, &c, 4);
    if (!strcmp(vendor, "AuthenticAMD")) put(r->cpu_vendor, sizeof(r->cpu_vendor), "AMD");
    else if (!strcmp(vendor, "GenuineIntel")) put(r->cpu_vendor, sizeof(r->cpu_vendor), "Intel");
    else put(r->cpu_vendor, sizeof(r->cpu_vendor), vendor);
  }
  unsigned maxext = 0;
  if (__get_cpuid(0x80000000, &maxext, &b, &c, &d) && maxext >= 0x80000004) {
    unsigned br[12];
    __get_cpuid(0x80000002, &br[0], &br[1], &br[2], &br[3]);
    __get_cpuid(0x80000003, &br[4], &br[5], &br[6], &br[7]);
    __get_cpuid(0x80000004, &br[8], &br[9], &br[10], &br[11]);
    char brand[49];
    memcpy(brand, br, 48);
    brand[48] = 0;
    trim(brand);
    if (brand[0]) put(r->cpu_model, sizeof(r->cpu_model), brand);
  }
  int virt = 0;
  if (__get_cpuid(1, &a, &b, &c, &d)) {
    unsigned fam = (a >> 8) & 0xf, model = (a >> 4) & 0xf, step = a & 0xf;
    if (fam == 0xf) fam += (a >> 20) & 0xff;
    if (fam == 6 || fam >= 0xf) model |= ((a >> 16) & 0xf) << 4;
    snprintf(r->cpu_fms, sizeof(r->cpu_fms), "family %u model %u stepping %u", fam, model, step);
    char f[RIG_S] = "";
    if (c & (1u << 25)) strcat(f, "aes ");
    if (c & (1u << 19)) strcat(f, "sse4.1 ");
    if (c & (1u << 28)) strcat(f, "avx ");
    unsigned a7 = 0, b7 = 0, c7 = 0, d7 = 0;
    if (__get_cpuid_count(7, 0, &a7, &b7, &c7, &d7)) {
      if (b7 & (1u << 5)) strcat(f, "avx2 ");
      if (b7 & (1u << 16)) strcat(f, "avx512f ");
      if (c7 & (1u << 9)) strcat(f, "vaes ");
      if (b7 & (1u << 29)) strcat(f, "sha ");
    }
    virt = (c >> 31) & 1;
    trim(f);
    put(r->features, sizeof(r->features), f[0] ? f : "none of aes/sse4.1/avx2/avx512f");
  }
  if (virt) {
    /* The hypervisor leaf sits above the basic range, so __get_cpuid
     * (which checks the basic maximum) refuses it; ask directly. */
    char hv[13] = {0};
    __cpuid(0x40000000, a, b, c, d);
    memcpy(hv, &b, 4);
    memcpy(hv + 4, &c, 4);
    memcpy(hv + 8, &d, 4);
    const char *name = hv;
    if (!strncmp(hv, "KVMKVMKVM", 9)) name = "KVM";
    else if (!strncmp(hv, "Microsoft Hv", 12)) name = "Hyper-V";
    else if (!strncmp(hv, "VMwareVMware", 12)) name = "VMware";
    else if (!strncmp(hv, "XenVMMXenVMM", 12)) name = "Xen";
    else if (!strncmp(hv, "TCGTCGTCGTCG", 12)) name = "QEMU (TCG)";
    else if (!strncmp(hv, "VBoxVBoxVBox", 12)) name = "VirtualBox";
    else if (!strncmp(hv, "Linux KVM Hv", 12)) name = "KVM (Hyper-V enlightened)";
    snprintf(r->virt, sizeof(r->virt), "%s", name[0] ? name : "hypervisor (unnamed)");
  } else {
    put(r->virt, sizeof(r->virt), "none");
  }
}
#endif

/* ------------------------------------------------------------------ Linux */

#if !defined(_WIN32) && !defined(__APPLE__)
static void linux_cpuinfo(RigInfo *r, const char *root, int from_fixture) {
  static char text[1 << 18];
  if (rd(root, "/proc/cpuinfo", text, sizeof(text)) != 0) return;
  char v[RIG_S];
  /* The fixture is the source of truth in tests; on a real host cpuid fills
   * x86 fields first and cpuinfo only what cpuid lacks. */
  if (from_fixture || !strcmp(r->cpu_model, UNK)) {
    if (cpuinfo_field(text, "model name", v, sizeof(v)) == 0) put(r->cpu_model, sizeof(r->cpu_model), v);
    else if (cpuinfo_field(text, "Model", v, sizeof(v)) == 0) put(r->cpu_model, sizeof(r->cpu_model), v);
    else if (cpuinfo_field(text, "Hardware", v, sizeof(v)) == 0) put(r->cpu_model, sizeof(r->cpu_model), v);
  }
  if (from_fixture || !strcmp(r->cpu_vendor, UNK)) {
    if (cpuinfo_field(text, "vendor_id", v, sizeof(v)) == 0) {
      put(r->cpu_vendor, sizeof(r->cpu_vendor), !strcmp(v, "AuthenticAMD") ? "AMD" : !strcmp(v, "GenuineIntel") ? "Intel" : v);
    } else if (cpuinfo_field(text, "CPU implementer", v, sizeof(v)) == 0) {
      long imp = strtol(v, NULL, 0);
      const char *name = imp == 0x41 ? "ARM" : imp == 0x61 ? "Apple" : imp == 0x51 ? "Qualcomm" : imp == 0x48 ? "HiSilicon"
                       : imp == 0x46 ? "Fujitsu" : imp == 0x43 ? "Cavium" : imp == 0x50 ? "Ampere (APM)" : imp == 0xc0 ? "Ampere" : NULL;
      if (name) put(r->cpu_vendor, sizeof(r->cpu_vendor), name);
      else snprintf(r->cpu_vendor, sizeof(r->cpu_vendor), "implementer %s", v);
    }
  }
  if (from_fixture || !strcmp(r->cpu_fms, UNK)) {
    char fam[32], mod[32], st[32];
    if (cpuinfo_field(text, "cpu family", fam, sizeof(fam)) == 0 && cpuinfo_field(text, "model", mod, sizeof(mod)) == 0
        && cpuinfo_field(text, "stepping", st, sizeof(st)) == 0) {
      snprintf(r->cpu_fms, sizeof(r->cpu_fms), "family %s model %s stepping %s", fam, mod, st);
    } else if (cpuinfo_field(text, "CPU part", mod, sizeof(mod)) == 0) {
      char var[32] = "?", rev[32] = "?";
      cpuinfo_field(text, "CPU variant", var, sizeof(var));
      cpuinfo_field(text, "CPU revision", rev, sizeof(rev));
      snprintf(r->cpu_fms, sizeof(r->cpu_fms), "part %s variant %s revision %s", mod, var, rev);
    }
  }
  if (from_fixture || !strcmp(r->features, UNK)) {
    char fl[4096];
    if (cpuinfo_field(text, "flags", fl, sizeof(fl)) == 0) {
      char f[RIG_S] = "";
      if (has_word(fl, "aes")) strcat(f, "aes ");
      if (has_word(fl, "sse4_1")) strcat(f, "sse4.1 ");
      if (has_word(fl, "avx")) strcat(f, "avx ");
      if (has_word(fl, "avx2")) strcat(f, "avx2 ");
      if (has_word(fl, "avx512f")) strcat(f, "avx512f ");
      if (has_word(fl, "vaes")) strcat(f, "vaes ");
      if (has_word(fl, "sha_ni")) strcat(f, "sha ");
      trim(f);
      put(r->features, sizeof(r->features), f[0] ? f : "none of aes/sse4.1/avx2/avx512f");
      if (from_fixture) put(r->virt, sizeof(r->virt), has_word(fl, "hypervisor") ? "hypervisor (cpuinfo flag)" : "none");
    } else if (cpuinfo_field(text, "Features", fl, sizeof(fl)) == 0) {
      char f[RIG_S] = "";
      if (has_word(fl, "asimd")) strcat(f, "neon ");
      if (has_word(fl, "aes")) strcat(f, "armv8-aes ");
      if (has_word(fl, "pmull")) strcat(f, "pmull ");
      if (has_word(fl, "sha2")) strcat(f, "sha2 ");
      if (has_word(fl, "sve")) strcat(f, "sve ");
      trim(f);
      put(r->features, sizeof(r->features), f[0] ? f : "no neon/armv8-aes");
    }
  }
}

static void linux_topology(RigInfo *r, const char *root, rig_env_fn env) {
  char buf[4096];
  (void)env;
  if (rd_line(root, "/sys/devices/system/cpu/online", buf, sizeof(buf)) == 0) r->logical = list_count(buf);
  /* Affinity: sched_getaffinity on a real host; a fixture records it. */
  if (root && *root) {
    if (rd_line(root, "/affinity", buf, sizeof(buf)) == 0) {
      r->allowed = list_count(buf);
      snprintf(r->affinity, sizeof(r->affinity), "%s (%d CPUs)", buf, r->allowed);
    }
  } else {
    cpu_set_t set;
    CPU_ZERO(&set);
    if (sched_getaffinity(0, sizeof(set), &set) == 0) {
      r->allowed = CPU_COUNT(&set);
      char list[RIG_S] = "";
      int start = -1;
      for (int i = 0; i <= CPU_SETSIZE; i++) {
        int on = i < CPU_SETSIZE && CPU_ISSET(i, &set);
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          char part[32];
          if (start == i - 1) snprintf(part, sizeof(part), "%s%d", list[0] ? "," : "", start);
          else snprintf(part, sizeof(part), "%s%d-%d", list[0] ? "," : "", start, i - 1);
          if (strlen(list) + strlen(part) + 1 < sizeof(list)) strcat(list, part);
          start = -1;
        }
      }
      snprintf(r->affinity, sizeof(r->affinity), "%s (%d CPUs)", list, r->allowed);
    }
  }
  /* Physical cores: unique (package, core) pairs. P/E: Intel hybrid lists
   * cpu_core/cpu_atom; ARM big.LITTLE shows as different cpu_capacity. */
  int pairs[1024][2], np = 0, smt_seen = 0;
  long cap_min = -1, cap_max = -1;
  int ncap_max = 0, ncap_min = 0;
  long l3_seen_sz[64];
  char l3_seen[64][64];
  int nl3 = 0;
  long long l3_total = 0;
  for (int cpu = 0; cpu < 1024; cpu++) {
    char p[160], v[160];
    snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/topology/core_id", cpu);
    if (rd_line(root, p, v, sizeof(v)) != 0) {
      /* An offline CPU keeps its directory but has no topology: skip it.
       * No directory: past the last CPU. */
      snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/online", cpu);
      if (exists(root, p)) continue;
      break;
    }
    int core = atoi(v), pkg = 0;
    snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/topology/physical_package_id", cpu);
    if (rd_line(root, p, v, sizeof(v)) == 0) pkg = atoi(v);
    int dup = 0;
    for (int i = 0; i < np; i++) if (pairs[i][0] == pkg && pairs[i][1] == core) dup = 1;
    if (!dup && np < 1024) {
      pairs[np][0] = pkg;
      pairs[np][1] = core;
      np++;
    }
    snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/topology/thread_siblings_list", cpu);
    if (rd_line(root, p, v, sizeof(v)) == 0 && list_count(v) > 1) smt_seen = 1;
    snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/cpu_capacity", cpu);
    if (rd_line(root, p, v, sizeof(v)) == 0) {
      long c = atol(v);
      if (cap_max < 0 || c > cap_max) { cap_max = c; ncap_max = 0; }
      if (cap_min < 0 || c < cap_min) { cap_min = c; ncap_min = 0; }
      if (c == cap_max) ncap_max++;
      if (c == cap_min) ncap_min++;
    }
    for (int idx = 0; idx < 8; idx++) {
      char lv[16], ty[32], sz[32];
      snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/cache/index%d/level", cpu, idx);
      if (rd_line(root, p, lv, sizeof(lv)) != 0) break;
      snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/cache/index%d/type", cpu, idx);
      if (rd_line(root, p, ty, sizeof(ty)) != 0) ty[0] = 0;
      snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/cache/index%d/size", cpu, idx);
      if (rd_line(root, p, sz, sizeof(sz)) != 0) continue;
      long kb = atol(sz);
      if (strchr(sz, 'M')) kb *= 1024;
      int level = atoi(lv);
      char hb[32];
      human_bytes((long long)kb * 1024, hb, sizeof(hb));
      if (level == 1 && !strcmp(ty, "Data") && !strcmp(r->l1d, UNK)) snprintf(r->l1d, sizeof(r->l1d), "%s/core", hb);
      if (level == 2 && !strcmp(r->l2, UNK)) snprintf(r->l2, sizeof(r->l2), "%s/core", hb);
      if (level == 3) {
        char list[64] = "";
        snprintf(p, sizeof(p), "/sys/devices/system/cpu/cpu%d/cache/index%d/shared_cpu_list", cpu, idx);
        rd_line(root, p, list, sizeof(list));
        int d = 0;
        for (int k = 0; k < nl3; k++) if (!strcmp(l3_seen[k], list)) d = 1;
        if (!d && nl3 < 64) {
          snprintf(l3_seen[nl3], sizeof(l3_seen[0]), "%s", list);
          l3_seen_sz[nl3] = kb;
          nl3++;
          l3_total += (long long)kb * 1024;
        }
      }
    }
  }
  if (np > 0) r->physical = np;
  if (nl3 > 0) {
    r->l3_domains = nl3;
    r->l3_total = l3_total;
    char hb[32];
    human_bytes((long long)l3_seen_sz[0] * 1024, hb, sizeof(hb));
    snprintf(r->l3, sizeof(r->l3), "%s x %d", hb, nl3);
  }
  if (rd_line(root, "/sys/devices/system/cpu/smt/active", buf, sizeof(buf)) == 0) {
    put(r->smt, sizeof(r->smt), atoi(buf) ? "on" : "off");
  } else if (np > 0 && r->logical > 0) {
    put(r->smt, sizeof(r->smt), (smt_seen || r->logical > np) ? "on" : "off");
  }
  char pc[256], ec[256];
  if (rd_line(root, "/sys/devices/cpu_core/cpus", pc, sizeof(pc)) == 0 && rd_line(root, "/sys/devices/cpu_atom/cpus", ec, sizeof(ec)) == 0) {
    snprintf(r->pe_split, sizeof(r->pe_split), "P %d / E %d logical", list_count(pc), list_count(ec));
    r->perf_logical = list_count(pc);
  } else if (cap_max > 0 && cap_min > 0 && cap_min < cap_max) {
    snprintf(r->pe_split, sizeof(r->pe_split), "big.LITTLE: %d big, %d little", ncap_max, ncap_min);
  } else if (np > 0) {
    put(r->pe_split, sizeof(r->pe_split), "none");
  }
  int nodes = 0;
  for (int i = 0; i < 256; i++) {
    char p[96];
    snprintf(p, sizeof(p), "/sys/devices/system/node/node%d/cpulist", i);
    if (exists(root, p)) nodes++;
  }
  if (nodes > 0) r->numa_nodes = nodes;
  else if (exists(root, "/sys/devices/system/cpu/online")) r->numa_nodes = 1;
}

static void linux_cgroup(RigInfo *r, const char *root) {
  char buf[256];
  /* v2: the tightest cpu.max on this process's cgroup path, walking up.
   * A fixture has no /proc/self/cgroup and gives the root file. */
  char self[1024] = "";
  if (rd(root, "/proc/self/cgroup", self, sizeof(self)) == 0) {
    char *p = strstr(self, "0::");
    if (p) {
      char path[512];
      snprintf(path, sizeof(path), "%s", p + 3);
      path[strcspn(path, "\n")] = 0;
      double best = 0;
      char bestline[96] = "";
      for (;;) {
        char f[600];
        snprintf(f, sizeof(f), "/sys/fs/cgroup%s/cpu.max", strcmp(path, "/") ? path : "");
        if (rd_line(root, f, buf, sizeof(buf)) == 0) {
          char q[64] = "", per[64] = "";
          sscanf(buf, "%63s %63s", q, per);
          if (strcmp(q, "max") && atol(per) > 0) {
            double c = (double)atol(q) / (double)atol(per);
            if (best == 0 || c < best) {
              best = c;
              snprintf(bestline, sizeof(bestline), "%s/%s at %s", q, per, path);
            }
          }
        }
        char *slash = strrchr(path, '/');
        if (!slash || slash == path) {
          if (!strcmp(path, "/")) break;
          snprintf(path, sizeof(path), "/");
          continue;
        }
        *slash = 0;
      }
      if (best > 0) {
        r->quota_cpus = best;
        snprintf(r->cgroup_quota, sizeof(r->cgroup_quota), "%.2f CPUs (cgroup v2 %s)", best, bestline);
      } else if (exists(root, "/sys/fs/cgroup/cgroup.controllers")) {
        r->quota_cpus = 0;
        put(r->cgroup_quota, sizeof(r->cgroup_quota), "none (cgroup v2, no cpu.max limit on this path)");
      }
      if (best > 0 || r->quota_cpus == 0) return;
    }
  }
  /* v2 at the root (fixtures, containers), then v1. "max" means no quota. */
  if (rd_line(root, "/sys/fs/cgroup/cpu.max", buf, sizeof(buf)) == 0) {
    char q[64] = "", per[64] = "";
    sscanf(buf, "%63s %63s", q, per);
    if (!strcmp(q, "max")) {
      r->quota_cpus = 0;
      put(r->cgroup_quota, sizeof(r->cgroup_quota), "none (cgroup v2 cpu.max = max)");
    } else if (atol(per) > 0) {
      r->quota_cpus = (double)atol(q) / (double)atol(per);
      snprintf(r->cgroup_quota, sizeof(r->cgroup_quota), "%.2f CPUs (cgroup v2 %s/%s)", r->quota_cpus, q, per);
    }
    return;
  }
  char per[64];
  if (rd_line(root, "/sys/fs/cgroup/cpu/cpu.cfs_quota_us", buf, sizeof(buf)) == 0
      && rd_line(root, "/sys/fs/cgroup/cpu/cpu.cfs_period_us", per, sizeof(per)) == 0) {
    long q = atol(buf), p = atol(per);
    if (q <= 0 || p <= 0) {
      r->quota_cpus = 0;
      put(r->cgroup_quota, sizeof(r->cgroup_quota), "none (cgroup v1 cfs_quota_us = -1)");
    } else {
      r->quota_cpus = (double)q / (double)p;
      snprintf(r->cgroup_quota, sizeof(r->cgroup_quota), "%.2f CPUs (cgroup v1 %ld/%ld)", r->quota_cpus, q, p);
    }
  }
}

/* PR146 P1-2: the memory a cgroup (v2 memory.max, tightest on this
 * process's path; or v1 memory.limit_in_bytes) still lets this process
 * use. A container with 300 MB on an 8 GB host showed 7+ GB MemAvailable
 * and jit-full was OOM-killed. -1 when there is no limit or none is known. */
static long long ll_or(const char *s, long long dflt) {
  if (!s || !s[0] || !strncmp(s, "max", 3)) return dflt;
  return atoll(s);
}

static void linux_memlimit(RigInfo *r, const char *root) {
  char buf[256], cur[256];
  r->mem_limit = -1;
  put(r->mem_limit_src, sizeof(r->mem_limit_src), "none");
  char self[1024] = "";
  char path[512] = "/";
  if (rd(root, "/proc/self/cgroup", self, sizeof(self)) == 0) {
    char *p = strstr(self, "0::");
    if (p) {
      snprintf(path, sizeof(path), "%s", p + 3);
      path[strcspn(path, "\n")] = 0;
      if (!path[0]) snprintf(path, sizeof(path), "/");
    }
  }
  int v2 = exists(root, "/sys/fs/cgroup/cgroup.controllers");
  for (;;) {
    char f[600], g[600];
    const char *pp = strcmp(path, "/") ? path : "";
    snprintf(f, sizeof(f), "/sys/fs/cgroup%s/memory.max", pp);
    snprintf(g, sizeof(g), "/sys/fs/cgroup%s/memory.current", pp);
    if (rd_line(root, f, buf, sizeof(buf)) == 0) {
      v2 = 1;
      long long mx = ll_or(buf, -1);
      if (mx > 0) {
        long long used = rd_line(root, g, cur, sizeof(cur)) == 0 ? atoll(cur) : 0;
        long long head = mx > used ? mx - used : 0;
        if (r->mem_limit < 0 || head < r->mem_limit) {
          r->mem_limit = head;
          snprintf(r->mem_limit_src, sizeof(r->mem_limit_src), "cgroup v2 memory.max %lld, current %lld at %s", mx, used, path);
        }
      }
    }
    if (!strcmp(path, "/")) break;
    char *slash = strrchr(path, '/');
    if (!slash || slash == path) snprintf(path, sizeof(path), "/");
    else *slash = 0;
  }
  if (!v2 && rd_line(root, "/sys/fs/cgroup/memory/memory.limit_in_bytes", buf, sizeof(buf)) == 0) {
    long long mx = atoll(buf);
    /* v1 "unlimited" is PAGE_COUNTER_MAX pages: 0x7ffffffffffff000 or so. */
    if (mx > 0 && mx < (1LL << 60)) {
      long long used = rd_line(root, "/sys/fs/cgroup/memory/memory.usage_in_bytes", cur, sizeof(cur)) == 0 ? atoll(cur) : 0;
      r->mem_limit = mx > used ? mx - used : 0;
      snprintf(r->mem_limit_src, sizeof(r->mem_limit_src), "cgroup v1 memory.limit_in_bytes %lld, usage %lld", mx, used);
    }
  }
  if (r->mem_limit >= 0 && (r->mem_avail < 0 || r->mem_limit < r->mem_avail)) r->mem_avail = r->mem_limit;
}

static void linux_misc(RigInfo *r, const char *root) {
  char buf[8192];
  if (rd(root, "/proc/meminfo", buf, sizeof(buf)) == 0) {
    char *p;
    long long ht = -1, hf = -1, hs = -1;
    if ((p = strstr(buf, "MemTotal:"))) r->mem_total = atoll(p + 9) * 1024;
    if ((p = strstr(buf, "MemAvailable:"))) r->mem_avail = atoll(p + 13) * 1024;
    if ((p = strstr(buf, "HugePages_Total:"))) ht = atoll(p + 16);
    if ((p = strstr(buf, "HugePages_Free:"))) hf = atoll(p + 15);
    if ((p = strstr(buf, "Hugepagesize:"))) hs = atoll(p + 13);
    char thp[128] = UNK;
    char t[128];
    if (rd_line(root, "/sys/kernel/mm/transparent_hugepage/enabled", t, sizeof(t)) == 0) {
      char *a = strchr(t, '['), *b = a ? strchr(a, ']') : NULL;
      if (a && b) snprintf(thp, sizeof(thp), "%.*s", (int)(b - a - 1), a + 1);
    }
    if (ht >= 0) {
      snprintf(r->hugepages, sizeof(r->hugepages), "hugetlb %lld x %lld KiB reserved, %lld free; THP %s", ht, hs, hf, thp);
    }
  }
  char gov[64];
  if (rd_line(root, "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", gov, sizeof(gov)) == 0) put(r->governor, sizeof(r->governor), gov);
  else put(r->governor, sizeof(r->governor), "unavailable (no cpufreq)");
  char base[32] = "", mx[32] = "", cur[32] = "";
  rd_line(root, "/sys/devices/system/cpu/cpu0/cpufreq/base_frequency", base, sizeof(base));
  rd_line(root, "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq", mx, sizeof(mx));
  rd_line(root, "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", cur, sizeof(cur));
  if (base[0] || mx[0] || cur[0]) {
    snprintf(r->freq, sizeof(r->freq), "base %s, max %s, now %s MHz",
             base[0] ? (snprintf(base, sizeof(base), "%ld", atol(base) / 1000), base) : UNK,
             mx[0] ? (snprintf(mx, sizeof(mx), "%ld", atol(mx) / 1000), mx) : UNK,
             cur[0] ? (snprintf(cur, sizeof(cur), "%ld", atol(cur) / 1000), cur) : UNK);
  } else {
    char text[1 << 16];
    char mhz[32];
    if (rd(root, "/proc/cpuinfo", text, sizeof(text)) == 0 && cpuinfo_field(text, "cpu MHz", mhz, sizeof(mhz)) == 0) {
      snprintf(r->freq, sizeof(r->freq), "base unknown, max unknown, now %.0f MHz (cpuinfo)", atof(mhz));
    }
  }
  put(r->msr, sizeof(r->msr), exists(root, "/dev/cpu/0/msr") ? "present (never written by ShearK)" : "absent (msr module not loaded)");
  /* Power: batteries and mains under power_supply. */
  int bats = 0, mains_online = -1, pct = -1;
  char status[32] = "";
#if !defined(_WIN32)
  char dpath[256];
  snprintf(dpath, sizeof(dpath), "%s/sys/class/power_supply", root ? root : "");
  DIR *d = opendir(dpath);
  if (d) {
    struct dirent *e;
    while ((e = readdir(d))) {
      if (e->d_name[0] == '.') continue;
      char p[300], ty[32];
      snprintf(p, sizeof(p), "/sys/class/power_supply/%s/type", e->d_name);
      if (rd_line(root, p, ty, sizeof(ty)) != 0) continue;
      if (!strcmp(ty, "Battery")) {
        bats++;
        snprintf(p, sizeof(p), "/sys/class/power_supply/%s/capacity", e->d_name);
        char c[16];
        if (rd_line(root, p, c, sizeof(c)) == 0) pct = atoi(c);
        snprintf(p, sizeof(p), "/sys/class/power_supply/%s/status", e->d_name);
        rd_line(root, p, status, sizeof(status));
      } else if (!strcmp(ty, "Mains")) {
        snprintf(p, sizeof(p), "/sys/class/power_supply/%s/online", e->d_name);
        char o[8];
        if (rd_line(root, p, o, sizeof(o)) == 0) mains_online = atoi(o);
      }
    }
    closedir(d);
  }
#endif
  if (bats) snprintf(r->power, sizeof(r->power), "battery %d%% %s, AC %s", pct, status[0] ? status : UNK,
                     mains_online < 0 ? UNK : mains_online ? "connected" : "disconnected");
  else if (mains_online >= 0) snprintf(r->power, sizeof(r->power), "AC %s, no battery", mains_online ? "connected" : "disconnected");
  else put(r->power, sizeof(r->power), "no battery reported (mains assumed)");
  /* Containers. */
  char cg[4096] = "";
  rd(root, "/proc/1/cgroup", cg, sizeof(cg));
  if (exists(root, "/.dockerenv") || strstr(cg, "docker")) put(r->container, sizeof(r->container), "docker");
  else if (exists(root, "/run/.containerenv")) put(r->container, sizeof(r->container), "podman");
  else if (strstr(cg, "kubepods")) put(r->container, sizeof(r->container), "kubernetes");
  else if (strstr(cg, "lxc") || exists(root, "/dev/lxd/sock")) put(r->container, sizeof(r->container), "lxc");
  else put(r->container, sizeof(r->container), "none");
  /* OS. */
  char osr[4096];
  if (rd(root, "/etc/os-release", osr, sizeof(osr)) == 0) {
    char *p = strstr(osr, "PRETTY_NAME=");
    if (p) {
      p += 12;
      if (*p == '"') p++;
      char *e = strpbrk(p, "\"\n");
      snprintf(r->os, sizeof(r->os), "%.*s", e ? (int)(e - p) : (int)strlen(p), p);
    }
  }
  char rel[RIG_S] = "", mach[32] = "";
  if (root && *root) {
    rd_line(root, "/proc/sys/kernel/osrelease", rel, sizeof(rel));
    rd_line(root, "/arch", mach, sizeof(mach));
  } else {
    struct utsname u;
    if (uname(&u) == 0) {
      snprintf(rel, sizeof(rel), "%s %s", u.sysname, u.release);
      snprintf(mach, sizeof(mach), "%s", u.machine);
      if (gethostname(r->hostname, sizeof(r->hostname)) != 0) put(r->hostname, sizeof(r->hostname), UNK);
    }
  }
  if (rel[0]) put(r->kernel, sizeof(r->kernel), rel);
  if (mach[0]) put(r->arch, sizeof(r->arch), mach);
  /* Device type, from the evidence in order of strength. */
  char chassis[16] = "", vendor[96] = "", product[96] = "";
  rd_line(root, "/sys/class/dmi/id/chassis_type", chassis, sizeof(chassis));
  rd_line(root, "/sys/class/dmi/id/sys_vendor", vendor, sizeof(vendor));
  rd_line(root, "/sys/class/dmi/id/product_name", product, sizeof(product));
  int ch = atoi(chassis);
  int vm_dmi = strstr(vendor, "QEMU") || strstr(vendor, "KVM") || strstr(vendor, "Hetzner") || strstr(vendor, "Amazon")
            || strstr(vendor, "Google") || strstr(vendor, "Microsoft") || strstr(vendor, "VMware") || strstr(vendor, "Xen")
            || strstr(product, "Virtual") || strstr(product, "KVM") || strstr(product, "HVM");
  if (strcmp(r->container, "none") && strcmp(r->container, UNK)) {
    put(r->device_type, sizeof(r->device_type), "container");
    snprintf(r->device_why, sizeof(r->device_why), "%s container", r->container);
  } else if (strcmp(r->virt, "none") && strcmp(r->virt, UNK)) {
    put(r->device_type, sizeof(r->device_type), "server/VM");
    snprintf(r->device_why, sizeof(r->device_why), "hypervisor %s%s%s", r->virt, vendor[0] ? ", DMI " : "", vendor);
  } else if (vm_dmi) {
    put(r->device_type, sizeof(r->device_type), "server/VM");
    snprintf(r->device_why, sizeof(r->device_why), "DMI vendor %s", vendor);
  } else if (bats || ch == 8 || ch == 9 || ch == 10 || ch == 14 || ch == 31 || ch == 32) {
    put(r->device_type, sizeof(r->device_type), "laptop");
    snprintf(r->device_why, sizeof(r->device_why), "%s%s", bats ? "battery present" : "DMI chassis type ", bats ? "" : chassis);
  } else if (ch == 3 || ch == 4 || ch == 5 || ch == 6 || ch == 7 || ch == 13 || ch == 15 || ch == 16 || ch == 35 || ch == 36) {
    put(r->device_type, sizeof(r->device_type), "desktop");
    snprintf(r->device_why, sizeof(r->device_why), "DMI chassis type %s", chassis);
  } else if (ch == 17 || ch == 23 || ch == 28 || ch == 29) {
    put(r->device_type, sizeof(r->device_type), "server/VM");
    snprintf(r->device_why, sizeof(r->device_why), "DMI chassis type %s (server)", chassis);
  } else {
    char model[RIG_S] = "";
    rd_line(root, "/proc/device-tree/model", model, sizeof(model));
    if (model[0]) {
      put(r->device_type, sizeof(r->device_type), "desktop");
      snprintf(r->device_why, sizeof(r->device_why), "board %s (no battery)", model);
    } else {
      put(r->device_type, sizeof(r->device_type), UNK);
      put(r->device_why, sizeof(r->device_why), "no DMI chassis, battery or board model");
    }
  }
}
#endif

/* ---------------------------------------------------------------- Windows */

#if defined(_WIN32)
typedef LONG (WINAPI *RtlGetVersionFn)(OSVERSIONINFOW *);

static void win_detect(RigInfo *r) {
  DWORD len = 0;
  GetLogicalProcessorInformationEx(RelationAll, NULL, &len);
  unsigned char *buf = len ? (unsigned char *)malloc(len) : NULL;
  if (buf && GetLogicalProcessorInformationEx(RelationAll, (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)buf, &len)) {
    int cores = 0, smt = 0, nodes = 0, l3n = 0, eff_max = 0, ncore_eff[16] = {0};
    long long l3tot = 0, l1 = -1, l2 = -1, l3 = -1;
    for (DWORD off = 0; off < len;) {
      PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX e = (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)(buf + off);
      if (e->Relationship == RelationProcessorCore) {
        cores++;
        if (e->Processor.Flags & LTP_PC_SMT) smt = 1;
        int ec = e->Processor.EfficiencyClass;
        if (ec > eff_max) eff_max = ec;
        if (ec < 16) ncore_eff[ec]++;
      } else if (e->Relationship == RelationNumaNode) {
        nodes++;
      } else if (e->Relationship == RelationCache) {
        CACHE_RELATIONSHIP *c = &e->Cache;
        if (c->Level == 1 && c->Type == CacheData && l1 < 0) l1 = c->CacheSize;
        if (c->Level == 2 && l2 < 0) l2 = c->CacheSize;
        if (c->Level == 3) {
          l3n++;
          l3tot += c->CacheSize;
          if (l3 < 0) l3 = c->CacheSize;
        }
      }
      off += e->Size;
    }
    r->physical = cores;
    put(r->smt, sizeof(r->smt), smt ? "on" : "off");
    r->numa_nodes = nodes ? nodes : -1;
    char hb[32];
    if (l1 >= 0) { human_bytes(l1, hb, sizeof(hb)); snprintf(r->l1d, sizeof(r->l1d), "%s/core", hb); }
    if (l2 >= 0) { human_bytes(l2, hb, sizeof(hb)); snprintf(r->l2, sizeof(r->l2), "%s/core", hb); }
    if (l3 >= 0) { human_bytes(l3, hb, sizeof(hb)); snprintf(r->l3, sizeof(r->l3), "%s x %d", hb, l3n); r->l3_domains = l3n; r->l3_total = l3tot; }
    if (eff_max > 0) {
      snprintf(r->pe_split, sizeof(r->pe_split), "P %d / E %d cores", ncore_eff[eff_max], cores - ncore_eff[eff_max]);
      r->perf_logical = ncore_eff[eff_max] * (smt ? 2 : 1);
    }
    else put(r->pe_split, sizeof(r->pe_split), "none");
  }
  free(buf);
  r->logical = (int)GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
  DWORD_PTR pm = 0, sm = 0;
  if (GetProcessAffinityMask(GetCurrentProcess(), &pm, &sm)) {
    int n = 0;
    for (DWORD_PTR m = pm; m; m >>= 1) n += (int)(m & 1);
    r->allowed = n;
    snprintf(r->affinity, sizeof(r->affinity), "mask 0x%llx (%d CPUs, this processor group)", (unsigned long long)pm, n);
  }
  put(r->cgroup_quota, sizeof(r->cgroup_quota), "unknown (job object limits not read)");
  MEMORYSTATUSEX ms;
  ms.dwLength = sizeof(ms);
  if (GlobalMemoryStatusEx(&ms)) {
    r->mem_total = (long long)ms.ullTotalPhys;
    r->mem_avail = (long long)ms.ullAvailPhys;
  }
  SIZE_T lp = GetLargePageMinimum();
  snprintf(r->hugepages, sizeof(r->hugepages), lp ? "large pages %llu KiB (need the Lock pages in memory right)" : "large pages unsupported", (unsigned long long)lp / 1024);
  OSVERSIONINFOW vi;
  memset(&vi, 0, sizeof(vi));
  vi.dwOSVersionInfoSize = sizeof(vi);
  RtlGetVersionFn rtl = (RtlGetVersionFn)(void *)GetProcAddress(GetModuleHandleA("ntdll.dll"), "RtlGetVersion");
  if (rtl && rtl(&vi) == 0) {
    snprintf(r->os, sizeof(r->os), "Windows %lu.%lu", vi.dwMajorVersion, vi.dwMinorVersion);
    snprintf(r->kernel, sizeof(r->kernel), "build %lu", vi.dwBuildNumber);
  }
  SYSTEM_INFO si;
  GetNativeSystemInfo(&si);
  put(r->arch, sizeof(r->arch), si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ? "x86_64"
                                : si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_ARM64 ? "arm64" : UNK);
  DWORD hn = sizeof(r->hostname);
  if (!GetComputerNameA(r->hostname, &hn)) put(r->hostname, sizeof(r->hostname), UNK);
  SYSTEM_POWER_STATUS ps;
  int battery = 0;
  if (GetSystemPowerStatus(&ps)) {
    battery = !(ps.BatteryFlag & 128) && ps.BatteryFlag != 255;
    if (battery) snprintf(r->power, sizeof(r->power), "battery %d%%, AC %s", ps.BatteryLifePercent == 255 ? -1 : ps.BatteryLifePercent,
                          ps.ACLineStatus == 1 ? "connected" : ps.ACLineStatus == 0 ? "disconnected" : UNK);
    else snprintf(r->power, sizeof(r->power), "no battery, AC %s", ps.ACLineStatus == 1 ? "connected" : UNK);
  }
  HKEY k;
  if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", 0, KEY_READ, &k) == ERROR_SUCCESS) {
    DWORD mhz = 0, sz = sizeof(mhz);
    if (RegQueryValueExA(k, "~MHz", NULL, NULL, (LPBYTE)&mhz, &sz) == ERROR_SUCCESS)
      snprintf(r->freq, sizeof(r->freq), "base %lu MHz (registry), max unknown, now unknown", mhz);
    RegCloseKey(k);
  }
  put(r->governor, sizeof(r->governor), "unknown (power plan not read)");
  put(r->msr, sizeof(r->msr), "unknown (Windows needs a signed driver; ShearK never loads one)");
  put(r->container, sizeof(r->container), UNK);
  if (strcmp(r->virt, "none") && strcmp(r->virt, UNK)) {
    put(r->device_type, sizeof(r->device_type), "server/VM");
    snprintf(r->device_why, sizeof(r->device_why), "hypervisor %s", r->virt);
  } else if (battery) {
    put(r->device_type, sizeof(r->device_type), "laptop");
    put(r->device_why, sizeof(r->device_why), "battery present");
  } else {
    put(r->device_type, sizeof(r->device_type), "desktop");
    put(r->device_why, sizeof(r->device_why), "no battery, no hypervisor");
  }
}
#endif

/* ------------------------------------------------------------------ macOS */

#if defined(__APPLE__)
static int sc_str(const char *name, char *out, size_t n) {
  size_t len = n;
  if (sysctlbyname(name, out, &len, NULL, 0) != 0) return -1;
  out[n - 1] = 0;
  return 0;
}
static long long sc_ll(const char *name) {
  long long v = 0;
  size_t len = sizeof(v);
  int32_t v32 = 0;
  if (sysctlbyname(name, &v, &len, NULL, 0) == 0) {
    if (len == 4) {
      memcpy(&v32, &v, 4);
      return v32;
    }
    return v;
  }
  return -1;
}
static void mac_detect(RigInfo *r) {
  char s[RIG_S];
  if (sc_str("machdep.cpu.brand_string", s, sizeof(s)) == 0) put(r->cpu_model, sizeof(r->cpu_model), s);
  if (!strcmp(r->cpu_vendor, UNK)) put(r->cpu_vendor, sizeof(r->cpu_vendor), strstr(r->cpu_model, "Apple") ? "Apple" : UNK);
  r->physical = (int)sc_ll("hw.physicalcpu");
  r->logical = (int)sc_ll("hw.logicalcpu");
  r->allowed = r->logical;
  snprintf(r->affinity, sizeof(r->affinity), "unknown (macOS has no hard affinity)");
  put(r->cgroup_quota, sizeof(r->cgroup_quota), "none (macOS)");
  put(r->smt, sizeof(r->smt), r->logical > r->physical && r->physical > 0 ? "on" : "off");
  long long p0 = sc_ll("hw.perflevel0.physicalcpu"), p1 = sc_ll("hw.perflevel1.physicalcpu");
  if (p0 > 0 && p1 > 0) {
    snprintf(r->pe_split, sizeof(r->pe_split), "P %lld / E %lld cores", p0, p1);
    r->perf_logical = (int)sc_ll("hw.perflevel0.logicalcpu");
  }
  else put(r->pe_split, sizeof(r->pe_split), "none");
  char hb[32];
  long long l1 = sc_ll("hw.l1dcachesize"), l2 = sc_ll("hw.l2cachesize"), l3 = sc_ll("hw.l3cachesize");
  if (l1 > 0) { human_bytes(l1, hb, sizeof(hb)); put(r->l1d, sizeof(r->l1d), hb); }
  if (l2 > 0) { human_bytes(l2, hb, sizeof(hb)); put(r->l2, sizeof(r->l2), hb); }
  if (l3 > 0) { human_bytes(l3, hb, sizeof(hb)); put(r->l3, sizeof(r->l3), hb); r->l3_total = l3; r->l3_domains = 1; }
  else put(r->l3, sizeof(r->l3), "none reported (Apple SLC)");
  r->numa_nodes = 1;
  r->mem_total = sc_ll("hw.memsize");
  if (sc_str("kern.osproductversion", s, sizeof(s)) == 0) snprintf(r->os, sizeof(r->os), "macOS %s", s);
  if (sc_str("kern.osrelease", s, sizeof(s)) == 0) snprintf(r->kernel, sizeof(r->kernel), "Darwin %s", s);
  struct utsname u;
  if (uname(&u) == 0) put(r->arch, sizeof(r->arch), u.machine);
  if (gethostname(r->hostname, sizeof(r->hostname)) != 0) put(r->hostname, sizeof(r->hostname), UNK);
  char f[RIG_S] = "";
  if (sc_ll("hw.optional.arm.FEAT_AES") == 1) strcat(f, "armv8-aes ");
  if (sc_ll("hw.optional.neon") == 1 || sc_ll("hw.optional.AdvSIMD") == 1) strcat(f, "neon ");
  if (f[0]) { trim(f); put(r->features, sizeof(r->features), f); }
  long long fq = sc_ll("hw.cpufrequency_max");
  if (fq > 0) snprintf(r->freq, sizeof(r->freq), "max %lld MHz", fq / 1000000);
  put(r->governor, sizeof(r->governor), "unknown (macOS)");
  put(r->msr, sizeof(r->msr), "absent (macOS)");
  put(r->hugepages, sizeof(r->hugepages), "superpages tried by RandomX; usually 4K on macOS");
  put(r->container, sizeof(r->container), "none");
  char model[64] = "";
  sc_str("hw.model", model, sizeof(model));
  if (strstr(model, "MacBook")) {
    put(r->device_type, sizeof(r->device_type), "laptop");
    snprintf(r->device_why, sizeof(r->device_why), "hw.model %s", model);
  } else if (model[0]) {
    put(r->device_type, sizeof(r->device_type), "desktop");
    snprintf(r->device_why, sizeof(r->device_why), "hw.model %s", model);
  }
  put(r->power, sizeof(r->power), "unavailable (IOKit not read)");
}
#endif

/* ----------------------------------------------------------------- public */

void rig_detect(RigInfo *r, const char *root, rig_env_fn env) {
  int fixture = root && *root;
  memset(r, 0, sizeof(*r));
  put(r->device_type, sizeof(r->device_type), UNK);
  put(r->device_why, sizeof(r->device_why), UNK);
  put(r->os, sizeof(r->os), UNK);
  put(r->kernel, sizeof(r->kernel), UNK);
  put(r->arch, sizeof(r->arch), UNK);
  put(r->virt, sizeof(r->virt), UNK);
  put(r->container, sizeof(r->container), UNK);
  put(r->cgroup_quota, sizeof(r->cgroup_quota), UNK);
  put(r->affinity, sizeof(r->affinity), UNK);
  put(r->power, sizeof(r->power), "unavailable");
  put(r->hostname, sizeof(r->hostname), UNK);
  put(r->cpu_vendor, sizeof(r->cpu_vendor), UNK);
  put(r->cpu_model, sizeof(r->cpu_model), UNK);
  put(r->cpu_fms, sizeof(r->cpu_fms), UNK);
  put(r->features, sizeof(r->features), UNK);
  put(r->smt, sizeof(r->smt), UNK);
  put(r->pe_split, sizeof(r->pe_split), UNK);
  put(r->l1d, sizeof(r->l1d), UNK);
  put(r->l2, sizeof(r->l2), UNK);
  put(r->l3, sizeof(r->l3), UNK);
  put(r->freq, sizeof(r->freq), UNK);
  put(r->governor, sizeof(r->governor), UNK);
  put(r->hugepages, sizeof(r->hugepages), UNK);
  put(r->msr, sizeof(r->msr), UNK);
  r->mem_limit = -1;
  put(r->mem_limit_src, sizeof(r->mem_limit_src), "none");
  r->logical = r->allowed = r->physical = r->l3_domains = r->numa_nodes = r->perf_logical = -1;
  r->mem_total = r->mem_avail = r->l3_total = -1;
  r->quota_cpus = -1;
#if defined(RIG_X86)
  if (!fixture) x86_cpu(r);
#endif
#if defined(_WIN32)
  (void)env;
  win_detect(r);
#elif defined(__APPLE__)
  (void)env;
  mac_detect(r);
#else
  linux_cpuinfo(r, root, fixture);
  linux_topology(r, root, env);
  linux_cgroup(r, root);
  linux_misc(r, root);
  linux_memlimit(r, root);
#endif
  char why[RIG_S];
  if (rig_is_phone(root, env, why, sizeof(why))) {
    put(r->device_type, sizeof(r->device_type), "phone");
    put(r->device_why, sizeof(r->device_why), why);
  }
  if (r->allowed < 0) r->allowed = r->logical;
}

int rig_default_threads(const RigInfo *r, int leave_free, char *why, size_t n) {
  int t = r->allowed > 0 ? r->allowed : (r->logical > 0 ? r->logical : 1);
  char w[RIG_S];
  snprintf(w, sizeof(w), "%d CPUs this process may use", t);
  if (r->quota_cpus > 0) {
    int q = (int)(r->quota_cpus + 0.999);
    if (q < 1) q = 1;
    if (q < t) {
      t = q;
      snprintf(w, sizeof(w), "cgroup quota %.2f CPUs", r->quota_cpus);
    }
  }
  if (r->l3_total > 0) {
    long long cap = r->l3_total / (2LL << 20);
    if (cap > 0 && cap < t) {
      t = (int)cap;
      snprintf(w, sizeof(w), "L3 holds %lld 2 MiB scratchpads", cap);
    }
  }
  if (leave_free > 0) {
    int before = t;
    t -= leave_free;
    if (t < 1) t = 1;
    char tail[64];
    snprintf(tail, sizeof(tail), ", minus %d left free", before - t);
    if (strlen(w) + strlen(tail) < sizeof(w)) strcat(w, tail);
  }
  if (why) snprintf(why, n, "%s", w);
  return t;
}

void rig_thermal(const char *root, char *out, size_t n, double *temp_c) {
  if (temp_c) *temp_c = -1000;
#if !defined(_WIN32) && !defined(__APPLE__)
  double best = -1000;
  char where[64] = "";
  for (int i = 0; i < 32; i++) {
    char p[96], name[64], v[32];
    snprintf(p, sizeof(p), "/sys/class/hwmon/hwmon%d/name", i);
    if (rd_line(root, p, name, sizeof(name)) != 0) continue;
    if (strcmp(name, "k10temp") && strcmp(name, "coretemp") && strcmp(name, "zenpower") && strcmp(name, "cpu_thermal")
        && strcmp(name, "soc_thermal") && strcmp(name, "cpu-thermal")) continue;
    snprintf(p, sizeof(p), "/sys/class/hwmon/hwmon%d/temp1_input", i);
    if (rd_line(root, p, v, sizeof(v)) == 0) {
      best = atof(v) / 1000.0;
      snprintf(where, sizeof(where), "%s", name);
      break;
    }
  }
  if (best < -999) {
    for (int i = 0; i < 32; i++) {
      char p[96], ty[64], v[32];
      snprintf(p, sizeof(p), "/sys/class/thermal/thermal_zone%d/type", i);
      if (rd_line(root, p, ty, sizeof(ty)) != 0) continue;
      if (!strstr(ty, "pkg") && !strstr(ty, "cpu") && !strstr(ty, "soc") && !strstr(ty, "x86")) continue;
      snprintf(p, sizeof(p), "/sys/class/thermal/thermal_zone%d/temp", i);
      if (rd_line(root, p, v, sizeof(v)) == 0) {
        best = atof(v) / 1000.0;
        snprintf(where, sizeof(where), "%s", ty);
        break;
      }
    }
  }
  char thr[32] = "";
  rd_line(root, "/sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count", thr, sizeof(thr));
  if (best > -999) {
    if (temp_c) *temp_c = best;
    snprintf(out, n, "%.1f C (%s), throttle events %s", best, where, thr[0] ? thr : "unavailable");
  } else {
    snprintf(out, n, "unavailable (no CPU sensor exposed%s)", thr[0] ? "" : ", no throttle counter");
  }
#else
  (void)root;
  snprintf(out, n, "unavailable");
#endif
}

void rig_redact(char *s, size_t cap, const RigInfo *r) {
  char tmp[4096];
  (void)cap;
  if (r && r->hostname[0] && strcmp(r->hostname, UNK)) {
    char *p;
    while ((p = strstr(s, r->hostname))) {
      size_t k = strlen(r->hostname);
      snprintf(tmp, sizeof(tmp), "%.*s<host>%s", (int)(p - s), s, p + k);
      snprintf(s, cap, "%s", tmp);
    }
  }
  const char *homes[] = {"/home/", "/Users/", "C:\\Users\\", "/root/"};
  for (size_t h = 0; h < sizeof(homes) / sizeof(homes[0]); h++) {
    char *p = s;
    while ((p = strstr(p, homes[h]))) {
      char *q = p + strlen(homes[h]);
      char *e = q;
      while (*e && *e != '/' && *e != '\\' && *e != ' ' && *e != '\n') e++;
      if (e == q || !strncmp(q, "<user>", 6)) {
        p = e;
        continue;
      }
      snprintf(tmp, sizeof(tmp), "%.*s<user>%s", (int)(q - s), s, e);
      snprintf(s, cap, "%s", tmp);
      p = s + (q - s) + 6;
    }
  }
  /* IPv4 dotted quads. */
  for (char *p = s; *p; p++) {
    if (!isdigit((unsigned char)*p) || (p > s && (isdigit((unsigned char)p[-1]) || p[-1] == '.'))) continue;
    int a, b, c, d, len = 0;
    if (sscanf(p, "%3d.%3d.%3d.%3d%n", &a, &b, &c, &d, &len) == 4 && len > 0 && a < 256 && b < 256 && c < 256 && d < 256) {
      snprintf(tmp, sizeof(tmp), "%.*s<ip>%s", (int)(p - s), s, p + len);
      snprintf(s, cap, "%s", tmp);
      p += 3;
    }
  }
}

void rig_print(FILE *out, const RigInfo *r, int redact) {
  char line[1024];
  char mt[32], ma[32];
  human_bytes(r->mem_total, mt, sizeof(mt));
  human_bytes(r->mem_avail, ma, sizeof(ma));
  /* Build each row, then redact it if asked. */
  struct { const char *k; char v[512]; } rows[24];
  int n = 0;
#define ROW(key, ...) do { rows[n].k = key; snprintf(rows[n].v, sizeof(rows[n].v), __VA_ARGS__); n++; } while (0)
  ROW("device", "%s (%s)", r->device_type, r->device_why);
  ROW("host", "%s", r->hostname);
  ROW("os", "%s, kernel %s, %s", r->os, r->kernel, r->arch);
  ROW("virtualisation", "%s; container %s", r->virt, r->container);
  ROW("cpu limits", "affinity %s; quota %s", r->affinity, r->cgroup_quota);
  ROW("power", "%s", r->power);
  if (!strncmp(r->cpu_model, r->cpu_vendor, strlen(r->cpu_vendor)) && strcmp(r->cpu_vendor, UNK)) ROW("cpu", "%s (%s)", r->cpu_model, r->cpu_fms);
  else ROW("cpu", "%s %s (%s)", r->cpu_vendor, r->cpu_model, r->cpu_fms);
  ROW("cpu features", "%s", r->features);
  {
    char ph[16], lg[16], al[16];
    snprintf(ph, sizeof(ph), r->physical > 0 ? "%d" : UNK, r->physical);
    snprintf(lg, sizeof(lg), r->logical > 0 ? "%d" : UNK, r->logical);
    snprintf(al, sizeof(al), r->allowed > 0 ? "%d" : UNK, r->allowed);
    ROW("cores", "%s physical, %s logical (%s usable), SMT %s, P/E %s", ph, lg, al, r->smt, r->pe_split);
  }
  {
    char nn[16], dd[16];
    snprintf(nn, sizeof(nn), r->numa_nodes > 0 ? "%d" : UNK, r->numa_nodes);
    snprintf(dd, sizeof(dd), r->l3_domains > 0 ? "%d" : UNK, r->l3_domains);
    ROW("caches", "L1d %s, L2 %s, L3 %s (%s L3 domains), NUMA nodes %s", r->l1d, r->l2, r->l3, dd, nn);
  }
  ROW("clocks", "%s; governor %s", r->freq, r->governor);
  ROW("memory", "%s total, %s available; %s", mt, ma, r->hugepages);
  ROW("msr", "%s", r->msr);
#undef ROW
  for (int i = 0; i < n; i++) {
    snprintf(line, sizeof(line), "  %-15s %s", rows[i].k, rows[i].v);
    if (redact) rig_redact(line, sizeof(line), r);
    fprintf(out, "%s\n", line);
  }
}
