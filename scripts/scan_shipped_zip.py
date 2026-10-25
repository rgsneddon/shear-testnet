#!/usr/bin/env python3
"""Scan the native files inside a shipped zip, not the build tree they came from.

Usage: scan_shipped_zip.py <zip> [--built <member>=<path> ...] <member> [<member> ...]

--built asserts the zip member is byte-identical to a file in the build tree,
so tests run on the build tree test what ships.

Each named member must be in the zip. Each is extracted and checked by
scripts/isa_scan.py against the x86-64 baseline, and refused if it links or
imports a 128-bit atomic call (__atomic_*_16, __sync_*_16): the Windows Rust
builds turn CMPXCHG16B off (.cargo/config.toml), and such a call would be a
lock-based fallback, not the instruction.
"""
import os
import re
import subprocess
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import isa_scan  # noqa: E402

ATOMIC_128 = re.compile(r"\b__(atomic|sync)_\w*_16\b")


def atomic_128(path: str) -> list[str]:
    found = set()
    for flag in ("-t", "-p"):
        out = subprocess.run([isa_scan.objdump(), flag, path], capture_output=True, text=True, errors="replace")
        if out.returncode != 0:
            raise SystemExit(f"scan_shipped_zip: objdump {flag} failed on {path}: {out.stderr.strip()}")
        found.update(m.group(0) for m in ATOMIC_128.finditer(out.stdout))
    return sorted(found)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        raise SystemExit(__doc__)
    zpath, rest = argv[0], argv[1:]
    built, members = [], []
    while rest:
        arg = rest.pop(0)
        if arg == "--built":
            member, _, path = rest.pop(0).partition("=")
            built.append((member, path))
        else:
            members.append(arg)
    if not members:
        raise SystemExit(__doc__)
    with zipfile.ZipFile(zpath) as z, tempfile.TemporaryDirectory() as tmp:
        names = set(z.namelist())
        missing = [m for m in members + [b[0] for b in built] if m not in names]
        if missing:
            raise SystemExit(f"scan_shipped_zip: {zpath} is missing {missing}")
        for member, path in built:
            with open(path, "rb") as f:
                if f.read() != z.read(member):
                    raise SystemExit(f"scan_shipped_zip: {member} in the zip is not {path}")
            print(f"scan_shipped_zip: {member} is {path}")
        paths = []
        for m in members:
            out = os.path.join(tmp, m.replace("/", "__"))
            with open(out, "wb") as f:
                f.write(z.read(m))
            paths.append(out)
        rc = isa_scan.main(paths)
        for m, p in zip(members, paths):
            calls = atomic_128(p)
            if calls:
                print(f"scan_shipped_zip: {m}: 128-bit atomic call(s) {calls}", file=sys.stderr)
                rc = 1
        print(f"scan_shipped_zip: {zpath}: {len(members)} member(s) " + ("ok" if rc == 0 else "refused"))
        return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
