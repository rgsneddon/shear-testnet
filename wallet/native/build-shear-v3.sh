#!/usr/bin/env bash
# Wallet FFI for ShearHash-v3. Links the miner sources. Does not change them.
# The key includes the previous hash, so each new header rebuilds the cache.
# libstdc++ and libgcc are static so a release zip does not ship them.
# x86_64 builds pin the ISA baseline (scripts/randomx_build.sh says why), and
# librandomx.a always comes from that script, never from whatever build an
# earlier step left in the tree. scripts/isa_scan.py checks the library.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MINER="$ROOT/sheark-miner/src"
RX="$ROOT/crypto/randomx"
RXLIB="$RX/build/librandomx.a"
OS="$(uname -s)"
case "$(uname -m)" in
  x86_64|amd64) BASE="-march=x86-64 -mtune=generic" ;;
  *) BASE="" ;;
esac
bash "$ROOT/scripts/randomx_build.sh"
OBJS="$HERE/build/host"
mkdir -p "$OBJS"
if [[ "$OS" == "Darwin" ]]; then
  OUT="$HERE/libshear_v3.dylib"
  gcc $BASE -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/shear_v3_export.o" "$HERE/shear_v3_export.c"
  gcc $BASE -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/shear_hash.o" "$MINER/shear_hash.c"
  gcc $BASE -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/sha512.o" "$MINER/sha512.c"
  gcc $BASE -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/sha256.o" "$MINER/sha256.c"
  c++ $BASE -dynamiclib -fPIC -O2 \
    -o "$OUT" \
    "$OBJS/shear_v3_export.o" "$OBJS/shear_hash.o" "$OBJS/sha512.o" "$OBJS/sha256.o" \
    "$RXLIB" -lc++
else
  OUT="$HERE/libshear_v3.so"
  gcc $BASE -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/shear_v3_export.o" "$HERE/shear_v3_export.c"
  gcc $BASE -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/shear_hash.o" "$MINER/shear_hash.c"
  gcc $BASE -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/sha512.o" "$MINER/sha512.c"
  gcc $BASE -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJS/sha256.o" "$MINER/sha256.c"
  # C sources stay C. g++ only links, so libstdc++ is static and not shipped.
  g++ $BASE -shared -fPIC -O2 -static-libgcc -static-libstdc++ \
    -o "$OUT" \
    "$OBJS/shear_v3_export.o" "$OBJS/shear_hash.o" "$OBJS/sha512.o" "$OBJS/sha256.o" \
    "$RXLIB" -pthread
fi
echo "built $OUT"
