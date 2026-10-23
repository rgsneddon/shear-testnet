#!/usr/bin/env bash
# Wallet FFI for ShearHash-v3. Links the miner sources. Does not change them.
# The key includes the previous hash, so each new header rebuilds the cache.
# libstdc++ and libgcc are static so a release zip does not ship them.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MINER="$ROOT/sheark-miner/src"
RX="$ROOT/crypto/randomx"
RXLIB="$RX/build/librandomx.a"
OS="$(uname -s)"
if [[ ! -f "$RXLIB" ]]; then
  cmake -S "$RX" -B "$RX/build" -DARCH=native
  cmake --build "$RX/build" --target randomx -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
fi
OBJS="$HERE/build/host"
mkdir -p "$OBJS"
if [[ "$OS" == "Darwin" ]]; then
  OUT="$HERE/libshear_v3.dylib"
  gcc -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/shear_v3_export.o" "$HERE/shear_v3_export.c"
  gcc -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/shear_hash.o" "$MINER/shear_hash.c"
  gcc -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/sha512.o" "$MINER/sha512.c"
  gcc -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/sha256.o" "$MINER/sha256.c"
  c++ -dynamiclib -fPIC -O2 \
    -o "$OUT" \
    "$OBJS/shear_v3_export.o" "$OBJS/shear_hash.o" "$OBJS/sha512.o" "$OBJS/sha256.o" \
    "$RXLIB" -lc++
else
  OUT="$HERE/libshear_v3.so"
  gcc -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/shear_v3_export.o" "$HERE/shear_v3_export.c"
  gcc -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/shear_hash.o" "$MINER/shear_hash.c"
  gcc -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/sha512.o" "$MINER/sha512.c"
  gcc -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/sha256.o" "$MINER/sha256.c"
  # C sources stay C. g++ only links, so libstdc++ is static and not shipped.
  g++ -shared -fPIC -O2 -static-libgcc -static-libstdc++ \
    -o "$OUT" \
    "$OBJS/shear_v3_export.o" "$OBJS/shear_hash.o" "$OBJS/sha512.o" "$OBJS/sha256.o" \
    "$RXLIB" -pthread
fi
echo "built $OUT"
