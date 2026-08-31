#!/bin/bash
# Build + zip wallet linux/arch on Dedicated-de. Invoked on the server.
set -euo pipefail
WALLET="${SHEAR_WALLET:-/opt/shear-v2/wallet}"
FLUTTER_ROOT="${FLUTTER_ROOT:-/opt/flutter}"
VER="$(sed -n "s/^const kWalletVersion = '\\(.*\\)';/\\1/p" "$WALLET/lib/main.dart" | head -1)"
BUILD_NUMBER="${BUILD_NUMBER:-20}"
# Flutter file version is x.y.z+N. Public zip pin stays two-part $VER.
FLUTTER_NAME="$VER"
case "$FLUTTER_NAME" in
  *.*.*) ;;
  *.*) FLUTTER_NAME="${FLUTTER_NAME}.0" ;;
esac
export PATH="$FLUTTER_ROOT/bin:$PATH"
export HOME="${HOME:-/root}"
export PUB_CACHE="${PUB_CACHE:-/opt/flutter/.pub-cache}"

test -n "$VER"
test -x "$FLUTTER_ROOT/bin/flutter"
cd "$WALLET"
git config --global --add safe.directory "$FLUTTER_ROOT" || true
flutter config --enable-linux-desktop --no-analytics >/dev/null
flutter pub get
flutter build linux --release --build-name="$FLUTTER_NAME" --build-number="$BUILD_NUMBER"
BUNDLE="$WALLET/build/linux/x64/release/bundle"
test -x "$BUNDLE/shear_wallet"
DIST="$WALLET/dist"
mkdir -p "$DIST"
PKGBUILD="$WALLET/pack/archlinux/PKGBUILD"
export BUNDLE DIST PKGBUILD VER

python3 - <<PY
import os, zipfile, sys
bundle = os.environ["BUNDLE"]
dist = os.environ["DIST"]
pkgbuild = os.environ["PKGBUILD"]
ver = os.environ["VER"]

def add_tree(z, root):
    for dp, _dns, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            z.write(p, os.path.relpath(p, root))

linux_out = os.path.join(dist, f"shear-wallet-{ver}-linux.zip")
arch_out = os.path.join(dist, f"shear-wallet-{ver}-archlinux.zip")
for p in (linux_out, arch_out):
    if os.path.exists(p):
        os.remove(p)

with zipfile.ZipFile(linux_out, "w", zipfile.ZIP_DEFLATED) as z:
    add_tree(z, bundle)
print("wrote", linux_out, os.path.getsize(linux_out))

with zipfile.ZipFile(arch_out, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(pkgbuild, "PKGBUILD")
    add_tree(z, bundle)
print("wrote", arch_out, os.path.getsize(arch_out))

for name in (linux_out, arch_out):
    size = os.path.getsize(name)
    names = zipfile.ZipFile(name).namelist()
    print(name, "bytes", size)
    if size < 1_000_000:
        sys.exit(f"refusing tiny zip {name}")
    if "shear_wallet" not in names:
        sys.exit(f"missing shear_wallet in {name}")
    if any(
        n == "shear-miner" or n == "Shear-Miner" or n == "ShearK-Miner"
        or n.endswith("/shear-miner") or n.endswith("/Shear-Miner") or n.endswith("/ShearK-Miner")
        or n.endswith("shear-miner.exe") or n.endswith("Shear-Miner.exe") or n.endswith("ShearK-Miner.exe")
        for n in names
    ):
        sys.exit(f"wallet zip must not include miner: {name}")
    if "archlinux" in name:
        pkg = zipfile.ZipFile(name).read("PKGBUILD").decode()
        if f"pkgver={ver}" not in pkg or f"pkgver={ver}.0" in pkg:
            sys.exit(f"arch PKGBUILD not two-part {ver}")
print("ok")
PY
echo "LINUX_PACK_OK $VER"
