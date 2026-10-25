#!/usr/bin/env python3
"""Fail when baseline x86_64 code needs more than x86-64 v1.

Public builds pin -march=x86-64 -mtune=generic (scripts/randomx_build.sh says
why). A toolchain can default higher: GitHub's ubuntu-26.04 gcc is configured
--with-arch-64=x86-64-v3, and then plain -O2 emits AVX2 that faults on CPUs
without it. Every instruction is classed by the extension it needs, and only
the kernels below may use one, each only the extensions its CPU check covers:

  RandomX argon2 (argon2_avx2.c, argon2_ssse3.c): randomx_get_flags sets
    RANDOMX_FLAG_ARGON2_AVX2/SSSE3 only when cpu.hasAvx2()/hasSsse3().
  RandomX hard AES (aes_hash.cpp and VmBase, the softAes=false templates):
    used only under RANDOMX_FLAG_HARD_AES.
  Shear-Miner SHA-256 (sha256_avx2.c, sha256_ni.c): sha256_dispatch.c picks
    them only when sha256_have_avx2()/sha256_have_sha_ni() (cpuid).
  Rust crates in the admit library, each behind its own run-time check:
    curve25519-dalek backend::vector (AVX2 and AVX-512 IFMA; cpufeatures,
    get_selected_backend), memchr arch::x86_64::avx2 and blake2b_simd avx2
    and sse41 (is_x86_feature_detected), sha2 x86 avx2 and SHA-NI (cpufeatures).

Classes: sse3, ssse3, sse41, sse42, popcnt and v2 (CMPXCHG16B, LAHF/SAHF),
the x86-64 v2 level; aes, pclmul and sha; avx (VEX vector code, AVX and
AVX2), fma, f16c, bmi (BMI1/2, LZCNT) and movbe, the x86-64 v3 level, each
its own class; avx512 (EVEX, zmm, xmm/ymm16-31, mask registers); and sse4a,
adx, rdrand and tbm, outside the levels.

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

# AVX and AVX2 vector code, and the SSE levels below them. An AVX2 kernel is
# not entitled to BMI, FMA, F16C or MOVBE: its CPU check tests AVX2 only.
UP_TO_AVX2 = frozenset({"sse3", "ssse3", "sse41", "sse42", "popcnt", "avx"})

# Objects whose whole content is a runtime-dispatched kernel, and what each may use.
DISPATCH_OBJECTS = {
    "argon2_avx2.c.o": UP_TO_AVX2, "argon2_avx2.c.obj": UP_TO_AVX2,
    "argon2_ssse3.c.o": frozenset({"sse3", "ssse3"}), "argon2_ssse3.c.obj": frozenset({"sse3", "ssse3"}),
    "sha256_avx2.o": UP_TO_AVX2,
    "sha256_ni.o": frozenset({"sse3", "ssse3", "sse41", "sha"}),
    # Soft and hard AES templates share this object; only the hard ones use AES.
    "aes_hash.cpp.o": frozenset({"aes"}), "aes_hash.cpp.obj": frozenset({"aes"}),
}
# Functions defined only in those kernels, for linked files. fill_block is
# also argon2_ref's (and argon2_ssse3's) name, so in a linked file this entry
# would let a baseline fill_block through. That is safe only because every job
# that scans a linked RandomX consumer also scans the same librandomx.a, which
# is judged member by member (argon2_ref.c.o gets no entitlement). Keep that
# pairing in every workflow that scans one.
DISPATCH_FUNCTIONS = {
    "randomx_argon2_fill_segment_avx2": UP_TO_AVX2, "randomx_argon2_impl_avx2": UP_TO_AVX2,
    "randomx_argon2_fill_segment_ssse3": frozenset({"sse3", "ssse3"}),
    "randomx_argon2_impl_ssse3": frozenset({"sse3", "ssse3"}),
    "fill_block": UP_TO_AVX2,
    "sha256_compress_x8": UP_TO_AVX2, "sha256_oneshot_x8_avx2": UP_TO_AVX2,
    "sha256_compress_ni": frozenset({"sse3", "ssse3", "sse41", "sha"}),
    "sha256_oneshot_ni": frozenset({"sse3", "ssse3", "sse41", "sha"}),
    "sha256_oneshot_x8_ni": frozenset({"sse3", "ssse3", "sse41", "sha"}),
}
# RandomX's hard-AES template instances. The template flag is softAes, so the
# hardware path is <false> (Itanium Lb0E): the aes_hash kernels and the
# VmBase<Allocator, false> members, whose allocate() probes AESENC. The
# <true> instances are the portable soft-AES build and get no entitlement.
# The entitlement rests on RANDOMX_FLAG_HARD_AES being set only after
# cpu.hasAes(). ShearK-Miner's jit backends (sheark-miner/src/shear_hash.c
# flags_jit_light) set it with no CPU check, so on a CPU without AES-NI the
# miner faults; that is D2, fixed in the hash-safety PR. shearhash.node and the
# wallet library take their flags from randomx_get_flags().
DISPATCH_PATTERNS = (
    (re.compile(r"^_Z\d+(?:fill|hash|hashAndFill)Aes\w*ILb0E"), frozenset({"aes"})),
    (re.compile(r"^_ZN7randomx6VmBaseI\w*?Lb0EE"), frozenset({"aes"})),
    # libstdc++'s std::random_device sources, statically linked: random.cc
    # _M_init picks __x86_rdrand / __x86_rdseed only after cpuid reports
    # RDRND / RDSEED (the cpuid is in its disassembly), else it uses another
    # source. Only these three functions are entitled.
    (re.compile(r"^_ZNSt12_GLOBAL__N_1L(12__x86_rdrand|12__x86_rdseed|19__x86_rdseed_rdrand)EPv$"), frozenset({"rdrand"})),
)
# Rust (v0-mangled) functions in runtime-dispatched modules, matched on their
# length-prefixed path segments.
DISPATCH_RUST = (
    (re.compile(r"16curve25519_dalek7backend6vector"), UP_TO_AVX2 | {"avx512"}),
    (re.compile(r"6memchr4arch6x86_644avx2"), UP_TO_AVX2),
    (re.compile(r"12blake2b_simd4avx2"), UP_TO_AVX2),
    (re.compile(r"12blake2b_simd5sse41"), frozenset({"sse3", "ssse3", "sse41"})),
    (re.compile(r"4sha26sha5123x86\d+sha512_compress_x86_64_avx2"), UP_TO_AVX2),
    (re.compile(r"4sha26sha2563x86"), frozenset({"sse3", "ssse3", "sse41", "sha"})),
)

# Scalar extensions of x86-64-v3, each its own class so a vector kernel's
# AVX2 entitlement does not cover them. tzcnt is left out: GCC emits rep bsf
# for ctz under -mtune=generic and objdump prints that as tzcnt. Both are
# F3 0F BC and run as bsf on any x86-64; only tzcnt(0) differs (32 against an
# undefined result), and baseline code built here never relies on it.
SCALAR = (
    ("bmi", frozenset({"andn", "bextr", "blsi", "blsmsk", "blsr", "bzhi", "mulx", "pdep", "pext",
                       "rorx", "sarx", "shlx", "shrx", "lzcnt"})),
    ("movbe", frozenset({"movbe"})),
    # x86-64-v2 above SSE4.2 and POPCNT.
    ("v2", frozenset({"cmpxchg16b", "lahf", "sahf"})),
    # Outside the psABI levels.
    ("sse4a", frozenset({"extrq", "insertq", "movntsd", "movntss"})),
    ("adx", frozenset({"adcx", "adox"})),
    ("rdrand", frozenset({"rdrand", "rdseed"})),
    ("tbm", frozenset({"blcfill", "blci", "blcic", "blcmsk", "blcs", "blsfill", "blsic", "t1mskc", "tzmsk"})),
)
# AVX vector instructions that may name no xmm register.
AVX_BARE = frozenset({"vzeroupper", "vzeroall", "vldmxcsr", "vstmxcsr"})
FMA = re.compile(r"^vf(n?madd|n?msub|maddsub|msubadd)\w+$")
F16C = re.compile(r"^vcvt(ph2ps|ps2ph)$")
# AVX-512 encodings that can name only xmm or ymm registers.
EVEX_ONLY = re.compile(
    r"^v(pternlog[dq]|pro[lr]v?[dq]|movdq[au](8|16|32|64)|perm[it]2\w+|pcompress\w|pexpand\w"
    r"|range\w+|reduce\w+|rndscale\w+|getexp\w+|getmant\w+|fixupimm\w+|scalef\w+"
    r"|pabsq|pm(ax|in)[su]q|pmullq|pconflict\w|plzcnt\w|pmadd52\w+|popcnt[bwdq]|pdp\w+|pshl?dv?\w|pshrdv?\w"
    r"|cvt\w*2u\w+|cvtu\w+|pbroadcastm\w+|pmov(q|d|w)[bwd]|pmovs(q|d|w)[bwd]|pmovus(q|d|w)[bwd]"
    r"|psraq|psravq|psrav[wq]|psllv[w]|psrlv[w]|blendm\w+|pblendm\w+|extract[fi](32x4|32x8|64x2|64x4)"
    r"|insert[fi](32x4|32x8|64x2|64x4)|broadcast[fi](32x2|32x4|32x8|64x2|64x4)|shuf[fi](32x4|64x2)|align[dq])$")
LEGACY = (
    ("sse3", re.compile(r"^(addsubp[sd]|hadd(p[sd])|hsubp[sd]|lddqu|movddup|movs[hl]dup|fisttp\w*|monitor|mwait)$")),
    ("ssse3", re.compile(r"^(pabs[bwd]|palignr|phadd(w|d|sw)|phsub(w|d|sw)|pmaddubsw|pmulhrsw|pshufb|psign[bwd])$")),
    ("sse41", re.compile(r"^(blendv?p[sd]|dpp[sd]|extractps|insertps|movntdqa|mpsadbw|packusdw|pblendvb|pblendw|pcmpeqq|pextr[bdq]|phminposuw|pinsr[bdq]|pmax(sb|sd|ud|uw)|pmin(sb|sd|ud|uw)|pmov[sz]x\w+|pmuldq|pmulld|ptest|round[ps][sd])$")),
    ("sse42", re.compile(r"^(crc32[bwlq]?|pcmp[ei]str[im]|pcmpgtq)$")),
    ("popcnt", re.compile(r"^popcnt[wlq]?$")),
    ("aes", re.compile(r"^aes(enc|enclast|dec|declast|imc|keygenassist)$")),
    ("pclmul", re.compile(r"^pclmul\w*$")),
    ("sha", re.compile(r"^sha(1\w+|256rnds2|256msg[12])$")),
)
PREFIXES = frozenset({
    "rep", "repz", "repe", "repnz", "repne", "lock", "notrack", "bnd",
    "data16", "addr32", "cs", "ds", "es", "fs", "gs", "ss",
})
X86_FORMATS = ("elf64-x86-64", "pei-x86-64", "pe-x86-64")
INSN_RE = re.compile(r"^\s*[0-9a-f]+:\s+(.*)$")
FUNC_RE = re.compile(r"^[0-9a-f]+ <(.+)>:$")
MEMBER_RE = re.compile(r"^(.+):\s+file format (\S+)$")


PSEUDO_PREFIX = re.compile(r"^(\{\w+\}|rex(\.[WRXB]+)?)$")


def extension_of(insn: str) -> str | None:
    """The extension above x86-64 v1 an instruction needs (AT&T, as objdump prints it), or None."""
    parts = insn.split(None, 1)
    evex = False
    while parts and (parts[0] in PREFIXES or PSEUDO_PREFIX.match(parts[0])):
        evex = evex or parts[0] == "{evex}"
        parts = parts[1].split(None, 1) if len(parts) > 1 else []
    if not parts:
        return None
    mnem = parts[0]
    ops = parts[1] if len(parts) > 1 else ""
    if evex or re.search(r"%zmm\d|%k[0-7]\b|%[xy]mm(1[6-9]|2\d|3[01])\b", ops) or EVEX_ONLY.match(mnem):
        return "avx512"
    if FMA.match(mnem):
        return "fma"
    if F16C.match(mnem):
        return "f16c"
    if re.search(r"%ymm\d", ops) or (mnem.startswith("v") and "%xmm" in ops) or mnem in AVX_BARE:
        return "avx"
    for name, names in SCALAR:
        if mnem in names:
            return name
    for name, pat in LEGACY:
        if pat.match(mnem):
            return name
    return None


def allowed_for(member: str, func: str, linked: bool) -> frozenset:
    if member in DISPATCH_OBJECTS:
        return DISPATCH_OBJECTS[member]
    # The mangled RandomX template names are unambiguous, so they hold in an
    # archive member too: VmBase<..., false> lives in virtual_machine.cpp.o.
    for pat, ok in DISPATCH_PATTERNS:
        if pat.search(func):
            return ok
    if not linked:
        return frozenset()
    if func in DISPATCH_FUNCTIONS:
        return DISPATCH_FUNCTIONS[func]
    if func.startswith("_R"):
        for pat, ok in DISPATCH_RUST:
            if pat.search(func):
                return ok
    return frozenset()


def objdump() -> str:
    for name in (os.environ.get("OBJDUMP", ""), "objdump", "x86_64-w64-mingw32-objdump"):
        if name and shutil.which(name):
            return name
    raise SystemExit("isa_scan: objdump not found")


def scan(path: str) -> list[str]:
    """Return one line per (object, function, extension) needing more than v1."""
    out = subprocess.run(
        [objdump(), "-d", "--no-show-raw-insn", path],
        capture_output=True, text=True, errors="replace",
    )
    if out.returncode != 0:
        raise SystemExit(f"isa_scan: objdump failed on {path}: {out.stderr.strip()}")
    linked = not path.endswith((".o", ".obj", ".a", ".lib"))
    hits: dict[tuple[str, str, str], list] = {}
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
        if not m:
            continue
        ext = extension_of(m.group(1))
        if ext is None or ext in allowed_for(member, func, linked):
            continue
        row = hits.setdefault((member, func, ext), [m.group(1).strip(), 0])
        row[1] += 1
    if formats == 0:
        raise SystemExit(f"isa_scan: {path}: objdump found no x86_64 object")
    return [f"{path}: {mm} {ff} [{ee}]: {first} ({n} instruction(s))"
            for (mm, ff, ee), (first, n) in sorted(hits.items())]


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
