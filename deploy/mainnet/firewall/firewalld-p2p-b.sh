#!/usr/bin/env bash
# p2p-b (Fedora Server): firewalld, inbound TCP 22 (rate limited) and 30303
# only, IPv4 and IPv6. A p2p host serves no site and no stratum, so 80, 443
# and 1111 stay closed. 8080 is closed (RUNBOOK, "Port 8080"). Fedora's
# default zone opens cockpit and other services, so every service, port,
# source port, protocol and rich rule not on the list is removed from it,
# and every interface is put in that zone.
# R18a, deploy/mainnet/RUNBOOK.md step 7. Run only on Russell's GO, on the
# rebuilt host. Prints the plan and changes nothing unless --apply is given.
set -euo pipefail
PORTS="30303"
apply=0; [ "${1:-}" = "--apply" ] && apply=1
run() { if [ $apply = 1 ]; then "$@"; else echo "would run: $*"; fi; }
[ "$(. /etc/os-release && echo "$ID")" = fedora ] || { echo "not Fedora: this is p2p-b's firewall"; exit 1; }
zone="$(firewall-cmd --get-default-zone)"
z=(--permanent --zone="$zone")
# 22 first, so an apply over SSH never locks the session out. The plain
# 22/tcp is swapped for the rate-limited SSH rich rules just before the reload.
run firewall-cmd "${z[@]}" --add-port=22/tcp
for n in /sys/class/net/*; do i="${n##*/}"; if [ "$i" != lo ]; then run firewall-cmd "${z[@]}" --change-interface="$i"; fi; done
for s in $(firewall-cmd "${z[@]}" --list-services); do run firewall-cmd "${z[@]}" --remove-service="$s"; done
for p in $(firewall-cmd "${z[@]}" --list-ports); do
  [ "$p" = 22/tcp ] && continue
  case " $PORTS " in *" ${p%/tcp} "*) [ "${p#*/}" = tcp ] && continue ;; esac
  run firewall-cmd "${z[@]}" --remove-port="$p"
done
for p in $(firewall-cmd "${z[@]}" --list-source-ports); do run firewall-cmd "${z[@]}" --remove-source-port="$p"; done
for p in $(firewall-cmd "${z[@]}" --list-protocols); do run firewall-cmd "${z[@]}" --remove-protocol="$p"; done
# An empty list prints one blank line; under set -e a bare [ -n "$r" ] &&
# would end the script there, so the test is an if.
firewall-cmd "${z[@]}" --list-rich-rules | while IFS= read -r r; do if [ -n "$r" ]; then run firewall-cmd "${z[@]}" --remove-rich-rule="$r"; fi; done
for p in $PORTS; do run firewall-cmd "${z[@]}" --add-port="$p/tcp"; done
# ICMP and ICMPv6 are allowed by name, as on p2p-a's nftables, so IPv6
# path-MTU discovery works under target DROP. All other inbound is dropped.
run firewall-cmd "${z[@]}" --add-protocol=icmp
run firewall-cmd "${z[@]}" --add-protocol=ipv6-icmp
run firewall-cmd "${z[@]}" --set-target=DROP
# SSH, rate limited: over 10 new connections a minute are not accepted.
run firewall-cmd "${z[@]}" --add-rich-rule='rule family="ipv4" service name="ssh" accept limit value="10/m"'
run firewall-cmd "${z[@]}" --add-rich-rule='rule family="ipv6" service name="ssh" accept limit value="10/m"'
run firewall-cmd "${z[@]}" --remove-port=22/tcp
run firewall-cmd --reload
if [ $apply = 1 ]; then firewall-cmd --zone="$zone" --list-all; fi
exit 0
