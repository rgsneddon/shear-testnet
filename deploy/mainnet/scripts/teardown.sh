#!/usr/bin/env bash
# teardown.sh: removes everything testing left on one host, so mainnet users
# get a clean pool, client downloads and nodes (RUNBOOK, teardown checklist).
#
# Dry run by default: it lists what it would stop, disable and delete, and
# changes nothing. --apply also needs SHEAR_TEARDOWN_GO set to this host's
# name, the token Russell's GO gives for that host, so it can never run on
# the wrong host by accident.
#
# It removes testing, not the host: SSH access, TLS certificates, DNS and
# the live site webroot are kept (back the webroot up first: RUNBOOK step 4).
set -euo pipefail
apply=0; [ "${1:-}" = "--apply" ] && apply=1
host="$(hostname)"
if [ $apply = 1 ] && [ "${SHEAR_TEARDOWN_GO:-}" != "$host" ]; then
  echo "refused: --apply needs SHEAR_TEARDOWN_GO=$host (Russell's GO for this host)"; exit 1
fi
run() { if [ $apply = 1 ]; then "$@"; else echo "would run: $*"; fi; }

# 1. Test and testnet services, timers and their units. Every shear* unit
#    from testing goes; the mainnet units are installed fresh afterwards.
for u in $(systemctl list-unit-files --no-legend 'shear*' 'sheark*' 2>/dev/null | awk '{print $1}'); do
  run systemctl disable --now "$u"
done
for f in /etc/systemd/system/shear* /etc/systemd/system/sheark* /etc/systemd/system/*.wants/shear*; do
  [ -e "$f" ] && run rm -rf "$f"
done
run systemctl daemon-reload

# 2. The build-server tree and every test lane, bundle, tar and log in it.
[ -e /root/claude-ci ] && run rm -rf /root/claude-ci

# 3. Every datadir: testnet, stressnet, shear-dev, and any mainnet-magic
#    test run. Nothing is kept or copied: mainnet nodes start from genesis
#    and verify every block themselves.
if [ -d /var/lib/shear ]; then
  for d in /var/lib/shear/*; do [ -e "$d" ] && run rm -rf "$d"; done
fi

# 4. Old release trees from testing (the mainnet release goes to /opt/shear).
for d in /opt/shear-v4 /opt/shear-v*; do [ -e "$d" ] && run rm -rf "$d"; done

# 5. Cron jobs that name shear, the lanes or claude-ci.
for u in $(cut -d: -f1 /etc/passwd); do
  if crontab -l -u "$u" 2>/dev/null | grep -qiE 'shear|claude-ci|lane'; then
    echo "cron for $u names testing; remove its lines by hand and log them:"
    crontab -l -u "$u" | grep -iE 'shear|claude-ci|lane' | sed 's/^/  /'
  fi
done
grep -liE 'shear|claude-ci' /etc/cron.d/* 2>/dev/null | while read -r f; do run rm -f "$f"; done

# 6. Test wallets, keys and logs left in home directories and /tmp.
for p in /root/*.shewall /home/*/*.shewall /tmp/shear* /var/log/shear*; do
  [ -e "$p" ] && run rm -rf "$p"
done

echo "teardown $( [ $apply = 1 ] && echo applied || echo 'dry run, nothing changed' ) on $host"
echo "next: check_host.sh must pass before the mainnet units are installed"
