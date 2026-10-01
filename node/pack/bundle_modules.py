#!/usr/bin/env python3
"""Modules a Shear release must contain so the executable can load them.

The node entry is node/src/node.js. This walks static imports from that file
(and the files it reaches) and resolves bare specifiers the way Node resolves
an ESM import. Native addons are required by path, so they are listed too.
A release zip that omits any of these paths is refused.
"""
from __future__ import annotations

import json
import os
import re

SPEC_RE = re.compile(
    r"""(?:\bfrom\s+|import\s*\(\s*|require\(\s*|import\s+)['"]([^'"]+)['"]"""
)

ROOTS = ("node/src/node.js",)
NATIVE = (
    "crypto/native/shearhash.node",
    "crypto/native/shearadmit.node",
)


def _export_target(node):
    if isinstance(node, str):
        return node
    if not isinstance(node, dict):
        return None
    if "import" in node:
        return _export_target(node["import"])
    if "default" in node:
        return _export_target(node["default"])
    for key in ("node", "browser", "module"):
        if key in node:
            got = _export_target(node[key])
            if got:
                return got
    for key, value in node.items():
        if key in ("typescript", "types", "require"):
            continue
        got = _export_target(value)
        if got and not str(got).endswith(".ts"):
            return got
    return None


def _pkg_parts(spec: str) -> tuple[str, str]:
    parts = spec.split("/")
    if spec.startswith("@"):
        return "/".join(parts[:2]), "/".join(parts[2:])
    return parts[0], "/".join(parts[1:])


def _find_package_dir(repo: str, importer_rel: str, pkg: str) -> str | None:
    start = os.path.join(repo, *importer_rel.split("/")[:-1])
    cur = start
    pkg_parts = pkg.split("/")
    while True:
        cand = os.path.join(cur, "node_modules", *pkg_parts, "package.json")
        if os.path.isfile(cand):
            return os.path.dirname(cand)
        parent = os.path.dirname(cur)
        if parent == cur or os.path.normcase(parent) == os.path.normcase(repo):
            root_cand = os.path.join(repo, "node_modules", *pkg_parts, "package.json")
            if os.path.isfile(root_cand):
                return os.path.dirname(root_cand)
            return None
        if os.path.normcase(cur) == os.path.normcase(repo):
            root_cand = os.path.join(repo, "node_modules", *pkg_parts, "package.json")
            if os.path.isfile(root_cand):
                return os.path.dirname(root_cand)
            return None
        cur = parent


def resolve_bare(repo: str, importer_rel: str, spec: str) -> str | None:
    """Zip path of an ESM bare specifier, or None when it is not a file we ship."""
    if spec.startswith("node:") or spec in {"fs", "path", "os", "http", "net", "crypto", "url"}:
        return None
    pkg, sub = _pkg_parts(spec)
    pkg_dir = _find_package_dir(repo, importer_rel, pkg)
    if pkg_dir is None:
        return None
    meta_path = os.path.join(pkg_dir, "package.json")
    meta = json.loads(open(meta_path, encoding="utf-8").read())
    exports = meta.get("exports")
    rel = None
    if isinstance(exports, dict):
        keys = []
        if sub:
            keys.append("./" + sub)
            if sub.endswith(".js"):
                keys.append("./" + sub[:-3])
            else:
                keys.append("./" + sub + ".js")
        else:
            keys.append(".")
        for key in keys:
            if key in exports:
                rel = _export_target(exports[key])
                if rel:
                    break
    if not rel:
        if sub:
            rel = sub if sub.endswith(".js") else sub + ".js"
        else:
            rel = meta.get("module") or meta.get("main") or "index.js"
    rel = str(rel).replace("\\", "/").lstrip("./")
    abs_path = os.path.normpath(os.path.join(pkg_dir, *rel.split("/")))
    if not os.path.isfile(abs_path):
        return None
    arc = os.path.relpath(abs_path, repo).replace("\\", "/")
    return arc


def _local_target(repo: str, importer_rel: str, spec: str) -> str | None:
    base = os.path.dirname(importer_rel)
    raw = os.path.normpath(os.path.join(base, spec)).replace("\\", "/")
    candidates = [raw]
    if not raw.endswith((".js", ".mjs", ".cjs", ".json", ".node")):
        candidates.extend([raw + ".js", raw + "/index.js"])
    for cand in candidates:
        abs_path = os.path.join(repo, *cand.split("/"))
        if os.path.isfile(abs_path):
            return cand
    return None


def required_module_paths(repo: str) -> list[str]:
    """Zip paths the release executable needs. Missing any one is a broken pack."""
    repo = os.path.abspath(repo)
    seen: set[str] = set()
    needed: list[str] = []
    queue: list[str] = []

    def add(arc: str) -> None:
        if arc in seen:
            return
        seen.add(arc)
        needed.append(arc)
        queue.append(arc)

    for root in ROOTS:
        add(root)
    for native in NATIVE:
        if native not in seen:
            seen.add(native)
            needed.append(native)

    while queue:
        rel = queue.pop(0)
        if not rel.endswith((".js", ".mjs", ".cjs")):
            continue
        abs_path = os.path.join(repo, *rel.split("/"))
        if not os.path.isfile(abs_path):
            continue
        text = open(abs_path, encoding="utf-8", errors="replace").read()
        for match in SPEC_RE.finditer(text):
            spec = match.group(1)
            if not spec or spec.startswith("node:"):
                continue
            if spec.startswith("."):
                target = _local_target(repo, rel, spec)
                if target:
                    add(target)
                continue
            target = resolve_bare(repo, rel, spec)
            if target:
                add(target)
    return needed


def write_release_sidecar(z, repo: str, flavor: str = "linux") -> None:
    """Put the node, its imports, and node_modules beside a release executable."""
    import shutil
    import sys

    repo = os.path.abspath(repo)
    skip_crypto = {"target", "randomx", "node_modules", ".git"}

    def add_tree(root: str, arc_prefix: str, skip_dirs: set[str]) -> None:
        if not os.path.isdir(root):
            raise SystemExit(f"release sidecar missing {root}")
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in skip_dirs and not d.startswith(".")]
            for fn in fns:
                if fn.endswith((".obj", ".o", ".pdb", ".ilk")):
                    continue
                p = os.path.join(dp, fn)
                if not os.path.isfile(p):
                    continue
                rel = os.path.relpath(p, root).replace("\\", "/")
                z.write(p, f"{arc_prefix}/{rel}")

    add_tree(os.path.join(repo, "node", "src"), "node/src", {".git", "node_modules"})
    add_tree(os.path.join(repo, "crypto"), "crypto", skip_crypto)
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
            raise SystemExit(f"release sidecar missing {rel}")
        z.write(src, rel)
    modules = os.path.join(repo, "node_modules")
    if not os.path.isdir(modules):
        raise SystemExit("release sidecar missing node_modules — run npm ci before packing")
    add_tree(modules, "node_modules", {".git"})
    runtime_name = "node.exe" if flavor == "windows" else "node"
    runtime_src = shutil.which("node")
    if flavor == "windows":
        cand = os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "nodejs", "node.exe")
        if os.path.isfile(cand):
            runtime_src = cand
    if not runtime_src or not os.path.isfile(runtime_src):
        raise SystemExit("release sidecar needs a node binary on PATH")
    z.write(runtime_src, f"runtime/{runtime_name}")
    if flavor == "windows":
        gcc = shutil.which("gcc")
        bindir = os.path.dirname(os.path.abspath(gcc)) if gcc else ""
        for dll in ("libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"):
            src = os.path.join(bindir, dll)
            if not os.path.isfile(src):
                raise SystemExit(f"release sidecar needs MinGW {dll}")
            z.write(src, f"runtime/{dll}")
    if sys.platform.startswith("win") and flavor != "windows":
        raise SystemExit("pack the linux release on linux so native addons match that OS")


def missing_on_disk(repo: str) -> list[str]:
    missing = []
    for arc in required_module_paths(repo):
        if not os.path.isfile(os.path.join(repo, *arc.split("/"))):
            missing.append(arc)
    return missing


def write_missing_required(z, repo: str) -> None:
    """Store walker paths the hand list did not already put in the archive.

    Duplicate names are not written. A path that is not on disk is left for
    assert_zip_has_modules to refuse.
    """
    repo = os.path.abspath(repo)
    have = {info.filename.replace("\\", "/") for info in z.infolist()}
    for arc in required_module_paths(repo):
        if arc in have:
            continue
        src = os.path.join(repo, *arc.split("/"))
        if not os.path.isfile(src):
            continue
        z.write(src, arc)
        have.add(arc)


def assert_zip_has_modules(names: set[str] | list[str], repo: str) -> None:
    have = set(names)
    missing = [arc for arc in required_module_paths(repo) if arc not in have]
    if missing:
        preview = "\n".join(missing[:40])
        extra = "" if len(missing) <= 40 else f"\n… {len(missing) - 40} more"
        raise SystemExit(
            f"release is missing {len(missing)} required module(s):\n{preview}{extra}"
        )
