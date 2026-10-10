#!/bin/bash
# Confirm the built miner prints the known ShearHash-v3 digest.
set -euo pipefail
BIN=${1:?binary}
OUT=$("$BIN" --selftest 2>&1)
printf '%s\n' "$OUT"
printf '%s\n' "$OUT" | grep -q 98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b
if printf '%s\n' "$OUT" | grep -q 5d00a242; then
  echo "v1 vector must fail" >&2
  exit 1
fi
echo "selftest digest ok"
