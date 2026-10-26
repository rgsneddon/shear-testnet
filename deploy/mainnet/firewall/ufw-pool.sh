#!/usr/bin/env bash
# Pool host (Ubuntu Server LTS): ufw, inbound TCP 22, 80, 443, 1111 and
# 30303 only, IPv4 and IPv6. Everything else inbound is dropped. 8080 is
# closed (RUNBOOK, "Port 8080").
# R18a, deploy/mainnet/RUNBOOK.md step 7. Run only on Russell's GO, on the
# rebuilt host. Prints the plan and changes nothing unless --apply is given.
set -euo pipefail
PORTS="22 80 443 1111 30303"
apply=0; [ "${1:-}" = "--apply" ] && apply=1
run() { if [ $apply = 1 ]; then "$@"; else echo "would run: $*"; fi; }
[ "$(. /etc/os-release && echo "$ID")" = ubuntu ] || { echo "not Ubuntu: this is the pool host's firewall"; exit 1; }
grep -qx 'IPV6=yes' /etc/default/ufw || { echo "/etc/default/ufw must say IPV6=yes, or the v6 rules are not applied"; exit 1; }
# Start from no rules: whatever the image shipped is dropped. reset leaves
# ufw disabled, so the SSH session is never filtered mid-way.
run ufw --force reset
run ufw default deny incoming
run ufw default allow outgoing
# 22 first, so enabling never locks the session out.
for p in $PORTS; do run ufw allow "$p/tcp"; done
run ufw --force enable
if [ $apply = 1 ]; then ufw status verbose; fi
exit 0
