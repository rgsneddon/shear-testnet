#!/usr/bin/env bash
# Reload fleet pool units so live /api/stats matches in-repo stratum BIND+AUTH.
# Required: SHEAR_STRATUM_BIND=127.0.0.1 and SHEAR_STRATUM_AUTH=1
# (deploy/shear-pool.service, deploy/shear-pool-v4.service).
# Optional TLS terminator in front of 127.0.0.1:1111 — this tree does not ship certs.
# Ops only. Does not weaken ADMIT. Does not wipe datadir.
set -euo pipefail
UNIT="${SHEAR_POOL_UNIT:-shear-pool.service}"
HOST="${SHEAR_STATS_URL:-http://127.0.0.1:8088/api/stats}"

echo "reload $UNIT"
echo "require SHEAR_STRATUM_BIND=127.0.0.1 SHEAR_STRATUM_AUTH=1 (or TLS in front of loopback)"

if command -v systemctl >/dev/null 2>&1; then
  if systemctl cat "$UNIT" >/dev/null 2>&1; then
    unit_txt="$(systemctl cat "$UNIT" || true)"
    if ! grep -q 'SHEAR_STRATUM_BIND=127.0.0.1' <<<"$unit_txt"; then
      echo "FAIL: unit $UNIT missing Environment=SHEAR_STRATUM_BIND=127.0.0.1 — copy deploy/shear-pool.service"
      exit 1
    fi
    if ! grep -q 'SHEAR_STRATUM_AUTH=1' <<<"$unit_txt"; then
      echo "FAIL: unit $UNIT missing Environment=SHEAR_STRATUM_AUTH=1 — copy deploy/shear-pool.service"
      exit 1
    fi
  fi
  systemctl daemon-reload
  systemctl restart "$UNIT"
  sleep 2
  systemctl is-active --quiet "$UNIT"
  echo "active $UNIT"
else
  echo "WARN: no systemctl — skipping unit restart; still checking $HOST"
fi

python3 - <<'PY' "$HOST"
import json, sys, urllib.request
url = sys.argv[1]
with urllib.request.urlopen(url, timeout=8) as r:
    j = json.load(r)
want_bind = "127.0.0.1"
bind = str(j.get("stratumBind") or j.get("stratum_bind") or "")
auth = str(j.get("loginAuth") or j.get("stratumAuth") or "")
clear = j.get("stratumCleartext")
print("stratumBind", bind)
print("loginAuth", auth)
print("stratumCleartext", clear)
ok = True
if want_bind not in bind and bind not in ("127.0.0.1", "::1"):
    print("FAIL: stratumBind is not loopback — copy deploy/shear-pool.service Environment=SHEAR_STRATUM_BIND=127.0.0.1")
    ok = False
if auth != "ed25519":
    print("FAIL: loginAuth must be ed25519 (SHEAR_STRATUM_AUTH=1); got %r" % (auth,))
    ok = False
if clear is True:
    print("WARN: stratumCleartext=true — terminate TLS in front of 127.0.0.1:1111 (do not invent a cert in this tree)")
if not ok:
    sys.exit(1)
print("ok: live stats match tip BIND+AUTH units")
PY
