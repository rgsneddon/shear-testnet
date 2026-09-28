#!/usr/bin/env python3
"""Pack the Flutter Windows release tree into shear-wallet-<pin>-windows.zip.

Wallet zip is GUI only. Official miner is a separate GitHub release.
"""
from __future__ import annotations

import os
import shutil
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
    """Asset name is the full kWalletVersion, so 0.55.2 does not reuse the 0.55 zip."""
    with open(MAIN_DART, encoding="utf-8") as f:
        for line in f:
            if "kWalletVersion" in line and "=" in line:
                return line.split("'")[1]
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
        node_root = os.path.abspath(os.path.join(os.path.dirname(MAIN_DART), "..", ".."))
        node_src = os.path.join(node_root, "node", "src", "node.js")
        if os.path.isfile(node_src):
            for dp, dns, fns in os.walk(os.path.join(node_root, "node", "src")):
                dns[:] = [d for d in dns if d not in {".git", "node_modules"}]
                for fn in fns:
                    p = os.path.join(dp, fn)
                    rel = os.path.relpath(p, node_root).replace("\\", "/")
                    z.write(p, rel)
            crypto = os.path.join(node_root, "crypto")
            if os.path.isdir(crypto):
                for dp, dns, fns in os.walk(crypto):
                    dns[:] = [d for d in dns if d not in {"target", "randomx", "node_modules", ".git"}]
                    for fn in fns:
                        if fn.endswith((".obj", ".o", ".pdb")):
                            continue
                        p = os.path.join(dp, fn)
                        rel = os.path.relpath(p, node_root).replace("\\", "/")
                        z.write(p, rel)
            for extra in (
                "package.json",
                "package-lock.json",
                "pool/src/wallet_api.js",
                "pool/src/hash_credit.js",
                "pool/src/withdraw_state.js",
                "contracts/Reserve.json",
            ):
                p = os.path.join(node_root, extra.replace("/", os.sep))
                if os.path.isfile(p):
                    z.write(p, extra)
            node_exe = os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "nodejs", "node.exe")
            if os.path.isfile(node_exe):
                z.write(node_exe, "runtime/node.exe")
            gcc = shutil.which("gcc")
            mingw = os.path.dirname(os.path.abspath(gcc)) if gcc else ""
            for dll in ("libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"):
                src = os.path.join(mingw, dll)
                if not os.path.isfile(src):
                    sys.exit(f"Continuum sidecar needs MinGW {dll} beside gcc")
                z.write(src, f"runtime/{dll}")
            print("bundled SHEAR-NODEv8 beside Continuum")

    size = os.path.getsize(out)
    names = zipfile.ZipFile(out).namelist()
    print("wrote", out, "bytes", size)
    for n in names:
        print(" ", n)

    if size < 1_000_000:
        sys.exit(f"refusing tiny zip {out}")
    if EXE_NAME not in names:
        sys.exit(f"missing {EXE_NAME} at zip root")
    if "node/src/node.js" not in names:
        sys.exit("Continuum zip must include node/src/node.js (SHEAR-NODEv8 sidecar)")
    if "runtime/node.exe" not in names:
        sys.exit("Continuum zip must include runtime/node.exe")
    if "crypto/native/shearhash.node" not in names:
        sys.exit("Continuum zip must include crypto/native/shearhash.node")
    for dll in ("runtime/libgcc_s_seh-1.dll", "runtime/libstdc++-6.dll", "runtime/libwinpthread-1.dll"):
        if dll not in names:
            sys.exit(f"Continuum zip must include {dll}")
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
