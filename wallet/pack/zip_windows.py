#!/usr/bin/env python3
"""Pack the Flutter Windows release tree into shear-wallet-0.6-windows.zip.

Wallet zip is GUI only. Official miner is a separate GitHub release (1.1 / 1.0).
"""
from __future__ import annotations

import os
import sys
import zipfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BUNDLE = os.path.join(REPO, "wallet", "build", "windows", "x64", "runner", "Release")
DIST = os.path.join(REPO, "dist")
OUT_NAME = "shear-wallet-0.6-windows.zip"
EXE_NAME = "shear_wallet.exe"
MINER_BASENAMES = {
    "shear-miner.exe",
    "shear-miner",
    "shear-miner.bat",
    "sheark-miner.exe",
    "sheark-miner",
}

# Keep the public pin two-part 0.6. Flutter file version 0.6.0+N is not the pin.
PUBLIC_PIN = "0.6"


def add_tree(z: zipfile.ZipFile, root: str) -> None:
    for dp, _dns, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            z.write(p, os.path.relpath(p, root).replace("\\", "/"))


def main() -> int:
    exe = os.path.join(BUNDLE, EXE_NAME)
    if not os.path.isfile(exe):
        sys.exit(f"missing Flutter runner {exe} — run flutter build windows --release first")

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, OUT_NAME)
    if os.path.exists(out):
        os.remove(out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        add_tree(z, BUNDLE)

    size = os.path.getsize(out)
    names = zipfile.ZipFile(out).namelist()
    print("wrote", out, "bytes", size)
    for n in names:
        print(" ", n)

    if size < 1_000_000:
        sys.exit(f"refusing tiny zip {out}")
    if EXE_NAME not in names:
        sys.exit(f"missing {EXE_NAME} at zip root")
    banned = []
    for n in names:
        base = n.replace("\\", "/").rstrip("/").split("/")[-1].lower()
        if base in MINER_BASENAMES:
            banned.append(n)
    if banned:
        sys.exit(f"wallet zip must not include miner: {banned}")
    print("ok", OUT_NAME, "pin", PUBLIC_PIN)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
