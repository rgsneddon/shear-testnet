#!/bin/bash
# Dest-bind soak on P2pnode. Does NOT restart seed or the pool.
# Restart = peer-2 only. reorg/reserve/vort1 use temp stores (soak_vps.js).
set +e
cd /opt/shear-v4 || exit 1
LOG=/var/lib/shear/testnet-v4/vps-soak.log
exec >>"$LOG" 2>&1
echo "===== destbind soak $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
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

same_jroot() {
  python3 - <<'PY'
import json, urllib.request, sys
def g(path, port):
    return json.load(urllib.request.urlopen("http://127.0.0.1:%s/%s" % (port, path), timeout=30))
a, b = g("jroot", 18332), g("jroot", 18333)
sa, sb = g("stats", 18332), g("stats", 18333)
j1, j2 = a.get("jroot"), b.get("jroot")
h1, h2 = sa.get("height"), sb.get("height")
ha, hb = sa.get("hash"), sb.get("hash")
print("compare", h1, h2, j1 == j2, ha == hb, (j1 or "")[:16], "hash", (ha or "")[:16])
sys.exit(0 if j1 and j1 == j2 and ha and ha == hb and int(h1 or 0) > 0 else 1)
PY
}

wait_rpc 18332 || fail=1
wait_rpc 18333 || fail=1
echo "=== live fingerprint ==="
node node/soak_vps.js live || fail=1
echo "=== jroot before ==="
same_jroot || fail=1

echo "=== restart peer-2 only (seed+pool stay up) ==="
systemctl restart shear-ibd-v4-peer2
sleep 3
wait_rpc 18333 || fail=1
same_jroot || fail=1

echo "=== reorg (temp stores) ==="
nice -n 15 node node/soak_vps.js reorg || fail=1
echo "=== reserve ==="
nice -n 15 node node/soak_vps.js reserve || fail=1
echo "=== vort1 ==="
nice -n 15 node node/soak_vps.js vort1 || fail=1
echo "=== adversary ==="
node --test tests/adversary/admit_v2.js || fail=1
echo "=== benches 1k/10k/100k ==="
nice -n 10 node crypto/admit_bench_run.js 1000 10000 100000 || fail=1
echo "=== jroot after ==="
same_jroot || fail=1
echo "=== seed still up ==="
systemctl is-active shear-ibd-v4 shear-ibd-v4-peer2
if [ "$fail" -eq 0 ]; then
  echo "SOAK_DESTBIND_PASS $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi
echo "SOAK_DESTBIND_FAIL $(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit 1
