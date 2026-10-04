#!/usr/bin/env python3
"""Copy the node sidecar beside a Mac wallet executable.

Connect bare, p2p node, and full node start this runtime. The layout matches
the Windows zip: runtime/node and node/src/node.js next to the executable.
Call this before codesign. A later copy breaks the Developer ID seal.

This does not build Shear Sentinel, does not build ShearK, and does not
write a node archive.
"""
from __future__ import annotations

import os
import shutil
import sys


def stage_app_sidecar(dest: str, repo: str) -> None:
    repo = os.path.abspath(repo)
    dest = os.path.abspath(dest)
    os.makedirs(dest, exist_ok=True)
    addon = os.path.join(repo, "crypto", "native", "shearhash.node")
    if not os.path.isfile(addon):
        raise SystemExit(
            "Mac sidecar needs crypto/native/shearhash.node built on this Mac "
            "(make -C crypto/native shearhash.node). Do not copy another OS addon."
        )

    def copy_tree(root: str, arc_prefix: str, skip_dirs: set[str]) -> None:
        if not os.path.isdir(root):
            raise SystemExit(f"wallet sidecar missing {root}")
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in skip_dirs and not d.startswith(".")]
            for fn in fns:
                if fn.endswith((".obj", ".o", ".pdb", ".ilk")):
                    continue
                src = os.path.join(dp, fn)
                if not os.path.isfile(src):
                    continue
                rel = os.path.relpath(src, root)
                target = os.path.join(dest, arc_prefix, rel)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                shutil.copy2(src, target)

    skip_crypto = {"target", "randomx", "node_modules", ".git"}
    copy_tree(os.path.join(repo, "node", "src"), os.path.join("node", "src"), {".git", "node_modules"})
    copy_tree(os.path.join(repo, "crypto"), "crypto", skip_crypto)
    for rel in (
        "package.json",
        "package-lock.json",
        "pool/src/wallet_api.js",
        "pool/src/hash_credit.js",
        "pool/src/withdraw_state.js",
        "contracts/Reserve.json",
        "reserve/latest.json",
    ):
        src = os.path.join(repo, *rel.split("/"))
        if not os.path.isfile(src):
            raise SystemExit(f"wallet sidecar missing {rel}")
        target = os.path.join(dest, *rel.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(src, target)
    modules = os.path.join(repo, "node_modules")
    if not os.path.isdir(modules):
        raise SystemExit("wallet sidecar missing node_modules — run npm ci before packing")
    copy_tree(modules, "node_modules", {".git"})
    runtime_src = shutil.which("node")
    if not runtime_src or not os.path.isfile(runtime_src):
        raise SystemExit("Mac sidecar needs a node binary on PATH")
    real = os.path.realpath(runtime_src)
    if not os.path.isfile(real) or os.path.getsize(real) < 1_000_000:
        size = os.path.getsize(real) if os.path.isfile(real) else 0
        raise SystemExit(
            f"Mac sidecar node binary is {size} bytes. Use a full node binary, not a dispatcher stub."
        )
    runtime_dir = os.path.join(dest, "runtime")
    os.makedirs(runtime_dir, exist_ok=True)
    staged = os.path.join(runtime_dir, "node")
    shutil.copy2(real, staged)
    os.chmod(staged, 0o755)
    for name in ("shear-miner", "Shear-Miner"):
        if os.path.exists(os.path.join(dest, name)):
            raise SystemExit("wallet app must not include Shear-Miner")
    if not os.path.isfile(os.path.join(dest, "node", "src", "node.js")):
        raise SystemExit("Mac sidecar missing node/src/node.js")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: stage_macos_sidecar.py DEST REPO", file=sys.stderr)
        return 2
    stage_app_sidecar(sys.argv[1], sys.argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
