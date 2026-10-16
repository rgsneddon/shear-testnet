#!/usr/bin/env python3
"""Install /opt/shear-v12 from an in-image build and write distro tarballs.

Tarballs extract onto /opt/shear-v12. Checksums land in /out/SHA256SUMS.
Nothing here is committed; build-all.sh copies /out to scripts/packaging/out/.
"""
from __future__ import annotations

import gzip
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

EPOCH = int(os.environ.get("SOURCE_DATE_EPOCH", "1700000000"))
SRC = Path(os.environ.get("SHEAR_SRC", "/src"))
PREFIX = Path(os.environ.get("SHEAR_PREFIX", "/opt/shear-v12"))
OUT = Path(os.environ.get("SHEAR_OUT", "/out"))
DISTRO = os.environ["SHEAR_DISTRO"]
DESKTOP = os.environ.get("SHEAR_PACK_DESKTOP", "1") == "1"
PACK = SRC / "scripts" / "packaging"
SKIP_DIRS = {"vendor", "randomx", "target", ".git", "node_modules", "__pycache__"}
SKIP_SUFFIXES = {".o", ".a", ".d", ".pdb", ".ilk"}
DOC = "share/doc/shear"

sys.path.insert(0, str(SRC / "scripts" / "licenses"))
import release_notices  # noqa: E402


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def quoted_const(path: Path, name: str) -> str:
    prefix_export = f"export const {name}"
    prefix_const = f"const {name}"
    for line in read_text(path).splitlines():
        stripped = line.strip()
        if stripped.startswith(prefix_export) or stripped.startswith(prefix_const):
            return stripped.split("'")[1]
    raise SystemExit(f"{name} missing in {path}")


def product_major() -> str:
    return quoted_const(SRC / "crypto" / "asert.js", "PRODUCT_VERSION").split(".")[0]


def miner_version() -> str:
    text = read_text(SRC / "sheark-miner" / "src" / "shear_hash.h")
    marker = '#define SHEAR_VERSION "'
    start = text.find(marker)
    if start < 0:
        raise SystemExit("SHEAR_VERSION missing")
    rest = text[start + len(marker):]
    return rest.split('"', 1)[0]


def wallet_pin() -> str:
    return quoted_const(SRC / "wallet" / "lib" / "shear_cli.dart", "kCliVersion")


def copy_file(src: Path, dest: Path, mode: int | None = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    if mode is not None:
        dest.chmod(mode)


def copy_tree(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest)
    def ignore(directory: str, names: list[str]) -> set[str]:
        skipped = {name for name in names if name in SKIP_DIRS or name.startswith(".")}
        return skipped
    shutil.copytree(src, dest, symlinks=False, ignore=ignore)
    for dirpath, dirnames, filenames in os.walk(dest, topdown=False):
        for name in filenames:
            path = Path(dirpath) / name
            if path.suffix in SKIP_SUFFIXES:
                path.unlink()
        for name in dirnames:
            path = Path(dirpath) / name
            if name in SKIP_DIRS and path.is_dir():
                shutil.rmtree(path, ignore_errors=True)


def install_runtime_licenses(binaries: list[Path]) -> None:
    """Licences for the host binaries copied into the prefix, under share/doc/shear/runtime/."""
    for src, arc in release_notices.runtime_license_members([str(b) for b in binaries], "runtime", str(SRC)):
        copy_file(Path(src), PREFIX / DOC / arc, 0o644)
    versions = PREFIX / DOC / release_notices.RUNTIME_VERSIONS
    versions.parent.mkdir(parents=True, exist_ok=True)
    versions.write_text(release_notices.runtime_versions_text([str(b) for b in binaries]), encoding="utf-8")
    versions.chmod(0o644)


def bundle_openssl(binary: Path, dest_bin: Path, dest_lib: Path) -> list[Path]:
    dest_lib.mkdir(parents=True, exist_ok=True)
    copy_file(binary, dest_bin, 0o755)
    ldd = subprocess.check_output(["ldd", str(dest_bin)], text=True)
    found: dict[str, str] = {}
    for line in ldd.splitlines():
        parts = line.strip().split()
        if len(parts) < 3 or parts[1] != "=>":
            continue
        soname, path = parts[0], parts[2]
        if soname.startswith("libssl") or soname.startswith("libcrypto"):
            if path == "not":
                raise SystemExit(f"{soname} is not installed")
            found[soname] = path
    if not any(name.startswith("libssl") for name in found):
        raise SystemExit("ShearK-Miner does not link libssl")
    if not any(name.startswith("libcrypto") for name in found):
        raise SystemExit("ShearK-Miner does not link libcrypto")
    for soname, path in sorted(found.items()):
        dest = dest_lib / soname
        shutil.copy2(path, dest)
        dest.chmod(0o644)
        subprocess.check_call(["patchelf", "--set-rpath", "$ORIGIN", str(dest)])
    subprocess.check_call(["patchelf", "--set-rpath", "$ORIGIN/../lib", str(dest_bin)])
    return [Path(os.path.realpath(path)) for _soname, path in sorted(found.items())]


def find_libsodium() -> Path:
    out = subprocess.check_output(["ldconfig", "-p"], text=True, errors="replace")
    for line in out.splitlines():
        if "libsodium.so." not in line or "=>" not in line:
            continue
        return Path(line.split("=>", 1)[1].strip())
    raise SystemExit("libsodium not found")


def install_prefix() -> None:
    if PREFIX.exists():
        shutil.rmtree(PREFIX)
    (PREFIX / "bin").mkdir(parents=True)
    (PREFIX / "lib").mkdir(parents=True)
    (PREFIX / "share" / "systemd").mkdir(parents=True)
    (PREFIX / "share" / "sheark").mkdir(parents=True)

    copy_file(Path("/usr/local/bin/node"), PREFIX / "bin" / "node", 0o755)
    copy_file(PACK / "shear-node", PREFIX / "bin" / "shear-node", 0o755)
    copy_file(PACK / "sheark-run", PREFIX / "bin" / "sheark-run", 0o755)
    copy_file(SRC / "package.json", PREFIX / "package.json")
    copy_file(SRC / "package-lock.json", PREFIX / "package-lock.json")
    copy_tree(SRC / "node" / "src", PREFIX / "node" / "src")
    copy_tree(SRC / "crypto", PREFIX / "crypto")
    copy_tree(SRC / "pool" / "src", PREFIX / "pool" / "src")
    copy_tree(SRC / "contracts", PREFIX / "contracts")
    copy_file(SRC / "reserve" / "latest.json", PREFIX / "reserve" / "latest.json")
    # Keep nested node_modules. @noble/curves carries hashes 1.x beside the
    # top-level hashes 2.x, and dropping that nest breaks ESM exports.
    # Follow symlinks so the tarball does not point back at /src.
    modules = PREFIX / "node_modules"
    if modules.exists():
        shutil.rmtree(modules)
    dev = release_notices.dev_only_npm_dirs(str(SRC))

    def ignore_dev(directory: str, names: list[str]) -> set[str]:
        return {
            name for name in names
            if os.path.relpath(os.path.join(directory, name), SRC).replace(os.sep, "/") in dev
        }

    shutil.copytree(SRC / "node_modules", modules, symlinks=False, ignore=ignore_dev)
    release_notices.copy_notices(str(PREFIX / DOC), str(SRC))

    for unit in ("shear-sentinel.service", "sheark-miner.service"):
        copy_file(PACK / "systemd" / unit, PREFIX / "share" / "systemd" / unit, 0o644)
    copy_file(
        PACK / "sheark-miner.default.example",
        PREFIX / "share" / "sheark-miner.default.example",
        0o644,
    )
    copy_file(SRC / "sheark-miner" / "example.sh", PREFIX / "share" / "sheark" / "example.sh", 0o755)
    copy_file(SRC / "sheark-miner" / "example.bat", PREFIX / "share" / "sheark" / "example.bat", 0o644)
    openssl = bundle_openssl(
        SRC / "sheark-miner" / "ShearK-Miner",
        PREFIX / "bin" / "ShearK-Miner",
        PREFIX / "lib",
    )
    licensed = [Path("/usr/local/bin/node")] + openssl
    cli = Path(os.environ.get("SHEAR_CLI_BIN", "/tmp/shear-cli"))
    if not cli.is_file():
        raise SystemExit(f"wallet CLI binary missing: {cli}")
    copy_file(cli, PREFIX / "bin" / "shear", 0o755)

    for native in ("shearhash.node", "shearadmit.node"):
        path = PREFIX / "crypto" / "native" / native
        if not path.is_file() or path.stat().st_size < 1000:
            raise SystemExit(f"missing native addon {path}")

    if DESKTOP:
        bundle = SRC / "wallet" / "build" / "linux" / "x64" / "release" / "bundle"
        binary = bundle / "shear_wallet"
        if not binary.is_file():
            raise SystemExit(f"desktop bundle missing: {binary}")
        dest = PREFIX / "wallet-desktop"
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(bundle, dest, symlinks=True)
        lib = dest / "lib"
        lib.mkdir(parents=True, exist_ok=True)
        sodium = find_libsodium()
        shutil.copy2(sodium, lib / sodium.name)
        licensed.append(Path(os.path.realpath(sodium)))
        link = lib / "libsodium.so"
        if not link.exists():
            link.symlink_to(sodium.name)
        os.chmod(dest / "shear_wallet", 0o755)
    install_runtime_licenses(licensed)
    # bin/node is the official Node.js build, which loads the distro libstdc++.
    # Everything else Shear builds is linked with -static-libgcc -static-libstdc++.
    release_notices.assert_linux_tree_clean(str(PREFIX), exempt=("bin/node",))


def add_path(tar: tarfile.TarFile, abs_path: Path, arcname: str) -> None:
    st = abs_path.lstat()
    info = tarfile.TarInfo(arcname)
    info.mtime = EPOCH
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    if stat.S_ISLNK(st.st_mode):
        info.type = tarfile.SYMTYPE
        info.linkname = os.readlink(abs_path)
        info.mode = 0o777
        tar.addfile(info)
        return
    if stat.S_ISDIR(st.st_mode):
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        tar.addfile(info)
        for name in sorted(os.listdir(abs_path)):
            add_path(tar, abs_path / name, f"{arcname}/{name}")
        return
    if not stat.S_ISREG(st.st_mode):
        return
    info.type = tarfile.REGTYPE
    info.size = st.st_size
    info.mode = st.st_mode & 0o777
    with abs_path.open("rb") as handle:
        tar.addfile(info, handle)


def add_bytes(tar: tarfile.TarFile, arcname: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(arcname)
    info.mtime = EPOCH
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mode = mode
    info.size = len(data)
    tar.addfile(info, __import__("io").BytesIO(data))


def write_tarball(name: str, roots: list[str], readme: str) -> Path:
    out = OUT / name
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
                add_bytes(tar, "README.txt", readme.encode("utf-8"))
                for rel in roots:
                    add_path(tar, PREFIX / rel, rel)
    return out


def collect_members() -> None:
    node_major = product_major()
    miner = miner_version()
    wallet = wallet_pin()
    common = (
        f"Distro pack: {DISTRO}\n"
        "Extract onto /opt/shear-v12 (the systemd units use that prefix).\n"
        "Built in the matching distro image. Do not copy a pack onto another distro.\n"
    )
    specs = [
        (
            f"shear-node-v{node_major}-{DISTRO}.tar.gz",
            [
                "bin/node",
                "bin/shear-node",
                "package.json",
                "package-lock.json",
                "node",
                "crypto",
                "pool",
                "contracts",
                "reserve",
                "node_modules",
                "share/systemd/shear-sentinel.service",
            ],
            common
            + "Shear Sentinel v19. Run bin/shear-node or the shear-sentinel unit.\n"
            + "Native shearhash.node and shearadmit.node are under crypto/native/.\n",
        ),
        (
            f"ShearK-Miner-{miner}-{DISTRO}.tar.gz",
            [
                "bin/ShearK-Miner",
                "bin/sheark-run",
                "lib",
                "share/systemd/sheark-miner.service",
                "share/sheark-miner.default.example",
                "share/sheark",
            ],
            common
            + f"ShearK-Miner {miner}. OpenSSL libraries are in lib/ with an ORIGIN rpath.\n"
            + "Copy share/sheark-miner.default.example to /etc/default/sheark-miner and set SHEARK_USER on the host.\n"
            + "Do not enable the miner unit on the pool.\n",
        ),
        (
            f"shear-wallet-{wallet}-{DISTRO}-cli.tar.gz",
            ["bin/shear"],
            common + f"Wallet CLI {wallet}. Check with: /opt/shear-v12/bin/shear version\n",
        ),
    ]
    if DESKTOP:
        specs.append(
            (
                f"shear-wallet-{wallet}-{DISTRO}-desktop.tar.gz",
                ["wallet-desktop"],
                common
                + f"Wallet desktop {wallet}. Binary: /opt/shear-v12/wallet-desktop/shear_wallet\n"
                + "The host needs the distro GTK 3 runtime (and libsecret) to launch the GUI.\n"
                + "libsodium is bundled under wallet-desktop/lib/.\n",
            )
        )
    written = []
    for name, roots, readme in specs:
        roots = roots + [DOC]
        readme += f"Licences: {DOC}/LICENSE, {DOC}/THIRD_PARTY_NOTICES.txt and {DOC}/LICENSES/.\n"
        for rel in roots:
            if not (PREFIX / rel).exists():
                raise SystemExit(f"{name} missing {rel}")
        written.append(write_tarball(name, roots, readme))
    lines = []
    for path in sorted(written):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.name}\n")
    (OUT / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")
    print("".join(lines), end="")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    install_prefix()
    collect_members()


if __name__ == "__main__":
    main()
