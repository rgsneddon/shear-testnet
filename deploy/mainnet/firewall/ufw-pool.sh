#!/usr/bin/env bash
# Pool host (Ubuntu Server LTS): ufw, inbound TCP 22, 80, 443, 1111, 8080 and
# 30303 only, IPv4 and IPv6. Everything else inbound is dropped.
# R18a, deploy/mainnet/RUNBOOK.md step 7. Run only on Russell's GO, on the
# rebuilt host. Prints the plan and changes nothing unless --apply is given.
set -euo pipefail
PORTS="22 80 443 1111 8080 30303"
apply=0; [ "${1:-}" = "--apply" ] && apply=1
run() { if [ $apply = 1 ]; then "$@"; else echo "would run: $*"; fi; }
[ "$(. /etc/os-release && echo "$ID")" = ubuntu ] || { echo "not Ubuntu: this is the pool host's firewall"; exit 1; }
# 22 first, so an apply over SSH never locks the session out.
run ufw allow 22/tcp
run ufw default deny incoming
run ufw default allow outgoing
for p in $PORTS; do run ufw allow "$p/tcp"; done
run ufw --force enable
[ $apply = 1 ] && ufw status verbose
exit 0
