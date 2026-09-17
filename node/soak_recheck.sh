#!/bin/bash
# Packed-bits 24h soak deadline. Laptop need not be open.
set +e
LOG=/var/lib/shear/testnet-v4/soak-recheck.log
exec >>"$LOG" 2>&1
echo "===== packed soak-recheck $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
cd /opt/shear-v4 || exit 1
fail=0

wait_rpc() {
  local port="$1" n=0
  while [ "$n" -lt 40 ]; do
    if curl -sf --max-time 8 "http://127.0.0.1:${port}/jroot" >/dev/null; then
      return 0
    fi
    n=$((n + 1))
    sleep 3
  done
  echo "rpc_wait_fail port=$port"
  return 1
}

stats() {
  echo "--- $1 ---"
  curl -sS --max-time 30 "http://127.0.0.1:18332/stats" || echo "p1_rpc_fail"
  echo
  curl -sS --max-time 30 "http://127.0.0.1:18333/stats" || echo "p2_rpc_fail"
  echo
  systemctl is-active shear-ibd-v4 shear-ibd-v4-peer2 shear-ibd-v4-mine
}

same_jroot() {
  python3 - <<'PY'
import json, urllib.request, sys
def g(path, port):
    return json.load(urllib.request.urlopen("http://127.0.0.1:%s/%s" % (port, path), timeout=30))
a, b = g("jroot", 18332), g("jroot", 18333)
sa, sb = g("stats", 18332), g("stats", 18333)
j1, j2 = a.get("jroot"), b.get("jroot")
h1, h2 = sa.get("height"), sb.get("height")
print("compare", h1, h2, j1 == j2, (j1 or "")[:16], "bits", sa.get("bits"))
sys.exit(0 if j1 and j1 == j2 and int(h1 or 0) > 0 else 1)
PY
}

wait_rpc 18332 || fail=1
wait_rpc 18333 || fail=1
stats before
same_jroot || fail=1
echo "=== restart peers ==="
systemctl restart shear-ibd-v4
sleep 3
systemctl restart shear-ibd-v4-peer2
sleep 2
wait_rpc 18332 || fail=1
wait_rpc 18333 || fail=1
systemctl restart shear-ibd-v4-mine
sleep 2
stats after_restart
same_jroot || fail=1
echo "=== reorg ==="
node node/soak_vps.js reorg || fail=1
echo "=== reserve ==="
node node/soak_vps.js reserve || fail=1
echo "=== vort1 ==="
node node/soak_vps.js vort1 || fail=1
echo "=== adversary ==="
node --test tests/adversary/admit_v2.js || fail=1
echo "=== flow flag ==="
cat /var/lib/shear/testnet-v4/soak-flow.json 2>/dev/null || { echo NO_FLOW; fail=1; }
echo "=== clock tail ==="
tail -5 /var/lib/shear/testnet-v4/soak-clock.log 2>/dev/null
stats final
same_jroot || fail=1
if [ "$fail" -eq 0 ]; then
  echo "SOAK_RECHECK_PASS $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi
echo "SOAK_RECHECK_FAIL $(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit 1
