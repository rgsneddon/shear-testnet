#!/usr/bin/env bash
# p2p-b (Fedora Server): firewalld, inbound TCP 22, 80, 443, 1111, 8080 and
# 30303 only, IPv4 and IPv6. Fedora's default zone opens cockpit and other
# services, so every service and port not on the list is removed from it.
# R18a, deploy/mainnet/RUNBOOK.md step 7. Run only on Russell's GO, on the
# rebuilt host. Prints the plan and changes nothing unless --apply is given.
set -euo pipefail
PORTS="22 80 443 1111 8080 30303"
apply=0; [ "${1:-}" = "--apply" ] && apply=1
run() { if [ $apply = 1 ]; then "$@"; else echo "would run: $*"; fi; }
[ "$(. /etc/os-release && echo "$ID")" = fedora ] || { echo "not Fedora: this is p2p-b's firewall"; exit 1; }
zone="$(firewall-cmd --get-default-zone)"
# 22 first, so an apply over SSH never locks the session out.
run firewall-cmd --permanent --zone="$zone" --add-port=22/tcp
for s in $(firewall-cmd --permanent --zone="$zone" --list-services); do
  run firewall-cmd --permanent --zone="$zone" --remove-service="$s"
done
for p in $(firewall-cmd --permanent --zone="$zone" --list-ports); do
  case " $PORTS " in *" ${p%/tcp} "*) [ "${p#*/}" = tcp ] && continue ;; esac
  run firewall-cmd --permanent --zone="$zone" --remove-port="$p"
done
for p in $PORTS; do run firewall-cmd --permanent --zone="$zone" --add-port="$p/tcp"; done
run firewall-cmd --permanent --zone="$zone" --set-target=DROP
run firewall-cmd --reload
[ $apply = 1 ] && firewall-cmd --zone="$zone" --list-all
exit 0
