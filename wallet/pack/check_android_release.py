#!/usr/bin/env python3
"""Refuse a Continuum release APK whose signer, package, or versionCode is wrong.

The pin is the public cert fingerprint in wallet/android/release-cert-sha256.txt.
Last published versionCode before Continuum 0.71 was 95. This cut is 96. This does not build or sign anything.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PACKAGE = "com.shear.shear_wallet"
MIN_VERSION_CODE = 92
FAT_ABIS = ("armeabi-v7a", "arm64-v8a", "x86_64")


def normalize_sha256(text):
    raw = text or ""
    colon = re.search(r"(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}", raw)
    if colon:
        return colon.group(0).replace(":", "").lower()
    compact = re.search(r"\b([0-9a-fA-F]{64})\b", raw)
    if compact:
        return compact.group(1).lower()
    return ""


def sdk_tool(name):
    env = os.environ.get("APKSIGNER" if name.startswith("apksigner") else "AAPT")
    if env and Path(env).exists():
        return env
    roots = []
    for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(key):
            roots.append(Path(os.environ[key]))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        roots.append(Path(local) / "Android" / "Sdk")
    found = []
    for root in roots:
        tools = root / "build-tools"
        if not tools.is_dir():
            continue
        for directory in sorted(tools.iterdir(), reverse=True):
            for candidate in (directory / name, directory / (name + ".bat"), directory / (name + ".exe")):
                if candidate.is_file():
                    found.append(str(candidate))
    if found:
        return found[0]
    which = shutil.which(name) or shutil.which(name + ".bat")
    if which:
        return which
    raise SystemExit("missing " + name)


def dump_badging(apk):
    proc = subprocess.run(
        [sdk_tool("aapt"), "dump", "badging", str(apk)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit("aapt failed: " + (proc.stderr or "")[-400:])
    return proc.stdout


def dump_certs(apk):
    proc = subprocess.run(
        [sdk_tool("apksigner"), "verify", "--print-certs", str(apk)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit("apksigner failed: " + (proc.stderr or proc.stdout or "")[-400:])
    return proc.stdout


def gate(apk, pin_text, badging, certs, min_version_code=MIN_VERSION_CODE):
    errors = []
    package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    if not package:
        errors.append("badging has no package line")
        name, code, ver = "", "0", ""
    else:
        name, code, ver = package.group(1), package.group(2), package.group(3)
    if name != PACKAGE:
        errors.append("applicationId %s != %s" % (name or "missing", PACKAGE))
    version_code = int(code or "0")
    if version_code <= min_version_code:
        errors.append("versionCode %s is not above %s" % (version_code, min_version_code))
    native = re.search(r"native-code: (.+)", badging)
    abis = set(native.group(1).replace("'", "").split()) if native else set()
    missing = [abi for abi in FAT_ABIS if abi not in abis]
    if missing:
        errors.append("not a fat sideload APK, missing " + ",".join(missing))
    if "Android Debug" in certs or "CN=Android Debug" in certs:
        errors.append("debug signer")
    got = ""
    for line in certs.splitlines():
        if "SHA-256" in line or "sha-256" in line.lower():
            got = normalize_sha256(line)
            if got:
                break
    pin = normalize_sha256(pin_text)
    if not pin:
        errors.append("pin file has no SHA-256")
    elif got != pin:
        errors.append("cert SHA-256 mismatch")
    return errors, {
        "package": name,
        "versionCode": version_code,
        "versionName": ver,
        "abis": sorted(abis),
        "sha256": got,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("apk")
    parser.add_argument("--pin-file", default="")
    parser.add_argument("--min-version-code", type=int, default=MIN_VERSION_CODE)
    args = parser.parse_args()
    apk = Path(args.apk)
    if not apk.is_file():
        raise SystemExit("missing apk")
    if args.pin_file:
        pin_path = Path(args.pin_file)
    else:
        pin_path = Path(__file__).resolve().parents[1] / "android" / "release-cert-sha256.txt"
    pin_text = pin_path.read_text(encoding="utf-8")
    errors, info = gate(
        apk,
        pin_text,
        dump_badging(apk),
        dump_certs(apk),
        args.min_version_code,
    )
    print("package", info["package"])
    print("versionCode", info["versionCode"])
    print("versionName", info["versionName"])
    print("abis", " ".join(info["abis"]))
    print("sha256", info["sha256"])
    if errors:
        for err in errors:
            print("REFUSE", err)
        raise SystemExit(1)
    print("ANDROID_RELEASE_OK")


if __name__ == "__main__":
    main()
