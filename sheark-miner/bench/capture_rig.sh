#!/usr/bin/env bash
# R41: record the files rig.c reads, as a fixture for tests/test_rig_detect_v12.js.
#   capture_rig.sh OUTDIR
# Read-only. No host name is recorded: rig_main gets none from a fixture.
set -u
OUT=$1
mkdir -p "$OUT"
cp_one() { [ -r "$1" ] || return 0; mkdir -p "$OUT$(dirname "$1")"; cat "$1" > "$OUT$1" 2>/dev/null || rm -f "$OUT$1"; }
for f in /proc/cpuinfo /proc/meminfo /proc/sys/kernel/osrelease /proc/1/cgroup /etc/os-release \
         /sys/devices/system/cpu/online /sys/devices/system/cpu/smt/active \
         /sys/kernel/mm/transparent_hugepage/enabled /sys/fs/cgroup/cpu.max \
         /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu/cpu.cfs_period_us \
         /sys/class/dmi/id/chassis_type /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name \
         /sys/devices/cpu_core/cpus /sys/devices/cpu_atom/cpus /proc/device-tree/model \
         /sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count; do
  cp_one "$f"
done
for c in /sys/devices/system/cpu/cpu[0-9]*; do
  for f in topology/core_id topology/physical_package_id topology/thread_siblings_list online cpu_capacity \
           cpufreq/scaling_governor cpufreq/base_frequency cpufreq/cpuinfo_max_freq cpufreq/scaling_cur_freq; do
    cp_one "$c/$f"
  done
  for i in "$c"/cache/index*; do
    for f in level type size shared_cpu_list; do cp_one "$i/$f"; done
  done
done
for n in /sys/devices/system/node/node[0-9]*; do cp_one "$n/cpulist"; done
for p in /sys/class/power_supply/*; do for f in type capacity status online; do cp_one "$p/$f"; done; done
for h in /sys/class/hwmon/hwmon*; do cp_one "$h/name"; cp_one "$h/temp1_input"; done
for z in /sys/class/thermal/thermal_zone*; do cp_one "$z/type"; cp_one "$z/temp"; done
[ -e /dev/cpu/0/msr ] && { mkdir -p "$OUT/dev/cpu/0"; : > "$OUT/dev/cpu/0/msr"; }
[ -e /.dockerenv ] && : > "$OUT/.dockerenv"
taskset -pc $$ 2>/dev/null | sed 's/.*: //' > "$OUT/affinity"
uname -m > "$OUT/arch"
echo "captured $(find "$OUT" -type f | wc -l) files into $OUT"
