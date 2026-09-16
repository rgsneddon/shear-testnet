#!/bin/bash
set +e
LOG=/var/lib/shear/testnet-v4/soak-clock.log
aj=$(curl -sS --max-time 25 http://127.0.0.1:18332/jroot || echo "{}")
bj=$(curl -sS --max-time 25 http://127.0.0.1:18333/jroot || echo "{}")
a=$(curl -sS --max-time 25 http://127.0.0.1:18332/stats || echo "{}")
b=$(curl -sS --max-time 25 http://127.0.0.1:18333/stats || echo "{}")
svc=$(systemctl is-active shear-ibd-v4 shear-ibd-v4-peer2 shear-ibd-v4-mine | tr "\n" " ")
flow=0
test -f /var/lib/shear/testnet-v4/soak-flow.json && flow=1
python3 - "$a" "$b" "$aj" "$bj" "$svc" "$flow" >> "$LOG" <<'PY'
import json, sys, datetime
def j(s):
    try:
        return json.loads(s)
    except Exception:
        return {}
a, b, aj, bj = j(sys.argv[1]), j(sys.argv[2]), j(sys.argv[3]), j(sys.argv[4])
j1 = aj.get("jroot") or a.get("jroot")
j2 = bj.get("jroot") or b.get("jroot")
row = {
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "h1": a.get("height"),
    "h2": b.get("height"),
    "j1": j1,
    "j2": j2,
    "same": bool(j1) and j1 == j2,
    "svc": sys.argv[5].strip(),
    "flow": int(sys.argv[6]),
    "magic": a.get("magic"),
    "admit": a.get("admit"),
    "bits": a.get("bits"),
}
print(json.dumps(row), flush=True)
if not row["same"]:
    raise SystemExit(2)
PY
