#!/usr/bin/env bash
# R41 12 h soak of the final miner head (Russell's GO, 28 Oct). Run detached;
# the caller takes the lock (flock) around it.
#   soak12.sh LABEL SECS "MINER ARGS"
# Env: PRE (e.g. "taskset -c 0-1 nice -n 19"), WATCH=1 (pool host: a 10 min
# no-miner website baseline, then site_watch.sh during the soak).
# Pulls and builds src at claude/miner-opt, records the head, runs the vectors
# and golden corpus, then the loopback-pool soak with --restart, the miner's
# stats file every 10 s, and a copy of it every 15 min.
set -u
R=/root/claude-ci/r41
LABEL=$1; SECS=$2; MARGS=$3
OUT=$R/runs/$LABEL
mkdir -p "$OUT" "$R/tmp"
export TMPDIR=$R/tmp
[ -d $R/sodium ] && export SODIUM_PREFIX=$R/sodium/usr CPATH="$R/sodium/usr/include" LIBRARY_PATH="$R/sodium/usr/lib/x86_64-linux-gnu:$R/sodium/usr/lib"
read -r -a pre <<< "${PRE:-nice -n 19}"
log() { echo "[$(date -u +%FT%TZ)] $*" >> "$OUT/run.log"; }
: > "$OUT/run.log"
git -C $R/src fetch -q https://github.com/rgsneddon/shear-testnet.git claude/miner-opt && git -C $R/src checkout -q FETCH_HEAD
log "head $(git -C $R/src rev-parse HEAD) load=$(cut -d' ' -f1-3 /proc/loadavg)"
JOBS=2 "${pre[@]}" bash $R/src/sheark-miner/bench/build_tree.sh $R/src > "$OUT/build.log" 2>&1
log "build rc=$? $(tail -1 "$OUT/build.log")"
KIT=$R/kits/$LABEL; rm -rf "$KIT"; cp -r $R/src/sheark-miner/bench "$KIT"
( cd $R/src && "${pre[@]}" node --test --test-concurrency=1 sheark-miner/tests/test_golden_corpus_v12.js sheark-miner/tests/test_sha512_fips_v12.js \
    sheark-miner/tests/test_blunote_vectors_v12.js crypto/shear_hash.test.js sheark-miner/tests/test_miner.js ) > "$OUT/vectors.tap" 2>&1
log "vectors rc=$? $(grep -E '^# (pass|fail)' "$OUT/vectors.tap" | tr '\n' ' ')"
"${pre[@]}" $R/src/sheark-miner/ShearK-Miner --rig > "$OUT/rig.txt" 2>&1
if [ "${WATCH:-0}" = 1 ]; then
  log "website baseline (10 min, no miner)"
  bash "$KIT/site_watch.sh" "$OUT" baseline 600
  log "$(tail -1 "$OUT/watch.log")"
  setsid nohup bash "$KIT/site_watch.sh" "$OUT" watch "$OUT/miner.pid" > "$OUT/watch.out" 2>&1 < /dev/null &
fi
( while [ ! -f "$OUT/soak.done" ]; do sleep 900; [ -f "$OUT/stats.json" ] && { cat "$OUT/stats.json"; } >> "$OUT/stats-history.jsonl"; done ) &
log "soak start secs=$SECS miner args: $MARGS"
( cd $R/src && "${pre[@]}" node "$KIT/stratum_bench.mjs" --root $R/src --mode pool --miner $R/src/sheark-miner/ShearK-Miner \
    --secs "$SECS" --sample 300 --warm 120 --restart --pid-file "$OUT/miner.pid" \
    --miner-args "$MARGS --stats-file $OUT/stats.json --stats-interval 900" --out "$OUT/soak.json" ) > "$OUT/soak.log" 2>&1
log "soak rc=$? $(tail -1 "$OUT/soak.log" | cut -c1-1200)"
cp "$OUT/stats.json" "$OUT/stats-final.json" 2>/dev/null
touch "$OUT/soak.done"
log "done"
