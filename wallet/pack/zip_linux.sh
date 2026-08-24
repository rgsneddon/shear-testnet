#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/rgsnedds
BUNDLE="$HOME/src/shear/wallet/build/linux/x64/release/bundle"
DIST="/mnt/c/Users/rgsne/shear/dist"
PKGBUILD="/mnt/c/Users/rgsne/shear/wallet/pack/archlinux/PKGBUILD"
mkdir -p "$DIST"
test -x "$BUNDLE/shear_wallet"
# Wallet zip is GUI only. Official miner is a separate GitHub release.

linux_out="$DIST/shear-wallet-0.0.7-linux.zip"
arch_out="$DIST/shear-wallet-0.0.7-archlinux.zip"
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

linux_out = os.path.join(dist, "shear-wallet-0.0.7-linux.zip")
with zipfile.ZipFile(linux_out, "w", zipfile.ZIP_DEFLATED) as z:
    add_tree(z, bundle)
print("wrote", linux_out, os.path.getsize(linux_out))

arch_out = os.path.join(dist, "shear-wallet-0.0.7-archlinux.zip")
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
    if any(n == "shear-miner" or n.endswith("/shear-miner") or n.endswith("shear-miner.exe") for n in names):
        sys.exit(f"wallet zip must not include miner: {name}")
    if "archlinux" in name:
        pkg = zipfile.ZipFile(name).read("PKGBUILD").decode()
        if "pkgver=0.0.7" not in pkg:
            sys.exit("arch PKGBUILD not 0.0.7")
print("ok")
PY
