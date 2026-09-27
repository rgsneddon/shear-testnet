#!/bin/sh
# MacBook: portable Shear node zip (not the Continuum .dmg).
# Build native addons on THIS Mac, then:
#   sh node/pack/pack_macos.sh
# Upload dist/shear-node-0.56-macos.zip onto GitHub release 0.56.
# Do not create tag 0.55.2. Do not attach wallet zips from this machine.
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
test -f crypto/asert.js
VER="$(python3 -c "import pathlib,re; t=pathlib.Path('crypto/asert.js').read_text(); print(re.search(r\"export const PRODUCT_VERSION = '([^']+)'\", t).group(1))")"
VER="${VER:-0.56}"
cmake -S crypto/randomx -B crypto/randomx/build -DARCH=native
cmake --build crypto/randomx/build -j"$(sysctl -n hw.ncpu)"
make -C crypto/native
python3 node/pack/zip_node.py macos
test -f "dist/shear-node-$VER-macos.zip"
echo "ok dist/shear-node-$VER-macos.zip"
echo "Upload: gh release upload $VER dist/shear-node-$VER-macos.zip --repo rgsneddon/shear-testnet"
