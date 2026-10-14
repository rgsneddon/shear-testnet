#!/usr/bin/env python3
"""Write the SHA-256 of a built libshear_admit next to the library.

Pass --dart to also stamp wallet/lib/shear_admit_pin.dart. Desktop bundles
do that. The Android .so keeps only the sidecar so it does not replace the
desktop pin.
"""
import argparse
import hashlib
import pathlib
import sys


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("library")
    p.add_argument("--dart", action="store_true")
    args = p.parse_args()
    lib = pathlib.Path(args.library)
    data = lib.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    lib.with_name(lib.name + ".sha256").write_text(digest + "\n", encoding="utf-8")
    if args.dart:
        root = pathlib.Path(__file__).resolve().parents[2]
        dart = root / "wallet" / "lib" / "shear_admit_pin.dart"
        dart.write_text(
            "/// SHA-256 of the bundled desktop libshear_admit. Stamped by\n"
            "/// crypto/native/stamp_admit_pin.py at bundle time. Empty refuses\n"
            "/// a release load.\n"
            f"const String kShearAdmitSha256 = '{digest}';\n",
            encoding="utf-8",
        )
    sys.stdout.write(digest + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
