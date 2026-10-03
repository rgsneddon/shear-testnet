#!/bin/bash
# Build + zip wallet linux/arch on Dedicated-de. Invoked on the server.
set -euo pipefail
WALLET="${SHEAR_WALLET:-/opt/shear-v3/wallet}"
FLUTTER_ROOT="${FLUTTER_ROOT:-/opt/flutter}"
VER_FULL="$(sed -n "s/^const kWalletVersion = '\\(.*\\)';/\\1/p" "$WALLET/lib/main.dart" | head -1 | tr -d '\r')"
# Public zip and Arch pkgver are major.minor. Display may be major.minor.patch.
case "$VER_FULL" in
  *.*.*) VER="${VER_FULL%.*}" ;;
  *) VER="$VER_FULL" ;;
esac
PUBSPEC_PLUS="$(sed -n 's/^version: .*+\([0-9][0-9]*\).*/\1/p' "$WALLET/pubspec.yaml" | head -1 | tr -d '\r')"
if [ -z "${PUBSPEC_PLUS}" ]; then
  echo "LINUX_BUILD_NUMBER_MISSING pubspec +N" >&2
  exit 1
fi
if [ -n "${BUILD_NUMBER:-}" ] && [ "$BUILD_NUMBER" != "$PUBSPEC_PLUS" ]; then
  echo "LINUX_BUILD_NUMBER_MISMATCH env=$BUILD_NUMBER pubspec=$PUBSPEC_PLUS" >&2
  exit 1
fi
BUILD_NUMBER="$PUBSPEC_PLUS"
if [ "$BUILD_NUMBER" = "49" ]; then
  echo "LINUX_BUILD_NUMBER_REFUSED 49" >&2
  exit 1
fi
# Flutter file version is x.y.z+N. Public zip pin stays two-part $VER.
FLUTTER_NAME="$VER_FULL"
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
# Bundle libsodium for native AdmitV1 prove.
mkdir -p "$BUNDLE/lib"
for p in /usr/lib/x86_64-linux-gnu/libsodium.so.26 /usr/lib/x86_64-linux-gnu/libsodium.so.23 /usr/lib64/libsodium.so.26 /usr/lib64/libsodium.so.23 /usr/local/lib/libsodium.so.26 /usr/local/lib/libsodium.so.23; do
  if [ -f "$p" ]; then
    cp -L "$p" "$BUNDLE/lib/$(basename "$p")"
    ln -sfn "$(basename "$p")" "$BUNDLE/lib/libsodium.so" || true
    break
  fi
done
test -e "$BUNDLE/lib/libsodium.so.26" || test -e "$BUNDLE/lib/libsodium.so.23"
DIST="$WALLET/dist"
mkdir -p "$DIST"
PKGBUILD="$WALLET/pack/archlinux/PKGBUILD"
REPO="$(cd "$WALLET/.." && pwd)"
PACK_FLAVOR="${SHEAR_PACK_FLAVOR:-linux}"
export BUNDLE DIST PKGBUILD VER REPO PACK_FLAVOR

python3 - <<PY
import os, sys, zipfile
bundle = os.environ["BUNDLE"]
dist = os.environ["DIST"]
pkgbuild = os.environ["PKGBUILD"]
ver = os.environ["VER"]
repo = os.environ["REPO"]
pack_flavor = os.environ.get("PACK_FLAVOR", "linux")
sys.path.insert(0, os.path.join(repo, "node", "pack"))
from bundle_modules import assert_zip_has_modules, write_missing_required, write_release_sidecar

def add_tree(z, root):
    for dp, _dns, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            z.write(p, os.path.relpath(p, root))

def pack(path, arch=False):
    if os.path.exists(path):
        os.remove(path)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        if arch:
            z.write(pkgbuild, "PKGBUILD")
        add_tree(z, bundle)
        write_release_sidecar(z, repo, flavor="linux")
        write_missing_required(z, repo)
    print("wrote", path, os.path.getsize(path))
    return path

if pack_flavor == "fedora":
    outs = [pack(os.path.join(dist, f"shear-wallet-{ver}-fedora.zip"))]
else:
    outs = [
        pack(os.path.join(dist, f"shear-wallet-{ver}-linux.zip")),
        pack(os.path.join(dist, f"shear-wallet-{ver}-archlinux.zip"), arch=True),
    ]

for name in outs:
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
    for req in (
        "node/src/node.js",
        "runtime/node",
        "crypto/native/shearhash.node",
        "node_modules/@noble/hashes/sha2.js",
        "node_modules/@ethereumjs/evm/package.json",
    ):
        if req not in names:
            sys.exit(f"wallet zip missing {req}")
    node_info = zipfile.ZipFile(name).getinfo("runtime/node")
    # Fedora's distro node is a ~28KB PIE. A zip that ships only that stub
    # does not start off the soak. libnode.so must sit beside it.
    if node_info.file_size < 1_000_000 and not any(
        n.startswith("runtime/libnode.so") for n in names
    ):
        sys.exit(
            f"wallet runtime/node is {node_info.file_size} bytes and has no libnode: {name}"
        )
    if "runtime/node.exe" in names:
        sys.exit(f"unix wallet zip must not ship runtime/node.exe: {name}")
    assert_zip_has_modules(names, repo)
print("ok")
PY
echo "LINUX_PACK_OK $VER"
