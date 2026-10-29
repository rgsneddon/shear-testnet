#!/usr/bin/env bash
# inventory.sh: a read-only record of one host before its rebuild (RUNBOOK
# step 3) and after it (step 9). It changes nothing: it only lists. Run on
# Russell's GO, and save its output in the launch log.
#
# Lists: OS, kernel, uptime, disk, users with a login shell, every systemd
# service and timer that is enabled or running, cron jobs, listening sockets,
# firewall state, and what sits in the paths testing used.
#
# Crontab lines are masked before they are printed: a NAME=value assignment,
# a user:password@ in a URL, the word after Bearer, token, password, secret
# or apikey, and any run of 32 or more key-like characters become
# <redacted>, so no secret reaches the launch log. The schedule and the
# command stay readable. inventory.sh --redact masks stdin the same way (the
# tests use it).
set -uo pipefail
section() { printf '\n## %s\n' "$1"; }
redact() {
  sed -E \
    -e 's/([A-Za-z_][A-Za-z0-9_]*)=[^[:space:]]+/\1=<redacted>/g' \
    -e 's#://[^/@[:space:]]+@#://<redacted>@#g' \
    -e 's/(bearer|token|password|passwd|secret|apikey|api_key|api-key)([:[:space:]]+)[^[:space:]"<]+/\1\2<redacted>/Ig' \
    -e 's/[A-Za-z0-9_+=-]{32,}/<redacted>/g'
}
if [ "${1:-}" = "--redact" ]; then redact; exit 0; fi

section "host"
hostname; . /etc/os-release && echo "$PRETTY_NAME"; uname -r; uptime
section "disk"
df -h -x tmpfs -x devtmpfs
section "users with a login shell"
awk -F: '$7 !~ /(nologin|false)$/ {print $1, $6, $7}' /etc/passwd
section "services enabled or running"
systemctl list-unit-files --type=service --state=enabled --no-pager --no-legend
systemctl list-units --type=service --state=running --no-pager --no-legend
section "timers"
systemctl list-timers --all --no-pager --no-legend
section "cron"
for u in $(cut -d: -f1 /etc/passwd); do c="$(crontab -l -u "$u" 2>/dev/null | redact)" && [ -n "$c" ] && printf '%s:\n%s\n' "$u" "$c"; done
ls -la /etc/cron.d /etc/cron.daily /etc/cron.hourly 2>/dev/null
section "listening sockets"
ss -tulpnH
section "firewall"
if command -v ufw >/dev/null; then ufw status verbose; fi
if command -v firewall-cmd >/dev/null; then firewall-cmd --list-all; fi
if command -v nft >/dev/null; then nft list ruleset; fi
section "paths testing used"
for p in /root/claude-ci /var/lib/shear /opt/shear /opt/shear-v4 /etc/systemd/system/shear* \
         /var/www /etc/nginx/sites-enabled /etc/letsencrypt/live /root /home; do
  [ -e "$p" ] && { echo "--- $p"; ls -la $p 2>/dev/null | head -50; }
done
section "shear units"
for u in /etc/systemd/system/shear*.service /etc/systemd/system/sheark*.service; do
  [ -f "$u" ] || continue
  echo "--- $u"; grep -E '^(Restart|ExecStart|Environment=SHEAR_(DATA|NETWORK))' "$u"
done
