#!/usr/bin/env bash
# teardown.sh: removes everything testing left on one host, so mainnet users
# get a clean pool, client downloads and nodes (RUNBOOK, teardown checklist).
#
# Dry run by default: it lists what it would stop, disable and delete, and
# changes nothing. --apply also needs SHEAR_TEARDOWN_GO set to this host's
# name, the token Russell's GO gives for that host, so it can never run on
# the wrong host by accident.
#
# It removes testing, not the host: SSH access, TLS certificates and their
# renewal hooks, DNS and the live site webroot are kept (back the webroot up
# first: RUNBOOK step 4).
#
# SHEAR_TEARDOWN_ROOT (tests only) prefixes every path and skips systemctl
# and crontab, so a fixture tree can be checked as a dry run. --apply refuses
# it.
set -euo pipefail
apply=0; [ "${1:-}" = "--apply" ] && apply=1
host="$(hostname)"
R="${SHEAR_TEARDOWN_ROOT:-}"
if [ $apply = 1 ] && [ "${SHEAR_TEARDOWN_GO:-}" != "$host" ]; then
  echo "refused: --apply needs SHEAR_TEARDOWN_GO=$host (Russell's GO for this host)"; exit 1
fi
if [ $apply = 1 ] && [ -n "$R" ]; then echo "refused: --apply with a fixture root"; exit 1; fi
run() { if [ $apply = 1 ]; then "$@"; else echo "would run: $*"; fi; }
gone() { [ -e "$1" ] || [ -L "$1" ]; }

# 1. Test and testnet services, timers and their units. Every shear* unit
#    from testing goes; the mainnet units are installed fresh afterwards.
if [ -z "$R" ]; then
  for u in $(systemctl list-unit-files --no-legend 'shear*' 'sheark*' 2>/dev/null | awk '{print $1}'); do
    case "$u" in *@.*) continue ;; esac   # a template has no instance to stop
    run systemctl disable --now "$u" || echo "could not disable $u: check it by hand"
  done
fi
for f in "$R"/etc/systemd/system/shear* "$R"/etc/systemd/system/sheark* "$R"/etc/systemd/system/*.wants/shear*; do
  if gone "$f"; then run rm -rf "$f"; fi
done
if [ -z "$R" ]; then run systemctl daemon-reload; fi

# 2. The build-server tree and every test lane, bundle, tar and log in it.
if gone "$R/root/claude-ci"; then run rm -rf "$R/root/claude-ci"; fi

# 3. Every datadir: testnet, stressnet, shear-dev, any mainnet-magic test
#    run, and the default ~/.shear of anything run without SHEAR_DATA (it
#    also holds book seal keys). Nothing is kept or copied: mainnet nodes
#    start from genesis and verify every block themselves.
for d in "$R"/var/lib/shear/* "$R"/root/.shear "$R"/home/*/.shear; do
  if gone "$d"; then run rm -rf "$d"; fi
done

# 4. Release trees from testing, /opt/shear included: the mainnet release
#    is installed fresh from its tagged commit.
for d in "$R"/opt/shear "$R"/opt/shear-v*; do
  if gone "$d"; then run rm -rf "$d"; fi
done

# 5. Cron. A file in /etc/cron.d that names claude-ci or a lane goes. One
#    that only names shear is listed, not removed: certbot and other renewal
#    hooks for shear.digital must stay.
for f in "$R"/etc/cron.d/*; do
  [ -f "$f" ] || continue
  if grep -qiE 'claude-ci|lane[0-9]|fullhead|ci_run' "$f"; then run rm -f "$f"
  elif grep -qi 'shear' "$f"; then echo "check by hand (names shear): $f"; fi
done
if [ -z "$R" ]; then
  for u in $(cut -d: -f1 /etc/passwd); do
    if crontab -l -u "$u" 2>/dev/null | grep -qiE 'shear|claude-ci|lane'; then
      echo "cron for $u names testing; remove its lines by hand and log them:"
      crontab -l -u "$u" | grep -iE 'shear|claude-ci|lane' | sed 's/^/  /'
    fi
  done
fi

# 6. Test wallets, keys and logs left in home directories and /tmp.
for p in "$R"/root/*.shewall "$R"/home/*/*.shewall "$R"/tmp/shear* "$R"/var/log/shear*; do
  if gone "$p"; then run rm -rf "$p"; fi
done

echo "teardown $( [ $apply = 1 ] && echo applied || echo 'dry run, nothing changed' ) on $host"
echo "next: check_host.sh must pass before the mainnet units are installed"
