#!/usr/bin/env python3
"""Fail when baseline x86_64 code holds AVX, AVX2 or any later extension.

Public builds pin -march=x86-64 -mtune=generic (scripts/randomx_build.sh says
why). A toolchain can default higher: GitHub's ubuntu-26.04 gcc is configured
--with-arch-64=x86-64-v3, and then plain -O2 emits AVX2 that faults on CPUs
without it. Only the kernels below may use AVX/AVX2, and each runs only after
a CPU check:

  RandomX argon2 (argon2_avx2.c, argon2_ssse3.c): randomx_get_flags sets
    RANDOMX_FLAG_ARGON2_AVX2/SSSE3 only when cpu.hasAvx2()/hasSsse3().
  Shear-Miner SHA-256 (sha256_avx2.c, sha256_ni.c): sha256_dispatch.c picks
    them only when sha256_have_avx2()/sha256_have_sha_ni() (cpuid).
  Rust crates in the admit library, each behind its own run-time check:
    curve25519-dalek backend::vector (cpufeatures, get_selected_backend),
    memchr arch::x86_64::avx2 and blake2b_simd avx2 (is_x86_feature_detected),
    sha2 sha512 x86_64 avx2 (cpufeatures).

Flagged: VEX and EVEX encodings (AVX, AVX2, FMA, F16C, AVX-512), BMI1/2,
LZCNT and MOVBE, i.e. x86-64-v3 and later.

Usage: isa_scan.py FILE...   (ELF or PE executables, shared objects, .node
addons, .o objects and .a archives). An archive is judged member by member,
so a file-local name such as argon2's fill_block is judged by its own object;
a linked file is judged function by function.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys

# Objects whose whole content is a runtime-dispatched kernel.
DISPATCH_OBJECTS = frozenset({
    "argon2_avx2.c.o", "argon2_ssse3.c.o", "argon2_avx2.c.obj", "argon2_ssse3.c.obj",
    "sha256_avx2.o", "sha256_ni.o",
})
# Functions defined only in those objects, for linked files. fill_block is
# also argon2_ref's baseline name; librandomx.a is scanned per member, which
# judges that one.
DISPATCH_FUNCTIONS = frozenset({
    "randomx_argon2_fill_segment_avx2", "randomx_argon2_impl_avx2",
    "randomx_argon2_fill_segment_ssse3", "randomx_argon2_impl_ssse3",
    "fill_block",
    "sha256_compress_x8", "sha256_oneshot_x8_avx2",
    "sha256_compress_ni", "sha256_oneshot_ni", "sha256_oneshot_x8_ni",
})
# Rust (v0-mangled) functions in those crates' runtime-dispatched modules,
# matched on their length-prefixed path segments.
DISPATCH_RUST = tuple(re.compile(p) for p in (
    r"16curve25519_dalek7backend6vector",
    r"6memchr4arch6x86_644avx2",
    r"12blake2b_simd4avx2",
    r"4sha26sha5123x86\d+sha512_compress_x86_64_avx2",
))
# x86-64-v3 and later outside the VEX/EVEX encodings. tzcnt is left out: GCC
# emits rep bsf for ctz under -mtune=generic, objdump prints it as tzcnt, and
# it runs as bsf on any x86-64.
V3_SCALAR = frozenset({
    "andn", "bextr", "blsi", "blsmsk", "blsr", "bzhi", "mulx", "pdep", "pext",
    "rorx", "sarx", "shlx", "shrx", "lzcnt", "movbe",
})
PREFIXES = frozenset({
    "rep", "repz", "repe", "repnz", "repne", "lock", "notrack", "bnd",
    "data16", "addr32", "cs", "ds", "es", "fs", "gs", "ss",
})
X86_FORMATS = ("elf64-x86-64", "pei-x86-64", "pe-x86-64")
INSN_RE = re.compile(r"^\s*[0-9a-f]+:\s+(.*)$")
FUNC_RE = re.compile(r"^[0-9a-f]+ <(.+)>:$")
MEMBER_RE = re.compile(r"^(.+):\s+file format (\S+)$")


def above_baseline(insn: str) -> bool:
    """True for an x86-64-v3-or-later instruction (AT&T, as objdump prints it)."""
    parts = insn.split(None, 1)
    while parts and parts[0] in PREFIXES:
        parts = parts[1].split(None, 1) if len(parts) > 1 else []
    if not parts:
        return False
    mnem = parts[0]
    ops = parts[1] if len(parts) > 1 else ""
    if re.search(r"%[yz]mm\d|%k[0-7]\b", ops):
        return True
    if mnem.startswith("v") and "%xmm" in ops:
        return True
    return mnem in V3_SCALAR


def objdump() -> str:
    for name in (os.environ.get("OBJDUMP", ""), "objdump", "x86_64-w64-mingw32-objdump"):
        if name and shutil.which(name):
            return name
    raise SystemExit("isa_scan: objdump not found")


def scan(path: str) -> list[str]:
    """Return one line per (object, function) holding code above the baseline."""
    out = subprocess.run(
        [objdump(), "-d", "--no-show-raw-insn", path],
        capture_output=True, text=True, errors="replace",
    )
    if out.returncode != 0:
        raise SystemExit(f"isa_scan: objdump failed on {path}: {out.stderr.strip()}")
    linked = not path.endswith((".o", ".obj", ".a", ".lib"))
    hits: dict[tuple[str, str], list] = {}
    member = os.path.basename(path)
    formats = 0
    func = "?"
    for line in out.stdout.splitlines():
        m = MEMBER_RE.match(line)
        if m:
            # In an archive objdump prints "lib.a(member.o)" or "member.o".
            name = m.group(1).strip()
            inner = re.search(r"\(([^()]+)\)$", name)
            member = os.path.basename(inner.group(1) if inner else name)
            if m.group(2) not in X86_FORMATS:
                raise SystemExit(f"isa_scan: {path}: {member} is {m.group(2)}, not x86_64")
            formats += 1
            func = "?"
            continue
        m = FUNC_RE.match(line)
        if m:
            func = m.group(1).split("@")[0]
            continue
        m = INSN_RE.match(line)
        if not m or not above_baseline(m.group(1)):
            continue
        if member in DISPATCH_OBJECTS or (linked and func in DISPATCH_FUNCTIONS):
            continue
        if func.startswith("_R") and any(p.search(func) for p in DISPATCH_RUST):
            continue
        row = hits.setdefault((member, func), [m.group(1).strip(), 0])
        row[1] += 1
    if formats == 0:
        raise SystemExit(f"isa_scan: {path}: objdump found no x86_64 object")
    return [f"{path}: {mm} {ff}: {first} ({n} instruction(s))" for (mm, ff), (first, n) in sorted(hits.items())]


def main(argv: list[str]) -> int:
    if not argv:
        raise SystemExit(__doc__)
    bad: list[str] = []
    for path in argv:
        if not os.path.isfile(path):
            raise SystemExit(f"isa_scan: missing {path}")
        found = scan(path)
        bad += found
        print(f"isa_scan: {path}: " + ("ok" if not found else f"{len(found)} function(s) above the x86-64 baseline"))
    if bad:
        print("\n".join(bad[:60]), file=sys.stderr)
        if len(bad) > 60:
            print(f"... {len(bad) - 60} more", file=sys.stderr)
        print("isa_scan: build baseline code with -march=x86-64 -mtune=generic", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
