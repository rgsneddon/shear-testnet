#!/usr/bin/env bash
# Run the full Dart wallet suite: every test/*_test.dart except the rows in
# test/suite_exclude.txt, one `flutter test` per file so a hang names its file.
# Run from wallet/. Env:
#   SHARD / OF   run every OF-th file starting at SHARD (1-based); default 1/1
#   FILE_TIMEOUT seconds per file (default 1800)
#   OUT          log folder (default build/wallet-suite)
# Exit 1 if any file fails, a row names a missing file, or a row has no reason.
set -uo pipefail
SHARD="${SHARD:-1}"
OF="${OF:-1}"
FILE_TIMEOUT="${FILE_TIMEOUT:-1800}"
OUT="${OUT:-build/wallet-suite}"
EXCLUDE=test/suite_exclude.txt
mkdir -p "$OUT"

bad=0
declare -A skip
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  file="${line%% *}"
  reason="${line#"$file"}"
  if [ ! -f "$file" ]; then
    echo "::error::$EXCLUDE names $file, which does not exist" >&2
    bad=1
  fi
  if [ -z "${reason// /}" ]; then
    echo "::error::$EXCLUDE row for $file has no reason" >&2
    bad=1
  fi
  skip["$file"]=1
done < "$EXCLUDE"
[ "$bad" = 0 ] || exit 1

# The wallet's native libraries. Tests that seal, prove or hash with them
# fail without them (admit_lib_load, fs1_prove, the sealed-book suites), so
# the suite builds what is missing before the first file and stops, loudly,
# when it cannot. There is no skip: a missing library is never a pass.
ADMIT_SO=../crypto/native/admit/target/release/libshear_admit.so
V3_SO=native/libshear_v3.so
if [ "$(uname -s)" = Linux ]; then
  if [ ! -f "$ADMIT_SO" ]; then
    echo "wallet suite: building $ADMIT_SO (crypto/native/build-linux-admit-so.sh)"
    if ! bash ../crypto/native/build-linux-admit-so.sh > "$OUT/build-admit.log" 2>&1; then
      echo "::error::libshear_admit.so did not build; see $OUT/build-admit.log" >&2
      tail -20 "$OUT/build-admit.log" >&2
      exit 1
    fi
  fi
  if [ ! -f "$V3_SO" ]; then
    echo "wallet suite: building $V3_SO (wallet/native/build-shear-v3.sh)"
    if ! bash native/build-shear-v3.sh > "$OUT/build-v3.log" 2>&1; then
      echo "::error::libshear_v3.so did not build; see $OUT/build-v3.log" >&2
      tail -20 "$OUT/build-v3.log" >&2
      exit 1
    fi
  fi
fi
for so in "$ADMIT_SO" "$V3_SO"; do
  if [ ! -f "$so" ]; then
    echo "::error::$so is missing; build it first (crypto/native/build-linux-admit-so.sh, wallet/native/build-shear-v3.sh)" >&2
    exit 1
  fi
done

mapfile -t all < <(ls test/*_test.dart | LC_ALL=C sort)
run=()
i=0
for f in "${all[@]}"; do
  [ -n "${skip[$f]:-}" ] && continue
  i=$((i + 1))
  if [ $(( (i - 1) % OF + 1 )) -eq "$SHARD" ]; then run+=("$f"); fi
done
echo "wallet suite shard $SHARD/$OF: ${#run[@]} files (of $i run, ${#skip[@]} excluded)"

failed=()
for f in "${run[@]}"; do
  log="$OUT/$(basename "$f" .dart).log"
  t0=$(date +%s)
  timeout "$FILE_TIMEOUT" flutter test -j 1 -r expanded "$f" > "$log" 2>&1
  rc=$?
  last=$(grep -E '^[0-9]+:[0-9]+ \+' "$log" | tail -1 | grep -oE '\+[0-9]+( ~[0-9]+)?( -[0-9]+)?' | head -1)
  echo "$f rc=$rc ${last:-} s=$(( $(date +%s) - t0 ))"
  # A skipped test is not a pass: every test in a run file must run.
  if grep -qE '^[0-9]+:[0-9]+ \+[0-9]+ ~[0-9]+' "$log"; then
    echo "::error::$f skipped tests; every test must run"
    rc=1
  fi
  if [ "$rc" != 0 ]; then
    failed+=("$f")
    grep -E '\[E\]$' "$log" | sed 's/^/    /' | head -40
  fi
done
if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::${#failed[@]} wallet test file(s) failed: ${failed[*]}"
  exit 1
fi
echo "wallet suite shard $SHARD/$OF: all ${#run[@]} files passed"
