#!/usr/bin/env bash
# check_host.sh <pool|p2p-a|p2p-b> --phase <pre-genesis|live>: verify, don't
# paint. Read-only: it only lists and queries, it never starts, stops or sets
# anything (and never sets SHEAR_MAINNET_EMIT). Fails (exit 1) on any of:
#   - the wrong OS for the role, its firewall not active as RUNBOOK step 7
#     sets it, or SSH not rate limited there;
#   - sshd allowing password logins or root password logins (sshd -T);
#   - a public TCP or UDP listener outside the role's ports (pool: 22, 80,
#     443, 1111, 30303; p2p-a and p2p-b: 22, 30303);
#   - anything testing left behind (the teardown checklist);
#   - a shear unit that restarts by itself (drop-ins included), has a failure
#     hook, copies or fetches files, or names a host IP;
#   - a shear unit the role does not run;
#   - a unit's effective environment (Environment, EnvironmentFiles and
#     drop-ins, as systemd loaded them) on the wrong network, with RPC off
#     loopback, a test or bootstrap switch, or (pool) stratum without TLS.
# Phase pre-genesis (the v12 testnet is public, mainnet waits):
#   - each mainnet unit is installed, not enabled, and inactive; or, if it is
#     running, its last boot event says "emit":false;
#   - SHEAR_MAINNET_EMIT is set in no unit, drop-in or environment file;
#   - the v12 units are active, :30303 (and the pool's :1111) listen, and the
#     loopback RPC reports the v12 book of the /opt/shear-v12 release tree.
# Phase live (after mainnet genesis):
#   - each mainnet unit is enabled and active, no v12 unit is active;
#   - :30303 (and the pool's :1111) listen;
#   - the loopback RPC reports MAGIC_MAINNET and the book-law fingerprint of
#     the /opt/shear release tree, whose mainnetFingerprint carries its
#     GENESIS pin; the height-0 hash is printed for the launch log and must
#     equal SHEAR_GENESIS_HASH when that is given (read from another host);
#   - /opt/shear is checked out at the tag SHEAR_RELEASE_TAG;
#   - the tip rises across two samples SHEAR_CHECK_TIP_WAIT seconds apart
#     (default 600, about six blocks).
# Prints what it checked, for the launch log (RUNBOOK step 10).
#
# check_host.sh --unit-file <file>: only the static checks of one unit file
# (no systemd). The tests use it on fixture units.
#
# SHEAR_CHECK_ROOT (tests only) prefixes every file path, so the tests run
# it on a fixture tree with mock commands on PATH.
set -uo pipefail
fail=0
bad() { echo "FAIL: $*"; fail=1; }
ok() { echo "ok: $*"; }
note() { echo "note: $*"; }
usage() { echo "usage: check_host.sh <pool|p2p-a|p2p-b> --phase pre-genesis|live"; exit 2; }
R="${SHEAR_CHECK_ROOT:-}"

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

role="${1:-}"
[ "${2:-}" = "--phase" ] || usage
phase="${3:-}"
case "$phase" in pre-genesis|live) ;; *) usage ;; esac
case "$role" in
  pool)  os=ubuntu; mn="shear-p2p.service shear-pool.service"; v12="shear-v12-p2p.service shear-v12-pool.service"
         rpc_mn=shear-p2p.service; rpc_v12=shear-v12-p2p.service ;;
  p2p-a) os=debian; mn="shear-node.service"; v12="shear-v12-node.service"
         rpc_mn=shear-node.service; rpc_v12=shear-v12-node.service ;;
  p2p-b) os=fedora; mn="shear-node.service"; v12="shear-v12-node.service"
         rpc_mn=shear-node.service; rpc_v12=shear-v12-node.service ;;
  *) echo "unknown role $role"; usage ;;
esac
case "$role" in
  pool)        ports=" 22 80 443 1111 30303 "; need=" 30303 1111 " ;;
  p2p-a|p2p-b) ports=" 22 30303 "; need=" 30303 " ;;
esac
echo "check_host $role, phase $phase"
id="$(. "$R/etc/os-release" && echo "$ID")"
[ "$id" = "$os" ] && ok "os $id" || bad "os is $id, $role runs $os"

# The firewall is on, the way step 7 sets it, and SSH is rate limited.
case "$role" in
  pool)  ufw status verbose | grep -q '^Status: active' && ok "ufw active" || bad "ufw is not active"
         ufw status verbose | grep -qE '^22/tcp +LIMIT' && ok "ssh rate limit (ufw limit)" || bad "ssh has no rate limit (ufw limit 22/tcp)" ;;
  p2p-a) systemctl is-enabled --quiet nftables && nft list chain inet filter input 2>/dev/null | grep -q 'policy drop' \
           && ok "nftables enabled, input policy drop" || bad "nftables not enabled with the drop policy"
         nft list chain inet filter input 2>/dev/null | grep -qE 'tcp dport 22 .*limit rate over' \
           && ok "ssh rate limit (nft meter)" || bad "ssh has no rate limit (nft limit rate over)" ;;
  p2p-b) z="$(firewall-cmd --get-default-zone)"
         [ "$(firewall-cmd --permanent --zone="$z" --get-target)" = DROP ] && [ -z "$(firewall-cmd --zone="$z" --list-services)" ] \
           && ok "firewalld zone $z target DROP, no services" || bad "firewalld zone $z is not target DROP with no services"
         firewall-cmd --zone="$z" --list-rich-rules | grep -qE 'service name="ssh".*limit value=' \
           && ok "ssh rate limit (firewalld rich rule)" || bad "ssh has no rate limit (firewalld rich rule)"
         firewall-cmd --zone="$z" --list-ports | tr ' ' '\n' | grep -qx '22/tcp' && bad "firewalld still opens 22/tcp without the limit" ;;
esac

# sshd as it runs: keys only.
sshd_t="$(sshd -T 2>/dev/null)"
printf '%s\n' "$sshd_t" | grep -qx 'passwordauthentication no' && ok "sshd PasswordAuthentication no" || bad "sshd PasswordAuthentication is not no"
printf '%s\n' "$sshd_t" | grep -qx 'permitrootlogin yes' && bad "sshd PermitRootLogin yes"
printf '%s\n' "$sshd_t" | grep -q '^permitrootlogin ' || bad "sshd -T printed no PermitRootLogin"

# Public listeners, TCP and UDP: anything not on loopback must be one of the
# role's TCP ports, and nothing listens on UDP in public.
listening=" "
while read -r proto local; do
  addr="${local%:*}"; port="${local##*:}"
  case "$addr" in 127.*|"[::1]"|::1|"[::ffff:127."*|::ffff:127.*) continue ;; esac
  if [ "$proto" = tcp ]; then
    listening="$listening$port "
    case "$ports" in *" $port "*) ok "listener tcp $local" ;; *) bad "public tcp listener on $local" ;; esac
  else
    bad "public udp listener on $local"
  fi
done < <(ss -tulnH | awk '{print $1, $5}')
for p in $need; do
  case "$listening" in *" $p "*) ok "listening on :$p" ;; *) bad "nothing listens on :$p" ;; esac
done

# Nothing from testing (the same paths teardown.sh removes). Before genesis
# the v12 testnet is the public net and its state belongs here.
MAINNET_DIRS="mainnet mainnet-p2p mainnet-pool seal-keys"
V12_DIRS="testnet-v12 testnet-v12-p2p testnet-v12-pool seal-keys-v12"
for p in "$R"/root/claude-ci "$R"/opt/shear-v* "$R"/root/.shear "$R"/home/*/.shear "$R"/root/*.shewall "$R"/home/*/*.shewall "$R"/tmp/shear* "$R"/var/log/shear*; do
  [ -e "$p" ] || continue
  if [ "$p" = "$R/opt/shear-v12" ]; then
    [ "$phase" = pre-genesis ] && ok "v12 release $p" || note "v12 release $p still here (v12 teardown pending)"
    continue
  fi
  bad "testing left $p"
done
for d in "$R"/var/lib/shear/*; do
  [ -e "$d" ] || continue
  b="$(basename "$d")"
  case " $MAINNET_DIRS " in *" $b "*) ok "mainnet state $d"; continue ;; esac
  case " $V12_DIRS " in *" $b "*)
    [ "$phase" = pre-genesis ] && ok "v12 state $d" || note "v12 state $d still here (v12 teardown pending)"; continue ;; esac
  bad "testing left $d"
done
grep -liE 'claude-ci|lane[0-9]|fullhead|ci_run' "$R"/etc/cron.d/* 2>/dev/null | while read -r f; do echo "FAIL: testing cron $f"; done | grep -q . && fail=1
for u in $(systemctl list-unit-files --no-legend 'shear*' 'sheark*' 2>/dev/null | awk '{print $1}'); do
  case " $mn $v12 " in *" $u "*) ok "unit $u belongs to $role" ;; *) bad "unit $u does not belong on $role" ;; esac
done

# The effective environment of a unit: Environment= (drop-ins included) then
# its EnvironmentFiles, which systemd applies last.
env_files() { systemctl show -p EnvironmentFiles --value "$1" | sed 's/ (ignore_errors=[a-z]*)$//' | grep -v '^$'; }
eff_env() {
  local u="$1" f
  systemctl show -p Environment --value "$u" | tr ' ' '\n'
  while read -r f; do [ -n "$f" ] && [ -r "$R${f#-}" ] && grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$R${f#-}"; done < <(env_files "$u")
}
env_get() { eff_env "$1" | sed -n "s/^$2=//p" | tail -1 | tr -d '"'; }

# Each unit, as systemd loaded it (drop-ins included), and its file.
unit_checks() {
  local u="$1" want="$2" f="$R/etc/systemd/system/$1" e d net
  [ -f "$f" ] || { bad "missing $u"; return; }
  [ "$(systemctl show -p Restart --value "$u")" = no ] && ok "$u Restart=no" || bad "$u restarts by itself (check drop-ins)"
  [ -z "$(systemctl show -p OnFailure --value "$u")" ] || bad "$u has an OnFailure recovery"
  unit_file_checks "$u" "$f"
  e="$(eff_env "$u")"
  for d in $(systemctl show -p DropInPaths --value "$u"); do note "$u drop-in $d"; done
  while read -r d; do [ -n "$d" ] && note "$u environment file $d"; done < <(env_files "$u")
  net="$(env_get "$u" SHEAR_NETWORK)"
  [ "$net" = "$want" ] && ok "$u SHEAR_NETWORK=$net" || bad "$u runs SHEAR_NETWORK=${net:-unset}, want $want"
  printf '%s\n' "$e" | grep -qE '^(SHEAR_BOOTSTRAP[A-Z_]*|NODE_TEST_CONTEXT|SHEAR_RANGE_JS|SHEAR_STRATUM_LAB_CLEARTEXT|SHEAR_P2P_FOLLOW_IPC|SHEAR_FAST_SYNC)=' \
    && bad "$u sets $(printf '%s\n' "$e" | grep -oE '^(SHEAR_BOOTSTRAP[A-Z_]*|NODE_TEST_CONTEXT|SHEAR_RANGE_JS|SHEAR_STRATUM_LAB_CLEARTEXT|SHEAR_P2P_FOLLOW_IPC|SHEAR_FAST_SYNC)' | sort -u | tr '\n' ' ')"
  [ "$(env_get "$u" SHEAR_RPC_BIND)" = 127.0.0.1 ] && ok "$u SHEAR_RPC_BIND=127.0.0.1" || bad "$u SHEAR_RPC_BIND is not 127.0.0.1"
  case "$u" in *pool.service)
    [ "$(env_get "$u" SHEAR_STRATUM_REQUIRE_TLS)" = 1 ] && ok "$u stratum TLS required" || bad "$u SHEAR_STRATUM_REQUIRE_TLS is not 1" ;;
  esac
  if printf '%s\n' "$e" | grep -qE '^SHEAR_MAINNET_EMIT(_CONFIRM)?='; then
    [ "$phase" = pre-genesis ] && bad "$u sets SHEAR_MAINNET_EMIT before genesis" || note "$u sets SHEAR_MAINNET_EMIT"
  fi
  for d in $(systemctl show -p DropInPaths --value "$u"); do
    [ "$phase" = pre-genesis ] && grep -q 'SHEAR_MAINNET_EMIT' "$R$d" 2>/dev/null && bad "$u drop-in $d names SHEAR_MAINNET_EMIT"
  done
}
for u in $mn; do unit_checks "$u" shear-v1; done
for u in $v12; do
  if [ "$phase" = pre-genesis ] || [ -f "$R/etc/systemd/system/$u" ]; then unit_checks "$u" shear-testnet-v12; fi
done
for e in "$R/etc/shear/pool.env" "$R/etc/shear/pool-v12.env"; do
  [ "$role" = pool ] || continue
  [ "$e" = "$R/etc/shear/pool-v12.env" ] && [ "$phase" = live ] && [ ! -e "$e" ] && continue
  [ -f "$e" ] && [ "$(stat -c '%U:%G %a' "$e")" = "root:shear 640" ] && ok "${e#"$R"} root:shear 640" || bad "${e#"$R"} must exist as root:shear 640"
done

# The book a node reports on its loopback RPC, against the release tree.
jget() { node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(v==null?"":String(v))}catch{}})' "$1"; }
tree() { node --input-type=module -e "const m = await import(process.argv[1]); const v = $2; if (v != null) process.stdout.write(String(v))" "$R$1/crypto/asert.js" 2>/dev/null; }
rpc() { curl -fsS --max-time 10 "http://127.0.0.1:$1/$2"; }
book_checks() {
  local u="$1" rel="$2" magic_expr="$3" port stats magic fp want_magic want_fp
  port="$(env_get "$u" SHEAR_RPC_PORT)"; port="${port:-18332}"
  want_magic="$(tree "$rel" "$magic_expr")"
  [ -n "$want_magic" ] || { bad "cannot read the book from the release tree $rel"; return; }
  want_fp="$(tree "$rel" "m.consensusFingerprint('$want_magic')")"
  stats="$(rpc "$port" stats)" || { bad "$u RPC 127.0.0.1:$port/stats does not answer"; return; }
  magic="$(printf '%s' "$stats" | jget magic)"; fp="$(printf '%s' "$stats" | jget bookLawFingerprint)"
  [ "$magic" = "$want_magic" ] && ok "$u RPC magic $magic" || bad "$u RPC magic is ${magic:-none}, $rel says $want_magic"
  [ "$fp" = "$want_fp" ] && ok "$u book-law fingerprint matches $rel" || bad "$u book-law fingerprint differs from $rel"
  sample1="$(printf '%s' "$stats" | jget height)"
}

if [ "$phase" = pre-genesis ]; then
  for u in $mn; do
    [ -f "$R/etc/systemd/system/$u" ] && ok "$u installed" || bad "$u is not installed"
    systemctl is-enabled --quiet "$u" && bad "$u is enabled before genesis (start it on the genesis GO)"
    if systemctl is-active --quiet "$u"; then
      boot="$(journalctl -u "$u" -o cat --no-pager 2>/dev/null | grep '"event":"boot"' | tail -1)"
      printf '%s' "$boot" | grep -q '"emit":false' \
        && ok "$u active, last boot emit:false ($(printf '%s' "$boot" | grep -o '"reason":"[a-z_]*"'))" \
        || bad "$u is active before genesis without a boot event saying emit:false"
    else
      ok "$u inactive before genesis"
    fi
  done
  for u in $v12; do systemctl is-active --quiet "$u" && ok "$u active" || bad "$u is not active"; done
  book_checks "$rpc_v12" /opt/shear-v12 m.MAGIC_TESTNET_V12
else
  for u in $mn; do
    systemctl is-enabled --quiet "$u" && ok "$u enabled" || bad "$u is not enabled"
    systemctl is-active --quiet "$u" && ok "$u active" || bad "$u is not active"
  done
  for u in $v12; do systemctl is-active --quiet "$u" && bad "v12 unit $u is still active after genesis"; done
  sample1=""
  book_checks "$rpc_mn" /opt/shear m.MAGIC_MAINNET
  g="$(tree /opt/shear m.GENESIS_MAINNET)"; mfp="$(tree /opt/shear 'm.mainnetFingerprint()')"
  case "$mfp" in *":GENESIS=$g") [ -n "$g" ] && ok "release genesis pin $g" || bad "no GENESIS pin in /opt/shear" ;; *) bad "release mainnetFingerprint does not carry GENESIS=$g" ;; esac
  port="$(env_get "$rpc_mn" SHEAR_RPC_PORT)"; port="${port:-18332}"
  gh="$(rpc "$port" 'header?height=0' | jget hash)"
  echo "genesis hash (height 0): ${gh:-none}"
  if [ -n "${SHEAR_GENESIS_HASH:-}" ]; then
    [ "$gh" = "$SHEAR_GENESIS_HASH" ] && ok "genesis hash matches SHEAR_GENESIS_HASH" || bad "genesis hash differs from SHEAR_GENESIS_HASH"
  else
    note "no SHEAR_GENESIS_HASH given: compare the genesis hash above across the three hosts"
  fi
  if [ -z "${SHEAR_RELEASE_TAG:-}" ]; then bad "set SHEAR_RELEASE_TAG to the release tag /opt/shear must be at"
  else
    tag="$(git -C "$R/opt/shear" describe --tags --exact-match HEAD 2>/dev/null)"
    [ "$tag" = "$SHEAR_RELEASE_TAG" ] && ok "/opt/shear at release tag $tag" || bad "/opt/shear release tag is ${tag:-none}, want $SHEAR_RELEASE_TAG"
  fi
  sleep "${SHEAR_CHECK_TIP_WAIT:-600}"
  sample2="$(rpc "$port" stats | jget height)"
  if [ -n "$sample1" ] && [ -n "$sample2" ] && [ "$sample2" -gt "$sample1" ] 2>/dev/null; then ok "tip rose $sample1 -> $sample2"
  else bad "tip did not rise (${sample1:-?} -> ${sample2:-?})"; fi
fi

echo "check_host $role $phase: $( [ $fail = 0 ] && echo PASS || echo FAIL )"
exit $fail
