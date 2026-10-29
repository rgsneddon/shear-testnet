#!/usr/bin/env bash
# Configure and build crypto/randomx (librandomx.a) the way every pack ships it.
#
# x86_64 builds pin the ISA baseline, -march=x86-64 -mtune=generic. A toolchain
# can default higher: GitHub's ubuntu-26.04 gcc is configured
# --with-arch-64=x86-64-v3, so plain -O2 there emits AVX2 that faults on CPUs
# without it, and -DARCH=native ties the library to the build machine. RandomX
# still builds its SSSE3 and AVX2 argon2 kernels per file and picks them at run
# time (randomx_get_flags). scripts/isa_scan.py checks the result.
#
# Usage: scripts/randomx_build.sh [extra cmake args...]   e.g. -G "MinGW Makefiles"
# SHEARK_NATIVE=1 builds for this machine only: a local opt-in, never a pack.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RX="$ROOT/crypto/randomx"
BUILD="${RANDOMX_BUILD_DIR:-$RX/build}"
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
case "$(uname -m)" in
  x86_64|amd64|AMD64) BASE="-march=x86-64 -mtune=generic" ;;
  *) BASE="" ;;
esac
if [[ "${SHEARK_NATIVE:-}" == 1 ]]; then
  ARCH=native
  BASE=""
else
  ARCH=default
fi
cmake -S "$RX" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DARCH="$ARCH" \
  -DCMAKE_C_FLAGS="$BASE" -DCMAKE_CXX_FLAGS="$BASE" "$@"
cmake --build "$BUILD" --target randomx -j"$JOBS"
# A no-op build leaves the archive older than an untouched-but-newer source
# checkout; make (sheark-miner/Makefile) compares mtimes, so mark it current.
touch "$BUILD/librandomx.a" 2>/dev/null || true
