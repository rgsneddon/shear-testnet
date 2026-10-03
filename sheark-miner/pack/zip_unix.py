#!/usr/bin/env python3
"""Pack a Unix ShearK-Miner zip built on this machine.

Each zip is one flavor: linux, archlinux, fedora, opensuse, or macos.
The binary must already be ./ShearK-Miner from `make` on that OS.
This script does not cross-compile. It copies libssl and libcrypto beside
the binary and points the loader at that directory, then adds example.bat
and example.sh.
"""
from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.abspath(os.path.dirname(__file__))
MINER = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(MINER, ".."))
BIN = os.path.join(MINER, "ShearK-Miner")
BAT = os.path.join(MINER, "example.bat")
SH = os.path.join(MINER, "example.sh")
DIST = os.path.join(REPO, "dist")

FLAVORS = {
    "linux": "elf",
    "archlinux": "elf",
    "fedora": "elf",
    "opensuse": "elf",
    "macos": "macho",
}


def version() -> str:
    header = os.path.join(MINER, "src", "shear_hash.h")
    text = open(header, encoding="utf-8").read()
    match = re.search(r'#define\s+SHEAR_VERSION\s+"([^"]+)"', text)
    if not match:
        sys.exit("SHEAR_VERSION missing from shear_hash.h")
    return match.group(1)


def kind_of(path: str) -> str:
    head = open(path, "rb").read(4)
    if head[:4] == b"\x7fELF":
        return "elf"
    if len(head) >= 4 and int.from_bytes(head[:4], "big") in (
        0xFEEDFACE,
        0xFEEDFACF,
        0xCAFEBABE,
        0xCEFAEDFE,
        0xCFFAEDFE,
        0xBEBAFECA,
    ):
        return "macho"
    if head[:2] == b"MZ":
        return "pe"
    return "other"


def unix_info(arcname: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(arcname)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (mode & 0xFFFF) << 16
    return info


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        sys.exit(f"{' '.join(cmd)} failed: {result.stderr or result.stdout}")
    return result.stdout


def bundle_elf(binary: str, stage: str) -> list[str]:
    if not shutil.which("patchelf") or not shutil.which("ldd"):
        sys.exit("patchelf and ldd are required to pack a linux-family zip")
    found: dict[str, str] = {}
    for line in run(["ldd", binary]).splitlines():
        match = re.match(r"\s*(lib(?:ssl|crypto)\.so\S*)\s+=>\s+(\S+)", line)
        if not match:
            continue
        name, path = match.group(1), match.group(2)
        if path == "not":
            sys.exit(f"{name} is not installed on this machine")
        found[name] = path
    if not any(name.startswith("libssl") for name in found):
        sys.exit("binary does not link libssl; refusing a cleartext pack")
    if not any(name.startswith("libcrypto") for name in found):
        sys.exit("binary does not link libcrypto; refusing a cleartext pack")
    staged = os.path.join(stage, "ShearK-Miner")
    shutil.copy2(binary, staged)
    os.chmod(staged, 0o755)
    copied = [staged]
    for name, path in sorted(found.items()):
        dest = os.path.join(stage, name)
        shutil.copy2(path, dest)
        os.chmod(dest, 0o644)
        run(["patchelf", "--set-rpath", "$ORIGIN", dest])
        copied.append(dest)
    run(["patchelf", "--set-rpath", "$ORIGIN", staged])
    return copied


def macho_deps(path: str) -> list[str]:
    deps = []
    for line in run(["otool", "-L", path]).splitlines()[1:]:
        match = re.match(r"\s+(\S+)\s+\(compatibility version", line)
        if match:
            deps.append(match.group(1))
    return deps


def bundle_macho(binary: str, stage: str) -> list[str]:
    for tool in ("otool", "install_name_tool", "codesign"):
        if not shutil.which(tool):
            sys.exit(f"{tool} is required to pack the macOS zip")
    want = []
    for src in macho_deps(binary):
        base = os.path.basename(src)
        if base.startswith("libssl") or base.startswith("libcrypto"):
            if not os.path.isfile(src):
                sys.exit(f"missing {src}")
            want.append((src, base))
    if not any(base.startswith("libssl") for _, base in want):
        sys.exit("macOS binary does not link libssl; refusing a cleartext pack")
    if not any(base.startswith("libcrypto") for _, base in want):
        sys.exit("macOS binary does not link libcrypto; refusing a cleartext pack")
    staged = os.path.join(stage, "ShearK-Miner")
    shutil.copy2(binary, staged)
    os.chmod(staged, 0o755)
    copied = [staged]
    staged_libs = []
    for src, base in want:
        dest = os.path.join(stage, base)
        shutil.copy2(src, dest)
        os.chmod(dest, 0o755)
        staged_libs.append(dest)
        copied.append(dest)
    for dest in staged_libs:
        base = os.path.basename(dest)
        run(["install_name_tool", "-id", f"@executable_path/{base}", dest])
        for dep in macho_deps(dest):
            dep_base = os.path.basename(dep)
            if dep.startswith("@executable_path/"):
                continue
            if dep_base.startswith("libssl") or dep_base.startswith("libcrypto"):
                run(["install_name_tool", "-change", dep, f"@executable_path/{dep_base}", dest])
    for src, base in want:
        run(["install_name_tool", "-change", src, f"@executable_path/{base}", staged])
    for path in staged_libs:
        run(["codesign", "--force", "--sign", "-", path])
    run(["codesign", "--force", "--sign", "-", staged])
    return copied


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1 or args[0] not in FLAVORS:
        sys.exit(f"usage: zip_unix.py {'|'.join(FLAVORS)}")
    flavor = args[0]
    expect = FLAVORS[flavor]
    if not os.path.isfile(BIN):
        sys.exit(f"missing {BIN}; build ShearK-Miner on this OS first")
    if not os.path.isfile(BAT) or not os.path.isfile(SH):
        sys.exit("missing example.bat or example.sh")
    got = kind_of(BIN)
    if got != expect:
        sys.exit(f"{flavor} pack expected {expect}, found {got}. Refusing a cross-compile.")
    os.makedirs(DIST, exist_ok=True)
    ver = version()
    out = os.path.join(DIST, f"ShearK-Miner-{ver}-{flavor}.zip")
    with tempfile.TemporaryDirectory(prefix=f"sheark-{flavor}-") as stage:
        bundled = bundle_elf(BIN, stage) if expect == "elf" else bundle_macho(BIN, stage)
        if os.path.exists(out):
            os.remove(out)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zipped:
            for path in bundled:
                mode = stat.S_IMODE(os.stat(path).st_mode)
                zipped.writestr(unix_info(os.path.basename(path), mode), open(path, "rb").read())
            bat = open(BAT, "rb").read().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            zipped.writestr("example.bat", bat)
            sh = open(SH, "rb").read().replace(b"\r\n", b"\n")
            zipped.writestr(unix_info("example.sh", 0o755), sh)
            note = (
                f"ShearK-Miner {ver} ({flavor})\n"
                "Keep ShearK-Miner next to the OpenSSL libraries in this zip.\n"
                "Sample launchers in this zip: example.bat and example.sh.\n"
                "Edit example.sh, chmod +x ShearK-Miner example.sh, then ./example.sh.\n"
                "Public pool: stratum+ssl://pool.shear.digital:443\n"
                "Localhost solo: stratum+tcp://127.0.0.1:1111\n"
                "Do not pass --tls-pin. There is no --tls-insecure.\n"
                "Use the zip built for this operating system.\n"
            )
            zipped.writestr("README.txt", note)
        names = zipfile.ZipFile(out).namelist()
    for need in ("ShearK-Miner", "example.bat", "example.sh"):
        if need not in names:
            sys.exit(f"{out} missing {need}: {names}")
    if not any(name.startswith("libssl") for name in names):
        sys.exit(f"{out} missing libssl")
    if not any(name.startswith("libcrypto") for name in names):
        sys.exit(f"{out} missing libcrypto")
    print("wrote", out, "members", " ".join(names))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
