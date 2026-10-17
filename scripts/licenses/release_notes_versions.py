#!/usr/bin/env python3
"""Print the "Bundled runtime versions" section for a release's notes.

usage: release_notes_versions.py ASSET...

Each zip or tarball must carry RUNTIME-VERSIONS.txt if it bundles Node.js,
libsodium or OpenSSL. An APK is reported from wallet/android/libsodium.lock.json
(check_android_release.py verifies the APK carries that exact build).
"""
from __future__ import annotations

import os
import re
import sys
import tarfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import release_notices  # noqa: E402

RUNTIME_BASENAME = re.compile(r"^(node|node\.exe|libsodium[.-].*|lib(ssl|crypto)[.-].*)$")


def members(path: str) -> tuple[list[str], callable]:
    if zipfile.is_zipfile(path):
        z = zipfile.ZipFile(path)
        return z.namelist(), lambda n: z.read(n)
    t = tarfile.open(path)
    return t.getnames(), lambda n: t.extractfile(n).read()


def section(path: str) -> str:
    name = os.path.basename(path)
    if name.endswith(".apk"):
        comp, ver, src = release_notices.android_libsodium_row(REPO)
        return f"### {name}\n\n```\n{comp}: {ver} [{src}]\n```\n"
    names, read = members(path)
    found = [n for n in names if n.rstrip("/").split("/")[-1] == release_notices.RUNTIME_VERSIONS]
    if found:
        text = read(found[0]).decode("utf-8").replace("\r\n", "\n")
        rows = [line for line in text.splitlines() if ": " in line and "[" in line]
        return f"### {name}\n\n```\n" + "\n".join(rows) + "\n```\n"
    bundled = [n for n in names if RUNTIME_BASENAME.match(n.rstrip("/").split("/")[-1])]
    if bundled:
        raise SystemExit(f"{name} bundles {', '.join(bundled[:3])} but has no {release_notices.RUNTIME_VERSIONS}")
    return f"### {name}\n\nNo bundled Node.js, libsodium or OpenSSL.\n"


def main(argv: list[str]) -> int:
    if not argv:
        raise SystemExit(__doc__)
    out = ["## Bundled runtime versions", ""]
    out += [section(p) for p in argv]
    sys.stdout.write("\n".join(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
