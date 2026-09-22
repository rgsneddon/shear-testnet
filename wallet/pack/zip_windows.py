#!/usr/bin/env python3
"""Pack the Flutter Windows release tree into shear-wallet-<pin>-windows.zip.

Wallet zip is GUI only. Official miner is a separate GitHub release.
"""
from __future__ import annotations

import os
import sys
import zipfile

_PACK = os.path.abspath(os.path.dirname(__file__))
_WALLET_ROOT = os.path.abspath(os.path.join(_PACK, ".."))
# Monorepo (shear/wallet/pack) vs release repo (shear-wallet/pack).
if os.path.isfile(os.path.join(_WALLET_ROOT, "lib", "main.dart")):
    REPO = _WALLET_ROOT
    BUNDLE = os.path.join(REPO, "build", "windows", "x64", "runner", "Release")
    DIST = os.path.join(REPO, "dist")
    MAIN_DART = os.path.join(REPO, "lib", "main.dart")
else:
    REPO = os.path.abspath(os.path.join(_PACK, "..", ".."))
    BUNDLE = os.path.join(REPO, "wallet", "build", "windows", "x64", "runner", "Release")
    DIST = os.path.join(REPO, "dist")
    MAIN_DART = os.path.join(REPO, "wallet", "lib", "main.dart")
EXE_NAME = "shear_wallet.exe"
MINER_BASENAMES = {
    "shear-miner.exe",
    "shear-miner",
    "shear-miner.bat",
    "sheark-miner.exe",
    "sheark-miner",
}

def public_pin() -> str:
    """Zip and tag are major.minor. The in-app string may add a patch."""
    with open(MAIN_DART, encoding="utf-8") as f:
        for line in f:
            if "kWalletVersion" in line and "=" in line:
                raw = line.split("'")[1]
                parts = raw.split(".")
                if len(parts) >= 3:
                    return ".".join(parts[:2])
                return raw
    return os.environ.get("SHEAR_WALLET_PIN", "0.32")


PUBLIC_PIN = public_pin()
OUT_NAME = f"shear-wallet-{PUBLIC_PIN}-windows.zip"


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
