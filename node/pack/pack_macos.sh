#!/bin/sh
# MacBook: portable SHEAR-NODEv9 zip (not the Continuum .dmg).
#   sh node/pack/pack_macos.sh
# Upload dist/shear-node-v9-macos.zip onto GitHub release v9. Do not upload onto v7.
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
test -f crypto/asert.js
LABEL=v9
cmake -S crypto/randomx -B crypto/randomx/build -DARCH=native
cmake --build crypto/randomx/build -j"$(sysctl -n hw.ncpu)"
make -C crypto/native
python3 node/pack/zip_node.py macos
test -f "dist/shear-node-$LABEL-macos.zip"
echo "ok dist/shear-node-$LABEL-macos.zip"
echo "Upload: gh release upload $LABEL dist/shear-node-$LABEL-macos.zip --repo rgsneddon/shear-testnet"
