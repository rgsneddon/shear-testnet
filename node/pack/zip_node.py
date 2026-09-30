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

from bundle_modules import assert_zip_has_modules

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
    return os.environ.get("SHEAR_NODE_PIN", "9.0")


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
            if not os.path.isfile(p):
                continue
            rel = os.path.relpath(p, root).replace("\\", "/")
            z.write(p, f"{arc_prefix}/{rel}")


def mingw_bin_dir() -> str:
    gcc = shutil.which("gcc")
    if gcc:
        return os.path.dirname(os.path.abspath(gcc))
    return ""


def write_mingw_runtime(z: zipfile.ZipFile) -> None:
    """shearhash.node is a MinGW N-API addon. Those DLLs must sit next to node.exe."""
    bindir = mingw_bin_dir()
    needed = ("libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll")
    missing = [n for n in needed if not os.path.isfile(os.path.join(bindir, n))] if bindir else list(needed)
    if missing:
        sys.exit(
            "Windows node zip needs MinGW runtime "
            + ", ".join(needed)
            + " beside gcc (PATH gcc="
            + (shutil.which("gcc") or "missing")
            + ")"
        )
    for name in needed:
        z.write(os.path.join(bindir, name), f"runtime/{name}")


def write_crlf_launcher(z: zipfile.ZipFile, src: str, arcname: str) -> None:
    """Windows cmd.exe treats LF-only .cmd/.bat as one line and the window flash-closes."""
    data = open(src, "rb").read().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    z.writestr(arcname, data)


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
    major = pin.split(".")[0]
    pack_label = os.environ.get("SHEAR_NODE_PACK_LABEL", f"v{major}")
    os.environ["SHEAR_NODE_FLAVOR"] = flavor
    os.makedirs(DIST, exist_ok=True)
    name = f"shear-node-{pack_label}-{flavor}.zip"
    out = os.path.join(DIST, name)
    if os.path.exists(out):
        os.remove(out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        if flavor == "windows":
            write_crlf_launcher(z, os.path.join(PACK, "shear-node.cmd"), "shear-node.cmd")
            bat = os.path.join(PACK, "shear-node.bat")
            write_crlf_launcher(z, bat if os.path.isfile(bat) else os.path.join(PACK, "shear-node.cmd"), "shear-node.bat")
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
        # Boot graph outside node/src + crypto: RPC wallet API and Reserve pin.
        for rel in (
            "pool/src/wallet_api.js",
            "pool/src/hash_credit.js",
            "pool/src/withdraw_state.js",
            "contracts/Reserve.json",
            "reserve/latest.json",
        ):
            src = os.path.join(REPO, rel.replace("/", os.sep))
            if not os.path.isfile(src):
                sys.exit(f"missing {rel}")
            z.write(src, rel)
        if os.environ.get("SHEAR_NODE_PACK_DEPS", "1") == "0":
            sys.exit("refusing zip: SHEAR_NODE_PACK_DEPS=0 omits node_modules")
        nm = os.path.join(REPO, "node_modules")
        if not os.path.isdir(nm):
            sys.exit("missing node_modules — run npm ci before packing")
        add_filtered_tree(z, nm, "node_modules", skip_dirs={".git"})
        runtime = os.path.join(REPO, "runtime")
        if os.path.isdir(runtime):
            add_filtered_tree(z, runtime, "runtime", skip_dirs={".git"})
        else:
            copy_runtime(REPO, flavor)
            if os.path.isdir(runtime):
                add_filtered_tree(z, runtime, "runtime", skip_dirs={".git"})
        if flavor == "windows":
            write_mingw_runtime(z)
        readme = (
            f"Shear Sentinel v{major} ({flavor})  node pin {pin}\n"
            "Windows: double-click shear-node.cmd or shear-node.bat. The window stays open.\n"
            "Unix: chmod +x shear-node.sh && ./shear-node.sh\n"
            "It syncs from genesis (or the saved tip) to the live tip. No automatic bootstrap.\n"
            "Pass --solo for local stratum after ibd=false.\n"
            "Magic shear-testnet-v9. Continuum wallet is 0.64.\n"
            "node_modules, crypto, and the native addons are inside this zip.\n"
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
    if "crypto/native/shearhash.node" not in names:
        sys.exit("missing crypto/native/shearhash.node — pack this flavor on that OS")
    for req in (
        "node_modules/@noble/curves/ed25519.js",
        "node_modules/@noble/curves/secp256k1.js",
        "node_modules/@noble/hashes/sha2.js",
        "node_modules/@noble/hashes/sha3.js",
        "node_modules/@noble/hashes/argon2.js",
    ):
        if req not in names:
            sys.exit(f"missing {req}")
    if flavor == "windows":
        for dll in ("runtime/libgcc_s_seh-1.dll", "runtime/libstdc++-6.dll", "runtime/libwinpthread-1.dll"):
            if dll not in names:
                sys.exit(f"missing {dll}")
    assert_zip_has_modules(names, REPO)
    print("ok", name, "pin", pin, "flavor", flavor, "modules", len(names))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
