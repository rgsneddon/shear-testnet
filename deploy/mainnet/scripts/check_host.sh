#!/usr/bin/env bash
# check_host.sh <pool|p2p-a|p2p-b>: verify, don't paint. Read-only. Fails
# (exit 1) on any of:
#   - the wrong OS for the role;
#   - a public listener outside 22, 80, 443, 1111, 8080 and 30303;
#   - anything testing left behind (RUNBOOK teardown checklist);
#   - a shear unit that restarts by itself, copies a datadir or tip.json,
#     or reaches a host by IP;
#   - a shear unit the role does not run.
# Prints what it checked, for the launch log (RUNBOOK step 9).
set -uo pipefail
role="${1:?role: pool, p2p-a or p2p-b}"
fail=0
bad() { echo "FAIL: $*"; fail=1; }
ok() { echo "ok: $*"; }

case "$role" in
  pool)  os=ubuntu; units="shear-p2p.service shear-pool.service" ;;
  p2p-a) os=debian; units="shear-node.service" ;;
  p2p-b) os=fedora; units="shear-node.service" ;;
  *) echo "unknown role $role"; exit 2 ;;
esac
id="$(. /etc/os-release && echo "$ID")"
[ "$id" = "$os" ] && ok "os $id" || bad "os is $id, $role runs $os"

# Public listeners: anything not bound to loopback must be an allowed port.
allowed=" 22 80 443 1111 8080 30303 "
while read -r local; do
  addr="${local%:*}"; port="${local##*:}"
  case "$addr" in 127.*|"[::1]"|::1) continue ;; esac
  case "$allowed" in *" $port "*) ok "listener $local" ;; *) bad "public listener on $local" ;; esac
done < <(ss -tlnH | awk '{print $4}')

# Nothing from testing.
for p in /root/claude-ci /opt/shear-v4 /var/lib/shear/testnet* /var/lib/shear/stressnet* /var/lib/shear/shear-dev*; do
  [ -e "$p" ] && bad "testing left $p"
done
for u in $(systemctl list-unit-files --no-legend 'shear*' 'sheark*' 2>/dev/null | awk '{print $1}'); do
  case " $units " in *" $u "*) ok "unit $u belongs to $role" ;; *) bad "unit $u does not belong on $role" ;; esac
done

# Each installed unit: no self-restart, no datadir or tip.json copy, no IP.
for u in $units; do
  f="/etc/systemd/system/$u"
  [ -f "$f" ] || { bad "missing $u"; continue; }
  grep -qx 'Restart=no' "$f" && ok "$u Restart=no" || bad "$u restarts by itself"
  grep -qiE 'tip\.json|rsync|(^|[^a-z])cp ' "$f" && bad "$u copies files (datadir or tip.json)"
  if grep -E '([0-9]{1,3}\.){3}[0-9]{1,3}' "$f" | grep -vqE '127\.0\.0\.1|0\.0\.0\.0'; then bad "$u names a host IP"; fi
  [ -n "$(systemctl show -p OnFailure --value "$u")" ] && bad "$u has an OnFailure recovery"
done

echo "check_host $role: $( [ $fail = 0 ] && echo PASS || echo FAIL )"
exit $fail
