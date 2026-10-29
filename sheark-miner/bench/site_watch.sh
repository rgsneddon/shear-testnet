#!/usr/bin/env bash
# R41 soak watchdog for the pool host (Russell: the website must stay
# responsive). Test process only: it curls, measures and, if needed, narrows
# the miner's CPU affinity or stops the miner. No systemctl, no nginx change.
#   site_watch.sh OUTDIR baseline SECS        a no-miner baseline
#   site_watch.sh OUTDIR watch MINER_PID_FILE  during the soak
# Every 30 s: the site on the box (nginx on 127.0.0.1 via --resolve) and the
# public URL. One line per probe in OUTDIR/site.tsv:
#   unix_time  local_ms  local_code  public_ms  public_code  action
# Rules (watch): if the 5-min p95 of either probe passes 2x its baseline p95,
# or a probe fails twice in a row, the miner is cut to one CPU (taskset) and
# that is logged loudly; if it still holds 5 min later, the miner is stopped.
set -u
OUT=$1; MODE=$2; ARG=$3
mkdir -p "$OUT"
TSV=$OUT/site.tsv
LOG=$OUT/watch.log
probe() {
  local url=$1; shift
  curl -sk -o /dev/null --max-time 10 -w '%{http_code} %{time_total}' "$@" "$url" 2>/dev/null || echo "000 10"
}
row() {
  read -r lc lt <<< "$(probe https://shear.digital/ --resolve shear.digital:443:127.0.0.1)"
  read -r pc pt <<< "$(probe https://shear.digital/)"
  awk -v t="$(date +%s)" -v lt="$lt" -v lc="$lc" -v pt="$pt" -v pc="$pc" -v a="$1" \
    'BEGIN { printf "%s\t%.0f\t%s\t%.0f\t%s\t%s\n", t, lt * 1000, lc, pt * 1000, pc, a }' >> "$TSV"
  echo "$lc $pc"
}
p95() { # column, last N rows, of a tsv
  tail -n "$3" "$1" | cut -f"$2" | sort -n | awk '{a[NR]=$1} END {if (NR==0) {print 0} else {i=int(0.95*NR); if (i<1) i=1; print a[i]}}'
}
if [ "$MODE" = baseline ]; then
  : > "$TSV"
  end=$(( $(date +%s) + ARG ))
  while [ "$(date +%s)" -lt "$end" ]; do row baseline > /dev/null; sleep 30; done
  echo "baseline local_p95=$(p95 "$TSV" 2 1000) public_p95=$(p95 "$TSV" 4 1000) n=$(wc -l < "$TSV")" | tee -a "$LOG"
  cp "$TSV" "$OUT/baseline.tsv"
  exit 0
fi
BL=$(p95 "$OUT/baseline.tsv" 2 1000); BP=$(p95 "$OUT/baseline.tsv" 4 1000)
[ "$BL" -lt 5 ] && BL=5; [ "$BP" -lt 20 ] && BP=20
echo "[$(date -u +%FT%TZ)] watch start: baseline p95 local ${BL} ms, public ${BP} ms" | tee -a "$LOG"
fails=0; cut_at=0
while :; do
  pid=$(cat "$ARG" 2>/dev/null)
  [ -n "$pid" ] && [ -d "/proc/$pid" ] || { sleep 30; [ -f "$OUT/soak.done" ] && break; continue; }
  read -r lc pc <<< "$(row soak)"
  if [ "$lc" != 200 ] || [ "$pc" != 200 ]; then fails=$((fails + 1)); else fails=0; fi
  l5=$(p95 "$TSV" 2 10); p5=$(p95 "$TSV" 4 10)
  bad=""
  [ "$l5" -gt $((2 * BL)) ] && bad="local p95 ${l5} ms > 2x ${BL}"
  [ "$p5" -gt $((2 * BP)) ] && bad="${bad:+$bad; }public p95 ${p5} ms > 2x ${BP}"
  [ "$fails" -ge 2 ] && bad="${bad:+$bad; }probe failed twice (local $lc, public $pc)"
  now=$(date +%s)
  if [ -n "$bad" ]; then
    if [ "$cut_at" = 0 ]; then
      taskset -a -p -c 0 "$pid" > /dev/null 2>&1
      cut_at=$now
      echo "!!!!! [$(date -u +%FT%TZ)] WATCHDOG: $bad: miner pid $pid cut to one CPU" | tee -a "$LOG"
      printf '%s\t\t\t\t\tcut\n' "$now" >> "$TSV"
    elif [ $((now - cut_at)) -ge 300 ]; then
      kill "$pid" 2>/dev/null
      echo "!!!!! [$(date -u +%FT%TZ)] WATCHDOG: still $bad 5 min after the cut: miner pid $pid stopped" | tee -a "$LOG"
      printf '%s\t\t\t\t\tstop\n' "$now" >> "$TSV"
      break
    fi
  elif [ "$cut_at" != 0 ] && [ $((now - cut_at)) -ge 300 ]; then
    echo "[$(date -u +%FT%TZ)] watchdog: site back under the limits; miner stays on one CPU" | tee -a "$LOG"
    cut_at=-1
  fi
  [ -f "$OUT/soak.done" ] && break
  sleep 30
done
echo "[$(date -u +%FT%TZ)] watch end" | tee -a "$LOG"
