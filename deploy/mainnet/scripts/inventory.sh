#!/usr/bin/env bash
# inventory.sh: a read-only record of one host before its rebuild (RUNBOOK
# step 3) and after it (step 9). It changes nothing: it only lists. Run on
# Russell's GO, and save its output in the launch log.
#
# Lists: OS, kernel, uptime, disk, users with a login shell, every systemd
# service and timer that is enabled or running, cron jobs, listening sockets,
# firewall state, and what sits in the paths testing used.
set -uo pipefail
section() { printf '\n## %s\n' "$1"; }

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
for u in $(cut -d: -f1 /etc/passwd); do c="$(crontab -l -u "$u" 2>/dev/null)" && printf '%s:\n%s\n' "$u" "$c"; done
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
