#!/usr/bin/env python3
"""Write the SHA-256 of a built libshearhash next to the library.

--define prints `--dart-define=SHEAR_HASH_SHA256=<hex>` for a flutter build.
--android-define reads jniLibs/<abi>/libshearhash.so for every shipped ABI
and prints `--dart-define=SHEAR_HASH_SHA256_ANDROID=abi=hex,...`.
This script does not edit Dart source.
"""
import argparse
import hashlib
import pathlib
import sys

ANDROID_ABIS = ("armeabi-v7a", "arm64-v8a", "x86", "x86_64")


def digest_of(lib: pathlib.Path) -> str:
    data = lib.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    lib.with_name(lib.name + ".sha256").write_text(digest + "\n", encoding="utf-8")
    return digest


def android_define(jni: pathlib.Path) -> str:
    parts = []
    for abi in ANDROID_ABIS:
        lib = jni / abi / "libshearhash.so"
        if not lib.is_file():
            raise SystemExit(f"missing {lib}")
        parts.append(f"{abi}={digest_of(lib)}")
    return ",".join(parts)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("library", help="one library, or the jniLibs directory with --android-define")
    p.add_argument(
        "--define",
        action="store_true",
        help="print --dart-define=SHEAR_HASH_SHA256=<hex>",
    )
    p.add_argument(
        "--android-define",
        action="store_true",
        help="print --dart-define=SHEAR_HASH_SHA256_ANDROID=abi=hex,...",
    )
    args = p.parse_args()
    lib = pathlib.Path(args.library)
    if args.android_define:
        text = android_define(lib)
        sys.stdout.write(f"--dart-define=SHEAR_HASH_SHA256_ANDROID={text}\n")
        return 0
    digest = digest_of(lib)
    if args.define:
        sys.stdout.write(f"--dart-define=SHEAR_HASH_SHA256={digest}\n")
    else:
        sys.stdout.write(digest + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
