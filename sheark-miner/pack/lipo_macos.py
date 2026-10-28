#!/usr/bin/env python3
"""Join an arm64 and an x86_64 ShearK-Miner macOS zip into one universal zip.

Each input is the zip `zip_unix.py macos` wrote on that architecture's own
runner (built, selftested and bundled there; nothing is cross-compiled). Every
Mach-O file in both (the miner, libssl, libcrypto, libsodium) is joined with
lipo and must then carry exactly arm64 and x86_64. Every other file must be
byte-identical in both zips. The result is ad-hoc signed only: Developer ID
signing, notarisation and stapling run on Russell's Mac
(Desktop HANDOFF-Apple-R28-libsodium.md), never in CI.

usage: lipo_macos.py ARM64.zip X86_64.zip OUT.zip
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

MACHO = (0xFEEDFACE, 0xFEEDFACF, 0xCAFEBABE, 0xCEFAEDFE, 0xCFFAEDFE, 0xBEBAFECA)


def run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"{' '.join(cmd)} failed: {r.stderr.strip()}")
    return r.stdout


def is_macho(path: str) -> bool:
    with open(path, "rb") as f:
        head = f.read(4)
    return len(head) == 4 and int.from_bytes(head, "big") in MACHO


def unpack(zip_path: str, into: str) -> dict[str, int]:
    modes = {}
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            z.extract(info, into)
            modes[info.filename] = (info.external_attr >> 16) & 0o777
    return modes


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.exit(__doc__)
    arm_zip, x86_zip, out = argv
    for tool in ("lipo", "codesign"):
        if not shutil.which(tool):
            sys.exit(f"{tool} is required")
    with tempfile.TemporaryDirectory(prefix="sheark-universal-") as tmp:
        arm, x86, uni = (os.path.join(tmp, d) for d in ("arm64", "x86_64", "universal"))
        arm_modes = unpack(arm_zip, arm)
        x86_modes = unpack(x86_zip, x86)
        if set(arm_modes) != set(x86_modes):
            sys.exit(f"the two zips list different files: {sorted(set(arm_modes) ^ set(x86_modes))}")
        os.makedirs(uni)
        joined = []
        for name in sorted(arm_modes):
            a, b, dest = os.path.join(arm, name), os.path.join(x86, name), os.path.join(uni, name)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if is_macho(a) != is_macho(b):
                sys.exit(f"{name} is Mach-O in only one zip")
            if is_macho(a):
                if run(["lipo", "-archs", a]).split() != ["arm64"]:
                    sys.exit(f"{name} in the arm64 zip is not arm64-only")
                if run(["lipo", "-archs", b]).split() != ["x86_64"]:
                    sys.exit(f"{name} in the x86_64 zip is not x86_64-only")
                run(["lipo", "-create", a, b, "-output", dest])
                if sorted(run(["lipo", "-archs", dest]).split()) != ["arm64", "x86_64"]:
                    sys.exit(f"{name} is not universal after lipo")
                joined.append(name)
            else:
                if open(a, "rb").read() != open(b, "rb").read():
                    sys.exit(f"{name} differs between the arm64 and x86_64 zips")
                shutil.copy2(a, dest)
            os.chmod(dest, arm_modes[name])
        if "ShearK-Miner" not in joined or not any(n.startswith("libsodium") for n in joined):
            sys.exit(f"universal zip lacks the miner or libsodium: {joined}")
        # Ad-hoc only: libraries first, then the miner that loads them.
        for name in sorted(joined, key=lambda n: n == "ShearK-Miner"):
            run(["codesign", "--force", "--sign", "-", os.path.join(uni, name)])
        if os.path.exists(out):
            os.remove(out)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for name in sorted(arm_modes):
                info = zipfile.ZipInfo(name)
                info.external_attr = (stat.S_IFREG | arm_modes[name]) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, open(os.path.join(uni, name), "rb").read())
    print("universal:", ", ".join(joined), "->", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
