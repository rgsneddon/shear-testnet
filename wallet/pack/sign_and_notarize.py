#!/usr/bin/env python3
"""Developer ID sign, notarize, and staple Shear.app so Gatekeeper will open it.

Ad-hoc Flutter seals trigger: Apple could not verify “Shear” is free of malware.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP = ROOT / "build" / "macos" / "Build" / "Products" / "Release" / "Shear.app"
DEFAULT_IDENTITY = "Developer ID Application: Russell Sneddon (SFCBP95595)"
CODESIGN = "/usr/bin/codesign"
TEAM_ID = "SFCBP95595"
DEFAULT_KEY_DIR = Path.home() / "Library/Developer/perccent-codesign"
ENTITLEMENTS = ROOT / "macos" / "Runner" / "Release.entitlements"
PIN = "0.30"


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def run_capture(cmd: list[str]) -> str:
    print("+", " ".join(cmd), flush=True)
    p = subprocess.run(cmd, check=True, text=True, capture_output=True)
    return (p.stdout or "") + (p.stderr or "")


def sign_path(path: Path, identity: str, entitlements: Path | None) -> None:
    cmd = [
        CODESIGN,
        "--force",
        "--timestamp",
        "--options",
        "runtime",
        "--sign",
        identity,
    ]
    if entitlements is not None:
        cmd.extend(["--entitlements", str(entitlements)])
    cmd.append(str(path))
    run(cmd)


def sign_app(app: Path, identity: str) -> None:
    if not app.is_dir():
        raise FileNotFoundError(f"app not found: {app}")
    if (app / "Contents/MacOS/shear-miner").exists() or (app / "Contents/MacOS/Shear-Miner").exists():
        raise RuntimeError("wallet app must not include Shear-Miner")
    nested: list[Path] = []
    contents = app / "Contents"
    for root, dirs, files in os.walk(contents):
        for d in dirs:
            p = Path(root) / d
            if p.suffix in {".framework", ".appex"}:
                nested.append(p)
        for f in files:
            p = Path(root) / f
            if p.suffix in {".dylib", ".so", ".node"}:
                nested.append(p)
            elif p.name == "node" and p.parent.name == "runtime":
                nested.append(p)
    nested.sort(key=lambda p: len(p.parts), reverse=True)
    seen: set[str] = set()
    for p in nested:
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        if ".framework/" in str(p) and p.suffix != ".framework":
            continue
        sign_path(p, identity, None)
    for p in sorted((app / "Contents/Frameworks").glob("*.framework")):
        sign_path(p, identity, None)
    main_bin = app / "Contents/MacOS/Shear"
    if main_bin.is_file():
        sign_path(main_bin, identity, ENTITLEMENTS)
    _seal_admit_pin(app, identity)
    _verify_team(app)


def _seal_admit_pin(app: Path, identity: str) -> None:
    """Hash libshear_admit.dylib after its signature is final, then seal the app.

    Developer ID re-signing changes the dylib bytes. The sidecar is written
    after that and the app is signed again so the sidecar is inside the seal.
    """
    dylib = app / "Contents" / "Frameworks" / "libshear_admit.dylib"
    stamp = ROOT.parent / "crypto" / "native" / "stamp_admit_pin.py"
    if not dylib.is_file():
        sign_path(app, identity, ENTITLEMENTS)
        return
    side = dylib.with_name(dylib.name + ".sha256")
    for _ in range(3):
        run([sys.executable, str(stamp), str(dylib)])
        sign_path(app, identity, ENTITLEMENTS)
        digest = hashlib.sha256(dylib.read_bytes()).hexdigest()
        if side.is_file() and side.read_text(encoding="utf-8").strip() == digest:
            _verify_team(dylib)
            return
    raise RuntimeError("libshear_admit.dylib hash changed after the app seal")


def _verify_team(path: Path) -> None:
    run([
        CODESIGN,
        "--verify",
        "--strict",
        "--verbose=4",
        "-R",
        f'certificate leaf[subject.OU] = "{TEAM_ID}"',
        str(path),
    ])


def resolve_notary_args() -> list[str]:
    key = os.environ.get("RP_NOTARY_KEY")
    key_id = os.environ.get("RP_NOTARY_KEY_ID")
    issuer = os.environ.get("RP_NOTARY_ISSUER")
    if not key and (DEFAULT_KEY_DIR / "key-id.txt").is_file():
        for line in (DEFAULT_KEY_DIR / "key-id.txt").read_text().splitlines():
            if line.startswith("KEY_ID="):
                key_id = key_id or line.split("=", 1)[1].strip()
            if line.startswith("P8="):
                key = key or line.split("=", 1)[1].strip()
        if not key:
            keys = list(DEFAULT_KEY_DIR.glob("AuthKey_*.p8"))
            if keys:
                key = str(keys[0])
                if not key_id:
                    key_id = keys[0].stem.replace("AuthKey_", "")
    if not issuer and (DEFAULT_KEY_DIR / "issuer-id.txt").is_file():
        issuer = (DEFAULT_KEY_DIR / "issuer-id.txt").read_text().strip()
    if not (key and key_id and issuer):
        raise RuntimeError("notary API key missing under ~/Library/Developer/perccent-codesign/")
    return ["--key", key, "--key-id", key_id, "--issuer", issuer]


def notarize_and_staple(app: Path) -> None:
    creds = resolve_notary_args()
    with tempfile.TemporaryDirectory() as td:
        zip_path = Path(td) / "Shear-for-notary.zip"
        run(["ditto", "-c", "-k", "--keepParent", str(app), str(zip_path)])
        run(["xcrun", "notarytool", "submit", str(zip_path), *creds, "--wait"])
    run(["xcrun", "stapler", "staple", str(app)])
    run(["xcrun", "stapler", "validate", str(app)])


def notarize_artifact(path: Path) -> None:
    creds = resolve_notary_args()
    run(["xcrun", "notarytool", "submit", str(path), *creds, "--wait"])
    run(["xcrun", "stapler", "staple", str(path)])
    run(["xcrun", "stapler", "validate", str(path)])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", type=Path, default=DEFAULT_APP)
    ap.add_argument("--identity", default=DEFAULT_IDENTITY)
    ap.add_argument("--skip-notarize", action="store_true")
    args = ap.parse_args(argv)
    app = args.app.resolve()
    print(f"Signing {app} with {args.identity}", flush=True)
    sign_app(app, args.identity)
    cs = run_capture([CODESIGN, "-dv", "--verbose=4", str(app)])
    print(cs)
    if "Signature=adhoc" in cs:
        print("ERROR: still ad-hoc", file=sys.stderr)
        return 2
    if "Developer ID Application" not in cs:
        print("ERROR: not Developer ID", file=sys.stderr)
        return 2
    ents = run_capture([CODESIGN, "-d", "--entitlements", ":-", str(app)])
    if "get-task-allow" in ents:
        print("ERROR: get-task-allow", file=sys.stderr)
        return 2
    if not args.skip_notarize:
        notarize_and_staple(app)
    return 0


if __name__ == "__main__":
    sys.exit(main())
