#!/bin/bash
# Confirm the built miner prints the known ShearHash-v3 digest.
set -euo pipefail
BIN=${1:?binary}
OUT=$("$BIN" --selftest 2>&1)
printf '%s\n' "$OUT"
printf '%s\n' "$OUT" | grep -q e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4
if printf '%s\n' "$OUT" | grep -q 5d00a242; then
  echo "v1 vector must fail" >&2
  exit 1
fi
echo "selftest digest ok"
