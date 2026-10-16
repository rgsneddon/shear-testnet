#!/usr/bin/env python3
"""Write the SHA-256 of a built libshearhash next to the library.

--define prints `--dart-define=SHEAR_HASH_SHA256=<hex>` for a flutter build.
This script does not edit Dart source.
"""
import argparse
import hashlib
import pathlib
import sys


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("library")
    p.add_argument(
        "--define",
        action="store_true",
        help="print --dart-define=SHEAR_HASH_SHA256=<hex>",
    )
    args = p.parse_args()
    lib = pathlib.Path(args.library)
    data = lib.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    lib.with_name(lib.name + ".sha256").write_text(digest + "\n", encoding="utf-8")
    if args.define:
        sys.stdout.write(f"--dart-define=SHEAR_HASH_SHA256={digest}\n")
    else:
        sys.stdout.write(digest + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
