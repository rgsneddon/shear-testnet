#!/usr/bin/env bash
# R41 final short run on one host (about 25 min). Run it under the host lock:
#   setsid nohup flock /root/claude-ci/run.lock bash final_host.sh LABEL > LOG 2>&1 < /dev/null &
# Pulls and builds src, then: the rig banner, the vectors and miner suite,
# an interleaved rxbench base vs src (1 round), the stratum pool run with the
# miner's own threads (auto-tune) and a stats file, solo, and the refusals.
# Env: CPUSET, NICE (pool host), SODIUM_PREFIX, STRAT_SECS (default 300).
set -u
R=/root/claude-ci/r41
LABEL=$1
OUT=$R/runs/$LABEL
mkdir -p "$OUT" "$R/tmp"
export TMPDIR=$R/tmp
[ -d $R/sodium ] && export SODIUM_PREFIX=$R/sodium/usr && export CPATH="$SODIUM_PREFIX/include" LIBRARY_PATH="$SODIUM_PREFIX/lib/x86_64-linux-gnu:$SODIUM_PREFIX/lib"
pre=(); [ -n "${CPUSET:-}" ] && pre+=(taskset -c "$CPUSET"); [ -n "${NICE:-}" ] && pre+=(nice -n "$NICE")
log() { echo "[$(date -u +%T)] $*" | tee -a "$OUT/run.log"; }
: > "$OUT/run.log"
# IDLE=1 (agent-box): wait up to 60 min for loadavg < 0.5 before measuring.
if [ "${IDLE:-0}" = 1 ]; then
  for i in $(seq 1 120); do awk -v l="$(cut -d' ' -f1 /proc/loadavg)" 'BEGIN{exit !(l<0.5)}' && break; sleep 30; done
fi
git -C $R/src fetch -q https://github.com/rgsneddon/shear-testnet.git claude/miner-opt && git -C $R/src checkout -q FETCH_HEAD
log "head $(git -C $R/src log --oneline -1) load=$(cut -d' ' -f1-3 /proc/loadavg)"
J=$(nproc); [ -n "${CPUSET:-}" ] && J=3
[ -x $R/base/sheark-miner/bench/rxbench ] || JOBS=$J "${pre[@]}" bash $R/src/sheark-miner/bench/build_tree.sh $R/base $R/src/sheark-miner/bench/rxbench.c > "$OUT/build-base.log" 2>&1
JOBS=$J "${pre[@]}" bash $R/src/sheark-miner/bench/build_tree.sh $R/src > "$OUT/build.log" 2>&1
log "build rc=$? $(tail -1 "$OUT/build.log")"
KIT=$R/kits/$LABEL; rm -rf "$KIT"; cp -r $R/src/sheark-miner/bench "$KIT"
M=$R/src/sheark-miner/ShearK-Miner
"${pre[@]}" "$M" --rig > "$OUT/rig.txt" 2>&1
log "rig rc=$?"
( cd $R/src && "${pre[@]}" node --test --test-concurrency=1 sheark-miner/tests/test_*.js crypto/shear_hash.test.js ) > "$OUT/suite.tap" 2>&1
log "suite rc=$? $(grep -E '^# (pass|fail)' "$OUT/suite.tap" | tr '\n' ' ')"
NP=$(nproc); [ -n "${CPUSET:-}" ] && NP=3
TL="1,$NP"; [ "$NP" -ge 8 ] && TL="1,4,8"
"${pre[@]}" bash "$KIT/ab.sh" "$OUT/ab.txt" "$TL" 1 20 base=$R/base src=$R/src > /dev/null 2>&1
grep '^mean' "$OUT/ab.txt" | tee -a "$OUT/run.log" > /dev/null
rm -f "$HOME/.config/sheark/tune.txt"
for mode in pool solo; do
  ( cd $R/src && "${pre[@]}" node "$KIT/stratum_bench.mjs" --root $R/src --mode $mode --miner "$M" --secs "${STRAT_SECS:-300}" --sample 30 --warm 45 \
      --miner-args "--stats-file $OUT/stats-$mode.json --stats-interval 60" --out "$OUT/stratum-$mode.json" ) > "$OUT/stratum-$mode.log" 2>&1
  log "stratum $mode rc=$? $(tail -1 "$OUT/stratum-$mode.log" | cut -c1-700)"
  log "stats $mode $(cat "$OUT/stats-$mode.json" 2>/dev/null | cut -c1-900)"
done
grep -h "auto-tune" "$OUT/stratum-pool.json" | head -0
( cd $R/src && "${pre[@]}" node "$KIT/stratum_bench.mjs" --root $R/src --mode refusals --miner "$M" --out "$OUT/refusals.json" ) > "$OUT/refusals.log" 2>&1
log "refusals rc=$? $(tail -1 "$OUT/refusals.log" | cut -c1-600)"
log "done load=$(cut -d' ' -f1-3 /proc/loadavg)"
