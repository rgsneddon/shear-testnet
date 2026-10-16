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
import sys

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
}

# Windows binaries link the GCC runtime and winpthreads statically
# (-static-libgcc -static-libstdc++, whole-archive libwinpthread), so these
# DLLs are never shipped and no binary may import them.
MINGW_RUNTIME_DLLS = ("libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll")


def pe_imports(path: str) -> list[str]:
    """DLL names in the import directory of a PE32/PE32+ file."""
    import struct

    data = open(path, "rb").read()
    if data[:2] != b"MZ":
        raise SystemExit(f"{path} is not a PE file")
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise SystemExit(f"{path} has no PE header")
    nsect, opt_size = struct.unpack_from("<H12xH", data, pe + 6)
    opt = pe + 24
    magic = struct.unpack_from("<H", data, opt)[0]
    dirs = opt + (112 if magic == 0x20B else 96)
    imp_rva = struct.unpack_from("<I", data, dirs + 8)[0]
    if not imp_rva:
        return []
    sections = []
    for i in range(nsect):
        s = opt + opt_size + 40 * i
        vsize, va, rsize, raw = struct.unpack_from("<IIII", data, s + 8)
        sections.append((va, max(vsize, rsize), raw))

    def off(rva: int) -> int:
        for va, size, raw in sections:
            if va <= rva < va + size:
                return rva - va + raw
        raise SystemExit(f"{path}: RVA {rva:#x} outside every section")

    names = []
    d = off(imp_rva)
    while True:
        name_rva = struct.unpack_from("<I", data, d + 12)[0]
        if not name_rva:
            break
        n = off(name_rva)
        names.append(data[n:data.index(b"\0", n)].decode("ascii"))
        d += 20
    return names


def assert_no_mingw_runtime(binaries: list[str]) -> None:
    """Fail if a Windows binary still imports the shared GCC runtime or winpthreads."""
    bad = []
    for b in binaries:
        hits = [n for n in pe_imports(b) if n.lower() in MINGW_RUNTIME_DLLS]
        if hits:
            bad.append(f"{b} imports {', '.join(hits)}")
    if bad:
        raise SystemExit(
            "; ".join(bad)
            + ". Link with -static-libgcc -static-libstdc++ and static winpthread (see crypto/native/Makefile)"
        )


# Linux binaries Shear builds link libgcc and libstdc++ statically, and no
# pack ships libstdc++.so.6 or libgcc_s.so.1 (GPL object code). A prebuilt
# third-party binary (node, libnode) may still load them from the user's own
# system; every glibc distro installs both.
GCC_RUNTIME_SONAMES = ("libstdc++.so", "libgcc_s.so")


def is_gcc_runtime(name: str) -> bool:
    return re.split(r"[\\/]", name)[-1].startswith(GCC_RUNTIME_SONAMES)


def is_elf(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            return fh.read(4) == b"\x7fELF"
    except OSError:
        return False


def elf_needed(path: str) -> list[str]:
    """DT_NEEDED entries of an ELF file (any class and byte order)."""
    import struct

    data = open(path, "rb").read()
    if data[:4] != b"\x7fELF":
        raise SystemExit(f"{path} is not an ELF file")
    wide = data[4] == 2
    end = "<" if data[5] == 1 else ">"
    if wide:
        phoff, = struct.unpack_from(end + "Q", data, 0x20)
        phentsize, phnum = struct.unpack_from(end + "HH", data, 0x36)
        ph_fmt, dyn_fmt = end + "II6Q", end + "qQ"
    else:
        phoff, = struct.unpack_from(end + "I", data, 0x1C)
        phentsize, phnum = struct.unpack_from(end + "HH", data, 0x2A)
        ph_fmt, dyn_fmt = end + "8I", end + "iI"
    loads, dynamic = [], None
    for i in range(phnum):
        f = struct.unpack_from(ph_fmt, data, phoff + i * phentsize)
        if wide:
            p_type, _flags, p_offset, p_vaddr, _paddr, p_filesz = f[:6]
        else:
            p_type, p_offset, p_vaddr, _paddr, p_filesz = f[:5]
        if p_type == 1:
            loads.append((p_vaddr, p_offset, p_filesz))
        elif p_type == 2:
            dynamic = (p_offset, p_filesz)
    if dynamic is None:
        return []
    entsize = struct.calcsize(dyn_fmt)
    needed, strtab = [], None
    for off in range(dynamic[0], dynamic[0] + dynamic[1], entsize):
        tag, val = struct.unpack_from(dyn_fmt, data, off)
        if tag == 0:
            break
        if tag == 1:
            needed.append(val)
        elif tag == 5:
            strtab = val
    if strtab is None:
        return []
    for vaddr, offset, size in loads:
        if vaddr <= strtab < vaddr + size:
            base = strtab - vaddr + offset
            break
    else:
        raise SystemExit(f"{path}: DT_STRTAB {strtab:#x} outside every PT_LOAD segment")
    return [data[base + n:data.index(b"\0", base + n)].decode("utf-8", "replace") for n in needed]


def assert_no_gcc_runtime(binaries: list[str]) -> None:
    """Fail if an ELF binary Shear builds still needs the shared libstdc++ or libgcc_s."""
    bad = []
    for b in binaries:
        hits = [n for n in elf_needed(b) if is_gcc_runtime(n)]
        if hits:
            bad.append(f"{b} needs {', '.join(hits)}")
    if bad:
        raise SystemExit(
            "; ".join(bad)
            + ". Link with -static-libgcc -static-libstdc++ (see crypto/native/Makefile)"
        )


def assert_ships_no_gcc_runtime(names) -> None:
    """Fail if a Linux pack would ship libstdc++.so* or libgcc_s.so*."""
    shipped = sorted({n for n in names if is_gcc_runtime(n)})
    if shipped:
        raise SystemExit(
            "Linux packs must not ship the GCC runtime (" + ", ".join(shipped)
            + "); Shear's binaries link it statically and node uses the system copy"
        )


def assert_linux_tree_clean(root: str, exempt=()) -> None:
    """Check a staged Linux pack: no shipped GCC runtime, and no ELF file under
    root needs one. exempt: fnmatch patterns (relative to root) for prebuilt
    third-party binaries, such as node, that load the system copy."""
    import fnmatch

    names, elves = [], []
    for dp, _dns, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            names.append(rel)
            if os.path.islink(p) or not is_elf(p) or any(fnmatch.fnmatch(rel, pat) for pat in exempt):
                continue
            elves.append(p)
    assert_ships_no_gcc_runtime(names)
    assert_no_gcc_runtime(elves)


def assert_linux_zip_clean(path: str, exempt=()) -> None:
    """assert_linux_tree_clean for a finished zip; exempt matches member names."""
    import fnmatch
    import tempfile
    import zipfile

    with zipfile.ZipFile(path) as z, tempfile.TemporaryDirectory(prefix="shear-elf-") as tmp:
        names = z.namelist()
        assert_ships_no_gcc_runtime(names)
        bad = []
        for i, name in enumerate(names):
            if name.endswith("/") or any(fnmatch.fnmatch(name, pat) for pat in exempt):
                continue
            data = z.read(name)
            if data[:4] != b"\x7fELF":
                continue
            staged = os.path.join(tmp, str(i))
            with open(staged, "wb") as fh:
                fh.write(data)
            hits = [n for n in elf_needed(staged) if is_gcc_runtime(n)]
            if hits:
                bad.append(f"{name} needs {', '.join(hits)}")
    if bad:
        raise SystemExit(
            f"{path}: " + "; ".join(bad)
            + ". Link with -static-libgcc -static-libstdc++ (see crypto/native/Makefile)"
        )


def assert_windows_dlls_covered(dlls: list[str]) -> None:
    """Every DLL a Windows pack ships must have its licence in LICENSES/ (see THIRD_PARTY_NOTICES.txt)."""
    names = {re.split(r"[\\/]", d)[-1] for d in dlls}
    runtime = sorted(n for n in names if n.lower() in MINGW_RUNTIME_DLLS)
    if runtime:
        raise SystemExit(
            "Windows packs must not ship the MinGW runtime (" + ", ".join(runtime)
            + "); link it statically instead"
        )
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


RUNTIME_VERSIONS = "RUNTIME-VERSIONS.txt"

OPENSSL_TEXT = rb"OpenSSL (\d+\.\d+\.\d+[a-z]?)(?:[-+][\w.]+)? +\d{1,2} [A-Z][a-z]{2} \d{4}"
# (component, basename pattern, version patterns searched in the binary)
VERSION_PROBES = (
    ("Node.js", re.compile(r"^node(\.exe)?$"), (rb"nodejs\.org/download/release/v(\d+\.\d+\.\d+)/", rb"\bnode/v(\d+\.\d+\.\d+)\b")),
    ("libsodium", re.compile(r"^libsodium[.-]"), (rb"\x00(1\.0\.\d+)\x00",)),
    ("OpenSSL", re.compile(r"^lib(ssl|crypto)[.-]"), (OPENSSL_TEXT,)),
)


def _search(data: bytes, patterns) -> str:
    for pat in patterns:
        m = re.search(pat, data)
        if m:
            return m.group(1).decode("ascii")
    return ""


def _package_version(path: str) -> str:
    """'<package> <version>' of the distro package that owns path, if any."""
    queries = (
        ["rpm", "-qf", "--qf", "%{NAME} %{VERSION}-%{RELEASE}\n", path],
        ["dpkg", "-S", path],
        ["pacman", "-Qo", path],
    )
    for cmd in queries:
        if not shutil.which(cmd[0]):
            continue
        try:
            out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL).strip().splitlines()[0]
        except (OSError, subprocess.CalledProcessError, IndexError):
            continue
        if cmd[0] == "rpm":
            return out
        if cmd[0] == "pacman":
            m = re.search(r"is owned by (\S+) (\S+)", out)
            return f"{m.group(1)} {m.group(2)}" if m else ""
        pkg = out.split(":")[0].strip()
        try:
            ver = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", pkg], text=True, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.CalledProcessError):
            ver = ""
        return f"{pkg} {ver}".strip()
    return ""


def runtime_versions(binaries: list[str]) -> list[tuple[str, str, str]]:
    """(component, exact version, where it came from) for each bundled Node.js, libsodium and OpenSSL.

    The version is read from the binary itself, then from the owning distro
    package; SHEAR_RUNTIME_VERSION_<BASENAME> overrides both. Raises
    SystemExit when no exact version can be established.
    """
    rows: list[tuple[str, str, str]] = []
    for binary in binaries:
        base = os.path.basename(binary)
        probe = next((p for p in VERSION_PROBES if p[1].match(base)), None)
        if probe is None:
            continue
        component, _pattern, patterns = probe
        real = os.path.realpath(binary)
        env = "SHEAR_RUNTIME_VERSION_" + re.sub(r"[^A-Za-z0-9]", "_", base).upper()
        data = open(real, "rb").read()
        version = os.environ.get(env) or _search(data, patterns)
        if not version and component == "OpenSSL":
            # libssl carries no version text; the libcrypto beside it does.
            for sibling in sorted(glob.glob(os.path.join(os.path.dirname(binary), "libcrypto*"))):
                version = _search(open(os.path.realpath(sibling), "rb").read(), patterns)
                if version:
                    break
        package = _package_version(real)
        if not version and package:
            version = package.split()[-1]
        if not version:
            raise SystemExit(f"cannot establish the exact {component} version of {binary}; set {env}")
        source = base + (f" (package {package})" if package else "")
        rows.append((component, version, source))
        if component == "Node.js":
            embedded = _search(data, (OPENSSL_TEXT,))
            if embedded:
                rows.append(("OpenSSL (built into Node.js)", embedded, base))
    return list(dict.fromkeys(rows))


def runtime_versions_text(binaries: list[str], extra: list[tuple[str, str, str]] | None = None) -> str:
    rows = runtime_versions(binaries) + list(extra or [])
    lines = [
        "Exact versions of the third-party runtimes bundled in this release.",
        "Their licences are in THIRD_PARTY_NOTICES.txt and LICENSES/.",
        "",
    ]
    lines += [f"{c}: {v} [{s}]" for c, v, s in rows]
    return "\n".join(lines) + "\n"


def android_libsodium_row(repo: str) -> tuple[str, str, str]:
    lock = json.load(open(os.path.join(repo, "wallet", "android", "libsodium.lock.json"), encoding="utf-8"))
    return ("libsodium (Android)", lock["version"], f"libsodium-{lock['version']}.tar.gz sha256 {lock['sha256']}, NDK {lock['ndk']}")


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "versions":
        sys.stdout.write(runtime_versions_text(argv[1:]))
        return 0
    if len(argv) >= 2 and argv[0] == "no-mingw-runtime":
        assert_no_mingw_runtime(argv[1:])
        print("no MinGW runtime imports:", " ".join(os.path.basename(a) for a in argv[1:]))
        return 0
    if len(argv) >= 2 and argv[0] == "no-gcc-runtime":
        assert_no_gcc_runtime(argv[1:])
        print("no shared GCC runtime needed:", " ".join(os.path.basename(a) for a in argv[1:]))
        return 0
    if len(argv) >= 2 and argv[0] == "linux-tree":
        root, rest = argv[1], argv[2:]
        exempt = [rest[i + 1] for i in range(0, len(rest) - 1, 2) if rest[i] == "--exempt"]
        if len(rest) != 2 * len(exempt):
            raise SystemExit("usage: release_notices.py linux-tree ROOT [--exempt PATTERN]...")
        assert_linux_tree_clean(root, exempt)
        print("no GCC runtime shipped or needed under", root)
        return 0
    raise SystemExit(
        "usage: release_notices.py no-mingw-runtime PE_FILE... | no-gcc-runtime ELF_FILE..."
        " | linux-tree ROOT [--exempt PATTERN]... | versions BINARY..."
    )


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
