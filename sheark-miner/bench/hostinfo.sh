#!/usr/bin/env bash
# R41: what this host gives a ShearK-Miner run. Read-only: it changes nothing.
set -u
echo "host $(hostname)"
echo "date $(date -u +%FT%TZ)"
. /etc/os-release 2>/dev/null && echo "os $PRETTY_NAME"
echo "kernel $(uname -r) $(uname -m)"
lscpu 2>/dev/null | grep -E '^(Model name|Thread\(s\) per core|Core\(s\) per socket|Socket\(s\)|CPU\(s\)|NUMA node\(s\)|L2 cache|L3 cache|CPU max MHz|Hypervisor vendor)' | sed 's/  */ /g'
flags=$(grep -m1 '^flags' /proc/cpuinfo | cut -d: -f2)
want="aes avx avx2 avx512f avx512vl vaes sse4_1 ssse3 bmi2 sha_ni pdpe1gb"
printf 'isa'
for f in $want; do case " $flags " in *" $f "*) printf ' %s' "$f";; esac; done
echo
echo "loadavg $(cut -d' ' -f1-3 /proc/loadavg)"
grep -E '^(MemTotal|MemAvailable|HugePages_Total|HugePages_Free|Hugepagesize|AnonHugePages):' /proc/meminfo | tr -s ' '
echo "thp_enabled $(cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null)"
echo "thp_defrag $(cat /sys/kernel/mm/transparent_hugepage/defrag 2>/dev/null)"
echo "hugepages_1g $(cat /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages 2>/dev/null || echo na)"
if ls /sys/class/powercap/intel-rapl:0/energy_uj >/dev/null 2>&1 && cat /sys/class/powercap/intel-rapl:0/energy_uj >/dev/null 2>&1; then
  echo "rapl readable"
else
  echo "rapl none"
fi
echo "msr $( [ -e /dev/cpu/0/msr ] && echo present || echo absent)"
echo "governor $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo na)"
echo "perf_paranoid $(cat /proc/sys/kernel/perf_event_paranoid 2>/dev/null)"
echo "gcc $(gcc -dumpfullversion 2>/dev/null)"
echo "node $(node -v 2>/dev/null)"
