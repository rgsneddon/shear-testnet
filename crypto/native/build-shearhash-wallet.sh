#!/usr/bin/env bash
# Host libshearhash.so for the Linux wallet bundle. Interpreter ShearHash-v3.
# Output is gitignored. Stamp the SHA-256 before flutter build and pass it as
# --dart-define=SHEAR_HASH_SHA256=<hex>.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RX="$ROOT/crypto/randomx"
MINER="$ROOT/sheark-miner/src"
OUT="$HERE/libshearhash.so"
CC="${CC:-gcc}"
CXX="${CXX:-g++}"

if [[ -f "$OUT" && "$OUT" -nt "$HERE/shearhash_wallet.c" && "$OUT" -nt "$MINER/shear_hash.c" ]]; then
  exit 0
fi

cmake -S "$RX" -B "$RX/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DARCH=default \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DCMAKE_C_COMPILER="$CC" \
  -DCMAKE_CXX_COMPILER="$CXX"
cmake --build "$RX/build" -j"$(nproc)"
"$CC" -shared -fPIC -O2 \
  -I "$MINER" -I "$RX/src" \
  -o "$OUT" \
  "$HERE/shearhash_wallet.c" \
  "$MINER/shear_hash.c" \
  "$MINER/sha512.c" \
  "$MINER/sha256.c" \
  "$RX/build/librandomx.a" \
  -pthread -lstdc++
python3 "$HERE/stamp_shearhash_pin.py" "$OUT"
echo "staged $OUT"
