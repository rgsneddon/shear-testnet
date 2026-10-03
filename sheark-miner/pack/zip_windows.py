#!/usr/bin/env python3
"""Bundle ShearK-Miner.exe with the DLLs it actually imports.

The Windows link is dynamic OpenSSL (libssl-3-x64.dll, libcrypto-3-x64.dll)
plus any further non-system DLL those import. A zip of the exe alone does
not start. --stage copies that runtime beside the exe. The default writes
dist/ShearK-Miner-<version>-windows.zip at the repo root.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.abspath(os.path.dirname(__file__))
MINER = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(MINER, ".."))
EXE = os.path.join(MINER, "ShearK-Miner.exe")
BAT = os.path.join(MINER, "example.bat")
SH = os.path.join(MINER, "example.sh")
DIST = os.path.join(REPO, "dist")
OPENSSL_BIN = os.environ.get("OPENSSL_BIN", r"C:\msys64\mingw64\bin")

# Windows loader already has these. Do not ship System32 binaries.
SYSTEM = {
    "kernel32.dll",
    "kernelbase.dll",
    "ntdll.dll",
    "user32.dll",
    "gdi32.dll",
    "advapi32.dll",
    "sechost.dll",
    "rpcrt4.dll",
    "ws2_32.dll",
    "wsock32.dll",
    "crypt32.dll",
    "bcrypt.dll",
    "bcryptprimitives.dll",
    "msvcrt.dll",
    "ucrtbase.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "shell32.dll",
    "ole32.dll",
    "oleaut32.dll",
    "combase.dll",
    "shlwapi.dll",
    "iphlpapi.dll",
    "dnsapi.dll",
    "mswsock.dll",
    "nsi.dll",
    "setupapi.dll",
    "cfgmgr32.dll",
    "wintrust.dll",
    "cryptbase.dll",
    "imm32.dll",
    "normaliz.dll",
    "psapi.dll",
    "version.dll",
    "userenv.dll",
    "wldap32.dll",
    "secur32.dll",
    "sspicli.dll",
    "cryptsp.dll",
    "rsaenh.dll",
    "ncrypt.dll",
    "ntasn1.dll",
    "imagehlp.dll",
    "dbghelp.dll",
    "powrprof.dll",
    "umpdc.dll",
}


def version() -> str:
    header = os.path.join(MINER, "src", "shear_hash.h")
    text = open(header, encoding="utf-8").read()
    m = re.search(r'#define\s+SHEAR_VERSION\s+"([^"]+)"', text)
    if not m:
        sys.exit("SHEAR_VERSION missing from shear_hash.h")
    return m.group(1)


def search_dirs() -> list[str]:
    dirs = [MINER, OPENSSL_BIN]
    gcc = shutil.which("gcc")
    if gcc:
        dirs.append(os.path.dirname(os.path.abspath(gcc)))
    out = []
    for d in dirs:
        if d and os.path.isdir(d) and d not in out:
            out.append(d)
    return out


def objdump() -> str:
    found = shutil.which("objdump")
    if found:
        return found
    gcc = shutil.which("gcc")
    if gcc:
        cand = os.path.join(os.path.dirname(os.path.abspath(gcc)), "objdump.exe")
        if os.path.isfile(cand):
            return cand
    sys.exit("objdump missing; cannot list ShearK DLL imports")


def pe_imports(path: str) -> list[str]:
    r = subprocess.run(
        [objdump(), "-p", path],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if r.returncode != 0:
        sys.exit(f"objdump failed for {path}: {r.stderr}")
    names = []
    for line in r.stdout.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("dll name:"):
            names.append(stripped.split(":", 1)[1].strip())
    if not names:
        sys.exit(f"objdump listed no DLL imports for {path}")
    return names


def is_system(name: str) -> bool:
    low = name.lower()
    if low.startswith("api-ms-win-"):
        return True
    return low in SYSTEM


def find_dll(name: str) -> str | None:
    for d in search_dirs():
        cand = os.path.join(d, name)
        if os.path.isfile(cand):
            return cand
    return None


def runtime_dlls(exe: str) -> list[str]:
    """Absolute paths of non-system DLLs reachable from exe, exe-dir first."""
    queue = [exe]
    seen_pe: set[str] = set()
    found: list[str] = []
    seen_name: set[str] = set()
    while queue:
        pe = queue.pop(0)
        key = os.path.normcase(os.path.abspath(pe))
        if key in seen_pe:
            continue
        seen_pe.add(key)
        for name in pe_imports(pe):
            if is_system(name):
                continue
            low = name.lower()
            if low in seen_name:
                continue
            src = find_dll(name)
            if not src:
                sys.exit(
                    f"{os.path.basename(pe)} imports {name}, which is not beside the exe, "
                    f"in {OPENSSL_BIN}, or beside gcc. Refusing a pack that would not start."
                )
            seen_name.add(low)
            found.append(src)
            queue.append(src)
    return found


def stage(exe: str, dlls: list[str]) -> None:
    for src in dlls:
        dest = os.path.join(MINER, os.path.basename(src))
        if os.path.normcase(os.path.abspath(src)) == os.path.normcase(os.path.abspath(dest)):
            continue
        shutil.copy2(src, dest)


def crlf(path: str) -> bytes:
    data = open(path, "rb").read().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    return data


def lf(path: str) -> bytes:
    return open(path, "rb").read().replace(b"\r\n", b"\n")


def unix_info(arcname: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(arcname)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (mode & 0xFFFF) << 16
    return info


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not os.path.isfile(EXE):
        sys.exit(f"missing {EXE}; build ShearK-Miner.exe first")
    if not os.path.isfile(BAT):
        sys.exit(f"missing {BAT}")
    if not os.path.isfile(SH):
        sys.exit(f"missing {SH}")
    dlls = runtime_dlls(EXE)
    names = {os.path.basename(p).lower() for p in dlls}
    for required in ("libssl-3-x64.dll", "libcrypto-3-x64.dll"):
        if required not in names:
            sys.exit(f"ShearK TLS build did not import {required}; refusing a cleartext-only pack")
    stage(EXE, dlls)
    if args == ["--stage"]:
        print("staged", " ".join(os.path.basename(p) for p in dlls))
        return 0
    if args:
        sys.exit(f"unknown args {args}")
    os.makedirs(DIST, exist_ok=True)
    ver = version()
    out = os.path.join(DIST, f"ShearK-Miner-{ver}-windows.zip")
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(EXE, "ShearK-Miner.exe")
        z.writestr("example.bat", crlf(BAT))
        z.writestr(unix_info("example.sh", 0o755), lf(SH))
        for src in dlls:
            z.write(src, os.path.basename(src))
        note = (
            f"ShearK-Miner {ver}\n"
            "Keep every DLL in this zip next to ShearK-Miner.exe.\n"
            "Sample launchers in this zip: example.bat and example.sh.\n"
            "Windows: edit example.bat, then double-click it.\n"
            "Public pool: stratum+ssl://pool.shear.digital:443\n"
            "Localhost solo: stratum+tcp://127.0.0.1:1111\n"
            "Do not pass --tls-pin. There is no --tls-insecure.\n"
        )
        z.writestr("README.txt", note.replace("\n", "\r\n"))
    listed = zipfile.ZipFile(out).namelist()
    print("wrote", out, "members", " ".join(listed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
