#!/usr/bin/env python3
"""Fail when a wallet release artifact does not contain libshear_v3.

An APK must carry lib/<abi>/libshear_v3.so for every ABI it already ships.
A desktop zip must carry lib/libshear_v3.so, shear_v3.dll, or
Contents/Frameworks/libshear_v3.dylib.
"""
import sys
import zipfile
from pathlib import Path


def members(path: Path) -> set[str]:
    with zipfile.ZipFile(path) as z:
        return set(z.namelist())


def missing(path: Path) -> list[str]:
    names = members(path)
    suffix = path.suffix.lower()
    if suffix == ".apk":
        abis = set()
        for name in names:
            parts = name.split("/")
            if len(parts) >= 3 and parts[0] == "lib" and parts[2].endswith(".so"):
                abis.add(parts[1])
        if not abis:
            abis.add("arm64-v8a")
        want = [f"lib/{abi}/libshear_v3.so" for abi in sorted(abis)]
        return [item for item in want if item not in names]
    if suffix == ".zip":
        markers = (
            "lib/libshear_v3.so",
            "shear_v3.dll",
            "libshear_v3.dylib",
        )
        if any(any(name == marker or name.endswith("/" + marker) for name in names) for marker in markers):
            return []
        return ["libshear_v3 (lib/libshear_v3.so, shear_v3.dll, or Frameworks/libshear_v3.dylib)"]
    return [f"unknown artifact {path.name}"]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: check_shear_v3_bundled.py <apk-or-zip>")
    path = Path(sys.argv[1])
    if not path.is_file():
        raise SystemExit(f"missing {path}")
    gone = missing(path)
    if gone:
        for item in gone:
            print("REFUSE missing", item)
        raise SystemExit(1)
    print("SHEAR_V3_BUNDLED_OK", path.name)


if __name__ == "__main__":
    main()
