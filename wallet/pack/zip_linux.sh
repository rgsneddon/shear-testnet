#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/rgsnedds
BUNDLE="$HOME/src/shear/wallet/build/linux/x64/release/bundle"
DIST="/mnt/c/Users/rgsne/shear/dist"
MINER="/mnt/c/Users/rgsne/shear/miner/shear-miner"
PKGBUILD="/mnt/c/Users/rgsne/shear/wallet/pack/archlinux/PKGBUILD"
mkdir -p "$DIST"
test -x "$BUNDLE/shear_wallet"
test -x "$MINER"
cp -f "$MINER" "$BUNDLE/shear-miner"
chmod +x "$BUNDLE/shear-miner"
"$BUNDLE/shear-miner" --selftest
"$BUNDLE/shear-miner" --print-config

linux_out="$DIST/shear-wallet-0.0.3-linux.zip"
arch_out="$DIST/shear-wallet-0.0.3-archlinux.zip"
rm -f "$linux_out" "$arch_out"

python3 - <<PY
import os, zipfile, sys
bundle = os.path.expanduser("~/src/shear/wallet/build/linux/x64/release/bundle")
dist = "/mnt/c/Users/rgsne/shear/dist"
pkgbuild = "/mnt/c/Users/rgsne/shear/wallet/pack/archlinux/PKGBUILD"

def add_tree(z, root):
    for dp, _dns, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            z.write(p, os.path.relpath(p, root))

linux_out = os.path.join(dist, "shear-wallet-0.0.3-linux.zip")
with zipfile.ZipFile(linux_out, "w", zipfile.ZIP_DEFLATED) as z:
    add_tree(z, bundle)
print("wrote", linux_out, os.path.getsize(linux_out))

arch_out = os.path.join(dist, "shear-wallet-0.0.3-archlinux.zip")
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
    if "shear-miner" not in names:
        sys.exit(f"missing shear-miner in {name}")
    if "archlinux" in name:
        pkg = zipfile.ZipFile(name).read("PKGBUILD").decode()
        if "pkgver=0.0.3" not in pkg:
            sys.exit("arch PKGBUILD not 0.0.3")
print("ok")
PY
