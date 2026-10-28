#!/usr/bin/env bash
# R41: interleaved A/B of rxbench builds on this host, so drift in the host's
# load hits every variant alike. Run it under the host lock.
#   ab.sh OUTFILE "THREADS" ROUNDS SECS NAME=TREE [NAME=TREE ...]
# Env: CPUSET, NICE, BACKEND (default jit-full), RXARGS (extra rxbench args).
set -u
OUTF=$1; THREADS=$2; ROUNDS=$3; SECS=$4; shift 4
pre=()
[ -n "${CPUSET:-}" ] && pre+=(taskset -c "$CPUSET")
[ -n "${NICE:-}" ] && pre+=(nice -n "$NICE")
: > "$OUTF"
for r in $(seq 1 "$ROUNDS"); do
  for nt in "$@"; do
    name=${nt%%=*}
    tree=${nt#*=}
    echo "# round=$r variant=$name load=$(cut -d' ' -f1 /proc/loadavg)" >> "$OUTF"
    "${pre[@]}" "$tree/sheark-miner/bench/rxbench" --backend "${BACKEND:-jit-full}" --threads "$THREADS" \
      --secs "$SECS" --warm 5 ${RXARGS:-} 2>/dev/null | sed "s/^/$name round=$r /" >> "$OUTF"
  done
done
# Per variant and thread count: mean H/s over rounds.
awk '/ point /{
  v=$1; t=""; h="";
  for(i=1;i<=NF;i++){ if($i ~ /^threads=/) t=substr($i,9); if($i ~ /^hs=/) h=substr($i,4) }
  k=v" threads="t; s[k]+=h; n[k]++; if(!(k in mn)||h<mn[k]) mn[k]=h; if(h>mx[k]) mx[k]=h
} END { for(k in s) printf "mean %s hs=%.1f n=%d min=%.1f max=%.1f\n", k, s[k]/n[k], n[k], mn[k], mx[k] }' "$OUTF" | sort >> "$OUTF"
grep '^mean' "$OUTF"
