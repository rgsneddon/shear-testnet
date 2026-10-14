"""Licence notices that every Shear release archive must carry.

Packagers import this module to put LICENSE, THIRD_PARTY_NOTICES.txt and
LICENSES/ into each zip or tarball, to leave development-only npm packages out
of the shipped node_modules, and to carry the licence of every host binary
(the Node.js runtime, distro shared libraries) they copy into a release.

A host binary whose licence cannot be found stops the pack. Set
SHEAR_RUNTIME_LICENSE_<NAME>=<path> (NAME is the upper-cased basename with
non-alphanumerics as "_", e.g. SHEAR_RUNTIME_LICENSE_NODE_EXE) to point at the
licence file for a binary installed somewhere this module does not search.
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess

NOTICE_FILES = ("LICENSE", "THIRD_PARTY_NOTICES.txt")
NOTICE_DIRS = ("LICENSES",)
ATTRIBUTION = "The Shear concept was inspired by Roy D Herbert, and the Chronoflux Principia."


def notice_members(repo: str) -> list[tuple[str, str]]:
    """(absolute path, archive-relative path) for every notice file."""
    repo = os.path.abspath(repo)
    out: list[tuple[str, str]] = []
    for rel in NOTICE_FILES:
        src = os.path.join(repo, rel)
        if not os.path.isfile(src):
            raise SystemExit(f"release notices missing {rel}")
        out.append((src, rel))
    for top in NOTICE_DIRS:
        root = os.path.join(repo, top)
        if not os.path.isdir(root):
            raise SystemExit(f"release notices missing {top}/")
        for dp, dns, fns in os.walk(root):
            dns.sort()
            for fn in sorted(fns):
                src = os.path.join(dp, fn)
                out.append((src, os.path.relpath(src, repo).replace("\\", "/")))
    return out


def write_notices(z, repo: str, prefix: str = "") -> None:
    """Add the notice files to an open zipfile.ZipFile under prefix."""
    have = {info.filename for info in z.infolist()}
    for src, arc in notice_members(repo):
        name = f"{prefix}{arc}"
        if name not in have:
            z.write(src, name)


def copy_notices(dest: str, repo: str) -> None:
    """Copy the notice files into a staging directory."""
    for src, arc in notice_members(repo):
        target = os.path.join(dest, *arc.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(src, target)


def assert_has_notices(names, repo: str, prefix: str = "") -> None:
    have = {n.replace("\\", "/") for n in names}
    missing = [f"{prefix}{arc}" for _src, arc in notice_members(repo) if f"{prefix}{arc}" not in have]
    if missing:
        raise SystemExit("release is missing licence notices: " + ", ".join(missing[:10]))


def dev_only_npm_dirs(repo: str) -> set[str]:
    """node_modules paths that package-lock.json marks as development-only."""
    lock = os.path.join(repo, "package-lock.json")
    with open(lock, encoding="utf-8") as f:
        packages = json.load(f).get("packages", {})
    return {path for path, meta in packages.items() if path and meta.get("dev")}


def npm_dir_filter(repo: str):
    """Return keep(rel_dir) for os.walk over node_modules; rel_dir is repo-relative."""
    dev = dev_only_npm_dirs(repo)

    def keep(rel_dir: str) -> bool:
        rel = rel_dir.replace("\\", "/").strip("/")
        return rel not in dev

    return keep


def _env_override(binary: str) -> str | None:
    key = "SHEAR_RUNTIME_LICENSE_" + re.sub(r"[^A-Za-z0-9]", "_", os.path.basename(binary)).upper()
    path = os.environ.get(key)
    if path and os.path.isfile(path):
        return path
    return None


def _package_manager_docs(path: str) -> list[str]:
    """Licence files the distro package that owns path installed."""
    queries = (
        (["rpm", "-qf", "--qf", "%{NAME}\n", path], "rpm"),
        (["dpkg", "-S", path], "dpkg"),
        (["pacman", "-Qoq", path], "pacman"),
    )
    for cmd, kind in queries:
        if not shutil.which(cmd[0]):
            continue
        try:
            out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            continue
        if not out:
            continue
        pkg = out.splitlines()[0].split(":")[0].strip() if kind == "dpkg" else out.splitlines()[0].strip()
        found: list[str] = []
        if kind == "rpm":
            try:
                files = subprocess.check_output(
                    ["rpm", "-q", "--licensefiles", pkg], text=True, stderr=subprocess.DEVNULL
                ).split()
            except (OSError, subprocess.CalledProcessError):
                files = []
            found += [f for f in files if os.path.isfile(f)]
        found += sorted(glob.glob(f"/usr/share/licenses/{pkg}/*"))
        copyright_file = f"/usr/share/doc/{pkg}/copyright"
        if os.path.isfile(copyright_file):
            found.append(copyright_file)
        found = [f for f in dict.fromkeys(found) if os.path.isfile(f)]
        if found:
            return found
    return []


def host_license_files(binary: str) -> list[str]:
    """Licence files for a host binary or shared library a pack copies.

    Looks beside the install (Node.js tarballs, the Windows installer and
    Homebrew kegs keep LICENSE one level above bin/), then asks the distro
    package manager. Raises SystemExit when nothing is found.
    """
    override = _env_override(binary)
    if override:
        return [override]
    real = os.path.realpath(binary)
    here = os.path.dirname(real)
    for base in (here, os.path.dirname(here), os.path.dirname(os.path.dirname(here))):
        hits = sorted(
            p for p in glob.glob(os.path.join(base, "*"))
            if os.path.isfile(p) and re.match(r"(?i)^(licen[cs]e|copying)(\.(md|txt))?$", os.path.basename(p))
        )
        if hits:
            return hits
    found = _package_manager_docs(real)
    if found:
        return found
    name = os.path.basename(real)
    if name.startswith("node"):
        for pattern in ("/usr/share/licenses/node*/LICENSE", "/usr/share/doc/node*/LICENSE*", "/usr/share/doc/nodejs/copyright"):
            hits = sorted(glob.glob(pattern))
            if hits:
                return hits[:1]
    raise SystemExit(
        f"no licence file found for bundled binary {binary}. Set "
        f"SHEAR_RUNTIME_LICENSE_{re.sub(r'[^A-Za-z0-9]', '_', os.path.basename(binary)).upper()} "
        "to its licence file"
    )


def linked_system_libs(binary: str, names: list[str]) -> list[str]:
    """System paths, per ldd on the original binary, of the libraries a pack copied by basename."""
    if not names:
        return []
    try:
        out = subprocess.check_output(["ldd", binary], text=True, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        raise SystemExit(f"ldd failed on {binary}; cannot find licences for {', '.join(names)}")
    want = set(names)
    found: dict[str, str] = {}
    for line in out.splitlines():
        if "=>" not in line:
            continue
        rest = line.split("=>", 1)[1].strip().split()
        if not rest or not rest[0].startswith("/"):
            continue
        real = os.path.realpath(rest[0])
        for cand in (os.path.basename(rest[0]), os.path.basename(real)):
            if cand in want:
                found[cand] = real
    missing = sorted(want - set(found))
    if missing:
        raise SystemExit(f"cannot locate system copies of {', '.join(missing)} for their licences")
    return [found[n] for n in names]


BUNDLED_RUNTIME_LICENSES = (
    (re.compile(r"^node(\.exe)?$"), ("LICENSES/third-party/nodejs/LICENSE",)),
    (re.compile(r"^libsodium[.-]"), ("LICENSES/third-party/libsodium/LICENSE",)),
    (
        re.compile(r"^lib(ssl|crypto)[.-]"),
        ("LICENSES/third-party/openssl/LICENSE.txt", "LICENSES/third-party/openssl/COPYRIGHT"),
    ),
)


def bundled_license_files(binary: str, repo: str) -> list[str]:
    base = os.path.basename(binary)
    for pattern, rels in BUNDLED_RUNTIME_LICENSES:
        if pattern.match(base):
            return [os.path.join(repo, *rel.split("/")) for rel in rels]
    return []


def license_files_for(binary: str, repo: str | None) -> list[str]:
    """The host's licence files for binary, else the copy kept under LICENSES/third-party/.

    A binary inside the checkout (runtime/node.exe) always takes the kept copy,
    so the search beside it cannot pick up Shear's own LICENSE.
    """
    bundled = bundled_license_files(binary, repo) if repo is not None else []
    inside_repo = False
    if repo is not None:
        root = os.path.realpath(repo)
        inside_repo = os.path.commonpath([os.path.realpath(binary), root]) == root
    if not (inside_repo and bundled):
        try:
            return host_license_files(binary)
        except SystemExit:
            if not bundled:
                raise
    missing = [f for f in bundled if not os.path.isfile(f)]
    if missing:
        raise SystemExit(f"no licence for {binary}: {', '.join(missing)} missing")
    return bundled


COVERED_WINDOWS_DLLS = {
    "libssl-3-x64.dll": "LICENSES/third-party/openssl",
    "libcrypto-3-x64.dll": "LICENSES/third-party/openssl",
    "libgcc_s_seh-1.dll": "LICENSES/GPL-3.0-or-later.txt, LICENSES/GCC-exception-3.1.txt",
    "libstdc++-6.dll": "LICENSES/GPL-3.0-or-later.txt, LICENSES/GCC-exception-3.1.txt",
    "libwinpthread-1.dll": "LICENSES/third-party/mingw-w64-winpthreads",
}


def assert_windows_dlls_covered(dlls: list[str]) -> None:
    """Every DLL a Windows pack ships must have its licence in LICENSES/ (see THIRD_PARTY_NOTICES.txt)."""
    names = {re.split(r"[\\/]", d)[-1] for d in dlls}
    unknown = sorted(n for n in names if n.lower() not in COVERED_WINDOWS_DLLS)
    if unknown:
        raise SystemExit(
            "no licence notice for bundled DLL(s) " + ", ".join(unknown)
            + "; add them to scripts/licenses/components.json and COVERED_WINDOWS_DLLS"
        )


def runtime_license_members(binaries: list[str], arc_dir: str, repo: str | None = None) -> list[tuple[str, str]]:
    """(src, arcname) pairs that put each binary's licence under arc_dir/<binary>/.

    With repo set, Node.js, libsodium and OpenSSL fall back to LICENSES/third-party/.
    """
    out: list[tuple[str, str]] = []
    for binary in binaries:
        base = os.path.basename(binary)
        for lic in license_files_for(binary, repo):
            out.append((lic, f"{arc_dir}/{base}/{os.path.basename(lic)}"))
    return out
