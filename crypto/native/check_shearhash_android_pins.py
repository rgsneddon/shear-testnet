#!/usr/bin/env python3
"""Fail unless every shipped ABI's libshearhash.so matches its pin.

The pin is the SHA-256 sidecar next to the library. --define checks that
SHEAR_HASH_SHA256_ANDROID names the same digest for each ABI. --apk checks
the libraries actually packaged under lib/<abi>/libshearhash.so.
"""
import argparse
import hashlib
import sys
import zipfile
from pathlib import Path

ABIS = ("armeabi-v7a", "arm64-v8a", "x86", "x86_64")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_define(text: str) -> dict:
    raw = text.strip()
    flag = "SHEAR_HASH_SHA256_ANDROID="
    at = raw.find(flag)
    if at >= 0:
        raw = raw[at + len(flag):]
    out = {}
    for part in raw.split(","):
        piece = part.strip()
        if "=" not in piece:
            continue
        abi, hexdigest = piece.split("=", 1)
        out[abi.strip()] = hexdigest.strip().lower()
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--jni", required=True, help="jniLibs directory")
    p.add_argument("--define", default="", help="SHEAR_HASH_SHA256_ANDROID value or dart-define line")
    p.add_argument("--apk", default="", help="packaged APK to hash")
    args = p.parse_args()
    jni = Path(args.jni)
    errors = []
    pins = {}
    for abi in ABIS:
        so = jni / abi / "libshearhash.so"
        side = Path(str(so) + ".sha256")
        if not so.is_file():
            errors.append(f"missing {so}")
            continue
        digest = sha256(so)
        if not side.is_file():
            errors.append(f"missing pin sidecar {side}")
            continue
        want = side.read_text(encoding="utf-8").strip().split()[0].lower()
        if want != digest:
            errors.append(f"{abi} sidecar {want} != library {digest}")
        else:
            pins[abi] = digest
    if args.define:
        parsed = parse_define(args.define)
        for abi in ABIS:
            got = parsed.get(abi, "")
            if abi not in pins:
                continue
            if got != pins[abi]:
                errors.append(f"{abi} define {got or 'missing'} != library {pins[abi]}")
        extra = sorted(set(parsed) - set(ABIS))
        if extra:
            errors.append("unknown abi in define: " + ",".join(extra))
    if args.apk:
        apk = Path(args.apk)
        if not apk.is_file():
            errors.append(f"missing apk {apk}")
        else:
            with zipfile.ZipFile(apk) as zf:
                names = set(zf.namelist())
                for abi in ABIS:
                    member = f"lib/{abi}/libshearhash.so"
                    if member not in names:
                        errors.append(f"apk missing {member}")
                        continue
                    digest = hashlib.sha256(zf.read(member)).hexdigest()
                    if abi in pins and digest != pins[abi]:
                        errors.append(f"apk {abi} {digest} != pin {pins[abi]}")
    if errors:
        for err in errors:
            print("REFUSE", err, file=sys.stderr)
        return 1
    print("SHEAR_HASH_ANDROID_PINS_OK", " ".join(f"{abi}={pins[abi][:12]}" for abi in ABIS if abi in pins))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
