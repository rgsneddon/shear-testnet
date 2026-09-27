#!/usr/bin/env python3
"""Pack a portable Shear node zip for one OS flavor.

Flavors: windows, linux, archlinux, fedora, opensuse, macos.
Each zip is built on that OS so native addons (shearhash.node, shearadmit.node)
match the machine. The launcher is shear-node.cmd (Windows) or shear-node.sh.

  python node/pack/zip_node.py windows
  python node/pack/zip_node.py linux
"""
from __future__ import annotations

import os
import shutil
import sys
import zipfile

FLAVORS = ("windows", "linux", "archlinux", "fedora", "opensuse", "macos")
SKIP_DIR_NAMES = {
    "node_modules",
    "target",
    "randomx",
    "dist",
    "build",
    ".git",
    "wallet",
    "pool",
    "site",
    "sheark-miner",
    "miner",
}

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PACK = os.path.join(REPO, "node", "pack")
DIST = os.path.join(REPO, "dist")


def product_version() -> str:
    path = os.path.join(REPO, "crypto", "asert.js")
    with open(path, encoding="utf-8") as f:
        for line in f:
            if "PRODUCT_VERSION" in line and "=" in line and "export const" in line:
                return line.split("'")[1]
    return os.environ.get("SHEAR_NODE_PIN", "0.56")


def add_filtered_tree(z: zipfile.ZipFile, root: str, arc_prefix: str, skip_dirs=None) -> None:
    skip = SKIP_DIR_NAMES if skip_dirs is None else skip_dirs
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in skip and not d.startswith(".")]
        for fn in fns:
            if fn.endswith((".obj", ".o", ".pdb", ".ilk")):
                continue
            if fn.endswith(".node"):
                host_win = sys.platform.startswith("win")
                flavor = os.environ.get("SHEAR_NODE_FLAVOR", "")
                if host_win and flavor not in ("windows", ""):
                    continue
                if (not host_win) and flavor == "windows":
                    continue
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, root).replace("\\", "/")
            z.write(p, f"{arc_prefix}/{rel}")


def copy_runtime(staging: str, flavor: str) -> str | None:
    dest = os.path.join(staging, "runtime")
    os.makedirs(dest, exist_ok=True)
    if flavor == "windows":
        src = sys.executable
        if src.lower().endswith("python.exe"):
            for cand in (
                os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "nodejs", "node.exe"),
                shutil.which("node"),
            ):
                if cand and os.path.isfile(cand):
                    src = cand
                    break
        if src and os.path.isfile(src) and src.lower().endswith("node.exe"):
            out = os.path.join(dest, "node.exe")
            shutil.copy2(src, out)
            return out
        return None
    src = shutil.which("node")
    if src and os.path.isfile(src):
        out = os.path.join(dest, "node.exe" if flavor == "windows" else "node")
        shutil.copy2(src, out)
        return out
    return None


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    flavor = (args[0] if args else "linux").strip().lower()
    if flavor not in FLAVORS:
        sys.exit(f"flavor must be one of {', '.join(FLAVORS)}")
    pin = product_version()
    os.environ["SHEAR_NODE_FLAVOR"] = flavor
    os.makedirs(DIST, exist_ok=True)
    name = f"shear-node-{pin}-{flavor}.zip"
    out = os.path.join(DIST, name)
    if os.path.exists(out):
        os.remove(out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        if flavor == "windows":
            z.write(os.path.join(PACK, "shear-node.cmd"), "shear-node.cmd")
        else:
            z.write(os.path.join(PACK, "shear-node.sh"), "shear-node.sh")
        z.write(os.path.join(REPO, "package.json"), "package.json")
        z.write(os.path.join(REPO, "package-lock.json"), "package-lock.json")
        add_filtered_tree(z, os.path.join(REPO, "node", "src"), "node/src", skip_dirs={"node_modules", ".git"})
        add_filtered_tree(
            z,
            os.path.join(REPO, "crypto"),
            "crypto",
            skip_dirs={"target", "randomx", "node_modules", ".git"},
        )
        if os.environ.get("SHEAR_NODE_PACK_DEPS", "1") != "0":
            nm = os.path.join(REPO, "node_modules")
            if os.path.isdir(nm):
                add_filtered_tree(z, nm, "node_modules", skip_dirs={".git"})
        readme = (
            f"Shear node {pin} ({flavor})\n"
            "Unzip and run shear-node.cmd (Windows) or ./shear-node.sh.\n"
            "Pass --solo for local stratum after ibd=false.\n"
            "Magic shear-testnet-v5. No automatic bootstrap.\n"
            "If node_modules is missing: npm ci once in this folder, then run the launcher.\n"
        )
        z.writestr("README.txt", readme)

    size = os.path.getsize(out)
    names = zipfile.ZipFile(out).namelist()
    print("wrote", out, "bytes", size)
    if "node/src/node.js" not in names:
        sys.exit("missing node/src/node.js")
    if flavor == "windows" and "shear-node.cmd" not in names:
        sys.exit("missing shear-node.cmd")
    if flavor != "windows" and "shear-node.sh" not in names:
        sys.exit("missing shear-node.sh")
    print("ok", name, "pin", pin, "flavor", flavor)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
