#!/usr/bin/env bash
# check_host.sh <pool|p2p-a|p2p-b>: verify, don't paint. Read-only. Fails
# (exit 1) on any of:
#   - the wrong OS for the role, or its firewall not active as RUNBOOK step 7
#     sets it;
#   - a public TCP or UDP listener outside 22, 80, 443, 1111 and 30303;
#   - anything testing left behind (the teardown checklist);
#   - a shear unit that restarts by itself (drop-ins included), has a failure
#     hook, copies or fetches files, or names a host IP;
#   - a shear unit the role does not run.
# Prints what it checked, for the launch log (RUNBOOK step 10).
#
# check_host.sh --unit-file <file>: only the static checks of one unit file
# (no systemd). The tests use it on fixture units.
set -uo pipefail
fail=0
bad() { echo "FAIL: $*"; fail=1; }
ok() { echo "ok: $*"; }

# Static checks of one unit file: what it runs and where it reaches.
unit_file_checks() {
  local u="$1" f="$2" execs
  execs="$(grep -E '^Exec[A-Za-z]*=' "$f")"
  [ "$(grep -cE '^Exec[A-Za-z]*=' "$f")" = 1 ] && printf '%s\n' "$execs" | grep -q '^ExecStart=' \
    && ok "$u has one ExecStart and no other Exec step" || bad "$u has an Exec step other than one ExecStart"
  printf '%s\n' "$execs" | grep -qiE 'tip\.json|rsync|scp|curl|wget|(^|[ =/])cp ' && bad "$u copies or fetches files"
  grep -E '^[A-Za-z]+=' "$f" | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | grep -vxE '127\.0\.0\.1|0\.0\.0\.0' | grep -q . \
    && bad "$u names a host IP"
  grep -qE '^(OnFailure|FailureAction|StartLimitAction)=' "$f" && bad "$u has a failure hook"
  grep -qE '^Restart=' "$f" && ! grep -qx 'Restart=no' "$f" && bad "$u restarts by itself"
  return 0
}

if [ "${1:-}" = "--unit-file" ]; then
  f="${2:?unit file}"
  unit_file_checks "$(basename "$f")" "$f"
  echo "unit-file $(basename "$f"): $( [ $fail = 0 ] && echo PASS || echo FAIL )"
  exit $fail
fi

role="${1:?role: pool, p2p-a or p2p-b}"
case "$role" in
  pool)  os=ubuntu; units="shear-p2p.service shear-pool.service" ;;
  p2p-a) os=debian; units="shear-node.service" ;;
  p2p-b) os=fedora; units="shear-node.service" ;;
  *) echo "unknown role $role"; exit 2 ;;
esac
id="$(. /etc/os-release && echo "$ID")"
[ "$id" = "$os" ] && ok "os $id" || bad "os is $id, $role runs $os"

# The firewall is on, the way step 7 sets it.
case "$role" in
  pool)  ufw status | grep -q '^Status: active' && ok "ufw active" || bad "ufw is not active" ;;
  p2p-a) systemctl is-enabled --quiet nftables && nft list chain inet filter input 2>/dev/null | grep -q 'policy drop' \
           && ok "nftables enabled, input policy drop" || bad "nftables not enabled with the drop policy" ;;
  p2p-b) z="$(firewall-cmd --get-default-zone)"
         [ "$(firewall-cmd --permanent --zone="$z" --get-target)" = DROP ] && [ -z "$(firewall-cmd --zone="$z" --list-services)" ] \
           && ok "firewalld zone $z target DROP, no services" || bad "firewalld zone $z is not target DROP with no services" ;;
esac

# Public listeners, TCP and UDP: anything not on loopback must be an allowed
# TCP port, and nothing listens on UDP in public.
while read -r proto local; do
  addr="${local%:*}"; port="${local##*:}"
  case "$addr" in 127.*|"[::1]"|::1|"[::ffff:127."*|::ffff:127.*) continue ;; esac
  if [ "$proto" = tcp ]; then
    case " 22 80 443 1111 30303 " in *" $port "*) ok "listener tcp $local" ;; *) bad "public tcp listener on $local" ;; esac
  else
    bad "public udp listener on $local"
  fi
done < <(ss -tulnH | awk '{print $1, $5}')

# Nothing from testing (the same paths teardown.sh removes).
for p in /root/claude-ci /opt/shear-v* /root/.shear /home/*/.shear /root/*.shewall /home/*/*.shewall /tmp/shear* /var/log/shear*; do
  [ -e "$p" ] && bad "testing left $p"
done
for d in /var/lib/shear/*; do
  [ -e "$d" ] || continue
  case "$(basename "$d")" in mainnet|mainnet-p2p|mainnet-pool|seal-keys) ok "mainnet state $d" ;; *) bad "testing left $d" ;; esac
done
grep -liE 'claude-ci|lane[0-9]|fullhead|ci_run' /etc/cron.d/* 2>/dev/null | while read -r f; do echo "FAIL: testing cron $f"; done | grep -q . && fail=1
for u in $(systemctl list-unit-files --no-legend 'shear*' 'sheark*' 2>/dev/null | awk '{print $1}'); do
  case " $units " in *" $u "*) ok "unit $u belongs to $role" ;; *) bad "unit $u does not belong on $role" ;; esac
done

# Each installed unit, as systemd loaded it (drop-ins included), and its file.
for u in $units; do
  f="/etc/systemd/system/$u"
  [ -f "$f" ] || { bad "missing $u"; continue; }
  [ "$(systemctl show -p Restart --value "$u")" = no ] && ok "$u Restart=no" || bad "$u restarts by itself (check drop-ins)"
  [ -z "$(systemctl show -p OnFailure --value "$u")" ] || bad "$u has an OnFailure recovery"
  unit_file_checks "$u" "$f"
done
if [ "$role" = pool ]; then
  e=/etc/shear/pool.env
  [ -f "$e" ] && [ "$(stat -c '%U:%G %a' "$e")" = "root:shear 640" ] && ok "$e root:shear 640" || bad "$e must exist as root:shear 640"
fi

echo "check_host $role: $( [ $fail = 0 ] && echo PASS || echo FAIL )"
exit $fail
