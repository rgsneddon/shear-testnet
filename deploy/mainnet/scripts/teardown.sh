#!/usr/bin/env bash
# teardown.sh: removes everything testing left on one host, so mainnet users
# get a clean pool, client downloads and nodes (RUNBOOK, teardown checklist).
#
# Dry run by default: it lists what it would stop, disable and delete, and
# changes nothing. --apply also needs SHEAR_TEARDOWN_GO set to this host's
# name, the token Russell's GO gives for that host, so it can never run on
# the wrong host by accident.
#
# It removes testing, not the host and not mainnet:
#   - SSH access, TLS certificates and their renewal hooks, DNS and the live
#     site webroot are kept (back the webroot up first: RUNBOOK step 4);
#   - mainnet state is never touched: the mainnet datadirs, the mainnet seal
#     keys, pool-spend.seed, every unit that runs SHEAR_NETWORK=shear-v1 and,
#     while any of those is present, the /opt/shear release tree.
#
# It runs only on the three mainnet roles. SHEAR_ROLE must be pool, p2p-a or
# p2p-b (and match /etc/shear/role when that file exists). agent-box, the
# explorer node, is refused by name even with a matching token.
#
# If pool-spend.seed is present, --apply also needs SHEAR_SEED_BACKUP_SHA256
# set to the sha256 of the offline backup Russell verified (RUNBOOK step 4).
#
# SHEAR_TEARDOWN_ROOT (tests only) prefixes every path and skips systemctl
# and crontab, so a fixture tree can be checked as a dry run. With it,
# SHEAR_TEARDOWN_HOSTNAME stands in for hostname. --apply refuses it.
set -euo pipefail
apply=0; [ "${1:-}" = "--apply" ] && apply=1
R="${SHEAR_TEARDOWN_ROOT:-}"
# The fixture refusal comes first, so no test ever needs a real GO token.
if [ $apply = 1 ] && [ -n "$R" ]; then echo "refused: --apply with a fixture root"; exit 1; fi
host="$(hostname)"
if [ -n "$R" ] && [ -n "${SHEAR_TEARDOWN_HOSTNAME:-}" ]; then host="$SHEAR_TEARDOWN_HOSTNAME"; fi
role="${SHEAR_ROLE:-}"

# agent-box is the explorer node: never torn down, whatever the token says.
for name in "$host" "$role"; do
  case "$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" in
    *agent-box*|*agentbox*|*agent_box*|*explorer*)
      echo "refused: agent-box (the explorer node) is never torn down by this script ($name)"; exit 1 ;;
  esac
done
case "$role" in
  pool|p2p-a|p2p-b) ;;
  *) echo "refused: role must be pool, p2p-a or p2p-b (set SHEAR_ROLE), got '${role}'"; exit 1 ;;
esac
if [ -f "$R/etc/shear/role" ]; then
  filed="$(tr -d '[:space:]' < "$R/etc/shear/role")"
  if [ "$filed" != "$role" ]; then echo "refused: /etc/shear/role says $filed, SHEAR_ROLE says $role"; exit 1; fi
fi
if [ $apply = 1 ] && [ "${SHEAR_TEARDOWN_GO:-}" != "$host" ]; then
  echo "refused: --apply needs SHEAR_TEARDOWN_GO=$host (Russell's GO for this host)"; exit 1
fi
run() { if [ $apply = 1 ]; then "$@"; else echo "would run: $*"; fi; }
gone() { [ -e "$1" ] || [ -L "$1" ]; }
keep() { echo "keep (mainnet): $1"; }

# Mainnet state. Names match deploy/mainnet/units/*.service.
MAINNET_DIRS="mainnet mainnet-p2p mainnet-pool seal-keys"
SEED="$R/var/lib/shear/mainnet-pool/pool-spend.seed"
mainnet_unit_file() { [ -f "$1" ] && grep -qx 'Environment=SHEAR_NETWORK=shear-v1' "$1"; }
mainnet_present=0
for d in $MAINNET_DIRS; do gone "$R/var/lib/shear/$d" && mainnet_present=1; done
for f in "$R"/etc/systemd/system/shear*.service; do mainnet_unit_file "$f" && mainnet_present=1; done

# The pool spend seed is never removed here, but no teardown runs on a host
# that holds it until its offline backup is attested.
if [ -f "$SEED" ]; then
  want="$(sha256sum "$SEED" | awk '{print $1}')"
  if [ -z "${SHEAR_SEED_BACKUP_SHA256:-}" ]; then
    echo "seed backup: no attestation, --apply refuses until SHEAR_SEED_BACKUP_SHA256 is set (RUNBOOK step 4)"
    [ $apply = 1 ] && { echo "refused: pool-spend.seed is present and its offline backup is not attested"; exit 1; }
  elif [ "$SHEAR_SEED_BACKUP_SHA256" != "$want" ]; then
    echo "seed backup: SHEAR_SEED_BACKUP_SHA256 does not match pool-spend.seed"
    [ $apply = 1 ] && { echo "refused: the attested seed backup does not match pool-spend.seed"; exit 1; }
  else
    echo "seed backup: attested, sha256 matches"
  fi
fi

# 1. Test and testnet services, timers and their units. A unit that runs the
#    mainnet book is kept, with its *.wants link.
is_mainnet_unit() {
  local name="$1"
  mainnet_unit_file "$R/etc/systemd/system/$name"
}
if [ -z "$R" ]; then
  for u in $(systemctl list-unit-files --no-legend 'shear*' 'sheark*' 2>/dev/null | awk '{print $1}'); do
    case "$u" in *@.*) continue ;; esac   # a template has no instance to stop
    frag="$(systemctl show -p FragmentPath --value "$u" 2>/dev/null || true)"
    if is_mainnet_unit "$u" || { [ -n "$frag" ] && mainnet_unit_file "$frag"; }; then keep "unit $u"; continue; fi
    run systemctl disable --now "$u" || echo "could not disable $u: check it by hand"
  done
fi
for f in "$R"/etc/systemd/system/shear* "$R"/etc/systemd/system/sheark* "$R"/etc/systemd/system/*.wants/shear*; do
  gone "$f" || continue
  if mainnet_unit_file "$f" || is_mainnet_unit "$(basename "$f")"; then keep "$f"; continue; fi
  run rm -rf "$f"
done
if [ -z "$R" ]; then run systemctl daemon-reload; fi

# 2. The build-server tree and every test lane, bundle, tar and log in it.
if gone "$R/root/claude-ci"; then run rm -rf "$R/root/claude-ci"; fi

# 3. Every testing datadir: testnet (v12 included), stressnet, shear-dev, any
#    mainnet-magic test run outside the mainnet datadirs, and the default
#    ~/.shear of anything run without SHEAR_DATA. The mainnet datadirs and
#    seal keys are kept.
for d in "$R"/var/lib/shear/* "$R"/root/.shear "$R"/home/*/.shear; do
  gone "$d" || continue
  case " $MAINNET_DIRS " in *" $(basename "$d") "*) [ "$(dirname "$d")" = "$R/var/lib/shear" ] && { keep "$d"; continue; } ;; esac
  run rm -rf "$d"
done

# 4. Release trees from testing (/opt/shear-v12 and older). /opt/shear is the
#    mainnet tree once any mainnet state is here; before that it is the old
#    testnet tree and goes.
for d in "$R"/opt/shear "$R"/opt/shear-v*; do
  gone "$d" || continue
  if [ "$d" = "$R/opt/shear" ] && [ $mainnet_present = 1 ]; then keep "$d"; continue; fi
  run rm -rf "$d"
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

echo "teardown $( [ $apply = 1 ] && echo applied || echo 'dry run, nothing changed' ) on $host ($role)"
echo "next: check_host.sh $role --phase <pre-genesis|live> must pass"
