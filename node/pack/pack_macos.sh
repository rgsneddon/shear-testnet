#!/bin/sh
# MacBook: Shear Sentinel zip for PRODUCT_VERSION 15.0 (not the Continuum .dmg).
#   npm ci
#   sh node/pack/pack_macos.sh
# Upload dist/shear-node-v15-macos.zip onto the existing GitHub release v15.
# Do not pass --clobber. Do not upload onto v7, v9, v10, v12, or v14.
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
test -f crypto/asert.js
PIN=$(sed -n "s/^export const PRODUCT_VERSION = '\\(.*\\)';/\\1/p" crypto/asert.js | head -1)
if [ "$PIN" != "15.0" ]; then
  echo "refusing pack: PRODUCT_VERSION is '$PIN', want 15.0" >&2
  exit 1
fi
LABEL=v15
if [ ! -d node_modules ]; then
  echo "missing node_modules — run npm ci before packing" >&2
  exit 1
fi
cmake -S crypto/randomx -B crypto/randomx/build -DARCH=native
cmake --build crypto/randomx/build -j"$(sysctl -n hw.ncpu)"
make -C crypto/native
python3 node/pack/zip_node.py macos
test -f "dist/shear-node-$LABEL-macos.zip"
python3 - "$LABEL" <<'PY'
import sys, zipfile
label = sys.argv[1]
path = f"dist/shear-node-{label}-macos.zip"
z = zipfile.ZipFile(path)
names = set(z.namelist())
need = (
    "node/src/node.js",
    "pool/src/wallet_api.js",
    "pool/src/hash_credit.js",
    "pool/src/withdraw_state.js",
    "contracts/Reserve.json",
    "crypto/native/shearhash.node",
    "crypto/native/shearadmit.node",
    "node_modules/@noble/hashes/sha2.js",
)
missing = [n for n in need if n not in names]
if missing:
    sys.exit("missing " + ", ".join(missing))
magic = z.read("crypto/native/shearhash.node")[:4]
macho = {
    b"\xfe\xed\xfa\xce",
    b"\xfe\xed\xfa\xcf",
    b"\xcf\xfa\xed\xfe",
    b"\xce\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
}
if magic not in macho:
    sys.exit("shearhash.node is not Mach-O: " + magic.hex())
text = z.read("crypto/asert.js").decode()
if "PRODUCT_VERSION = '15.0'" not in text or "shear-testnet-v10" not in text:
    sys.exit("packed asert.js is not Sentinel 15.0 on shear-testnet-v10")
print("darwin-ok", len(names))
PY
echo "ok dist/shear-node-$LABEL-macos.zip"
echo "Upload onto the existing v15 release. Do not pass --clobber."
echo "gh release upload v15 dist/shear-node-$LABEL-macos.zip --repo rgsneddon/shear-testnet"
