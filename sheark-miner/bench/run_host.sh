#!/usr/bin/env bash
# R41: one measured run of a built tree on this host. Start it detached and
# under the host lock, e.g.
#   setsid nohup flock /root/claude-ci/run.lock bash run_host.sh LABEL TREE > LOG 2>&1 < /dev/null &
# Env:
#   OUT      results root (default /root/claude-ci/r41/runs)
#   THREADS  rxbench thread list (default 1,..,nproc)
#   MINER_THREADS  --threads for the stratum runs (default: the miner's own)
#   PHASES   any of: info vectors golden rx epochs light stratum refusals perf
#   CPUSET   taskset list (pool host: leave a core free)
#   NICE     nice level (pool host: 19)
#   IDLE     1: wait up to 60 min for loadavg < 0.5 first (agent-box)
#   SECS     rxbench seconds per point (default 30); STRAT_SECS (default 300)
# Measurement only: no system setting is read-write here.
set -u
LABEL=$1
TREE=$(cd "$2" && pwd)
OUT=${OUT:-/root/claude-ci/r41/runs}/$LABEL
mkdir -p "$OUT"
export TMPDIR=${TMPDIR:-/root/claude-ci/r41/tmp}
mkdir -p "$TMPDIR"
M=$TREE/sheark-miner
BENCH=$(cd "$(dirname "$0")" && pwd)
NP=$(nproc)
THREADS=${THREADS:-$(seq -s, 1 "$NP")}
PHASES=${PHASES:-info vectors golden rx epochs light stratum refusals}
SECS=${SECS:-30}
STRAT_SECS=${STRAT_SECS:-300}
pre=()
[ -n "${CPUSET:-}" ] && pre+=(taskset -c "$CPUSET")
[ -n "${NICE:-}" ] && pre+=(nice -n "$NICE")
has() { case " $PHASES " in *" $1 "*) return 0;; esac; return 1; }
log() { echo "[$(date -u +%T)] $*" | tee -a "$OUT/run.log"; }

if [ "${IDLE:-0}" = 1 ]; then
  for i in $(seq 1 120); do
    l=$(cut -d' ' -f1 /proc/loadavg)
    awk -v l="$l" 'BEGIN{exit !(l<0.5)}' && break
    sleep 30
  done
fi
log "start label=$LABEL tree=$TREE head=$(git -C "$TREE" rev-parse --short HEAD) load=$(cut -d' ' -f1-3 /proc/loadavg)"
has info && bash "$BENCH/hostinfo.sh" > "$OUT/hostinfo.txt" 2>&1

if has vectors; then
  log "vectors"
  gold=()
  [ -f "$TREE/sheark-miner/tests/test_golden_corpus_v12.js" ] && gold=(sheark-miner/tests/test_golden_corpus_v12.js)
  ( cd "$TREE" && "${pre[@]}" node --test --test-concurrency=1 \
      sheark-miner/tests/test_sha512_fips_v12.js sheark-miner/tests/test_blunote_vectors_v12.js \
      crypto/shear_hash.test.js sheark-miner/tests/test_miner.js "${gold[@]}" ) > "$OUT/vectors.tap" 2>&1
  log "vectors rc=$? $(grep -E '^# (pass|fail)' "$OUT/vectors.tap" | tr '\n' ' ')"
fi
if has suite; then
  log "miner suite"
  ( cd "$TREE" && "${pre[@]}" node --test --test-concurrency=1 sheark-miner/tests/test_*.js ) > "$OUT/suite.tap" 2>&1
  log "suite rc=$? $(grep -E '^# (pass|fail)' "$OUT/suite.tap" | tr '\n' ' ')"
fi
if has golden; then
  for b in interpreter jit jit-full; do
    "${pre[@]}" "$M/bench/rxbench" --backend $b --golden "$BENCH/golden_v12.txt" --threads 0 > "$OUT/golden-$b.txt" 2>&1
    log "golden $b rc=$? $(grep -E '^golden' "$OUT/golden-$b.txt")"
  done
fi
if has rx; then
  log "rx jit-full threads=$THREADS load=$(cut -d' ' -f1 /proc/loadavg)"
  "${pre[@]}" "$M/bench/rxbench" --backend jit-full --threads "$THREADS" --secs "$SECS" --warm 5 > "$OUT/rx-jit-full.txt" 2>&1
  log "rx rc=$? load=$(cut -d' ' -f1 /proc/loadavg)"
  grep -E '^(init|point)' "$OUT/rx-jit-full.txt" | tee -a "$OUT/run.log" > /dev/null
fi
if has pin; then
  for p in seq none; do
    "${pre[@]}" "$M/bench/rxbench" --backend jit-full --threads "$THREADS" --secs "$SECS" --warm 5 --pin $p > "$OUT/rx-pin-$p.txt" 2>&1
    grep -E '^point' "$OUT/rx-pin-$p.txt" >> "$OUT/run.log"
  done
fi
if has epochs; then
  for b in jit-full jit; do
    "${pre[@]}" "$M/bench/rxbench" --backend $b --epochs 5 --threads 0 > "$OUT/epochs-$b.txt" 2>&1
    log "epochs $b $(grep -E '^epochs' "$OUT/epochs-$b.txt")"
  done
fi
if has light; then
  "${pre[@]}" "$M/bench/rxbench" --backend jit --threads "1,$NP" --secs "$SECS" --warm 5 > "$OUT/rx-jit.txt" 2>&1
  grep -E '^point' "$OUT/rx-jit.txt" >> "$OUT/run.log"
fi
if has perf; then
  log "perf"
  perf record -F 499 -g -o "$OUT/perf.data" -- "$M/bench/rxbench" --backend jit-full --threads "$NP" --secs 20 --warm 3 > "$OUT/perf-run.txt" 2>&1
  perf report -i "$OUT/perf.data" --no-children --sort dso,sym --stdio 2>/dev/null | head -80 > "$OUT/perf-report.txt"
  rm -f "$OUT/perf.data"
fi
if has stratum; then
  mt=()
  [ -n "${MINER_THREADS:-}" ] && mt=(--threads "$MINER_THREADS")
  for mode in pool solo; do
    log "stratum $mode"
    ( cd "$TREE" && "${pre[@]}" node "$BENCH/stratum_bench.mjs" --mode $mode --miner "$M/ShearK-Miner" \
        --secs "$STRAT_SECS" --sample 30 "${mt[@]}" --out "$OUT/stratum-$mode.json" ) > "$OUT/stratum-$mode.log" 2>&1
    log "stratum $mode rc=$? $(tail -1 "$OUT/stratum-$mode.log" | cut -c1-600)"
  done
fi
if has refusals; then
  ( cd "$TREE" && "${pre[@]}" node "$BENCH/stratum_bench.mjs" --mode refusals --miner "$M/ShearK-Miner" --out "$OUT/refusals.json" ) > "$OUT/refusals.log" 2>&1
  log "refusals rc=$? $(tail -1 "$OUT/refusals.log" | cut -c1-600)"
fi
log "done load=$(cut -d' ' -f1-3 /proc/loadavg)"
