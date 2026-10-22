#!/usr/bin/env bash
# Wallet FFI for ShearHash-v3. Links the miner sources. Does not change them.
# shear_hash keeps the RandomX cache for the current key across calls.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MINER="$ROOT/sheark-miner/src"
RX="$ROOT/crypto/randomx"
RXLIB="$RX/build/librandomx.a"
OUT="$HERE/libshear_v3.so"
if [[ ! -f "$RXLIB" ]]; then
  cmake -S "$RX" -B "$RX/build" -DARCH=native
  cmake --build "$RX/build" --target randomx -j"$(nproc)"
fi
cc -shared -fPIC -O2 -Wall \
  -I"$MINER" -I"$RX/src" \
  -o "$OUT" \
  "$HERE/shear_v3_export.c" \
  "$MINER/shear_hash.c" \
  "$MINER/sha512.c" \
  "$MINER/sha256.c" \
  "$RXLIB" \
  -pthread -lstdc++
echo "built $OUT"
