#!/usr/bin/env bash
# FS-1 spend prove/verify timing on a USB-attached Android phone.
# Cross-compiles shear-fs1's fs1_spend_bench for arm64 with the NDK, pushes it
# to /data/local/tmp over adb, runs it, and saves the JSON lines locally.
# Windows: crypto/native/phone-bench.ps1 does the same from PowerShell.
#
#   crypto/native/phone-bench.sh [leaves] [runs] [threads] [inputs]
#   defaults: 4096 3 0 1,2,5,8   (threads 0 = every core)
#
# SHEAR_BENCH_BIN=<path> skips the build and pushes an already built binary.
# The binary uses the same prove_spend/verify_spend as libshear_admit.so.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/vendor/monero-oxide-77788c3"
API="${SHEAR_ANDROID_API:-29}"
LEAVES="${1:-4096}"
RUNS="${2:-3}"
THREADS="${3:-0}"
INPUTS="${4:-1,2,5,8}"
REMOTE=/data/local/tmp/fs1_spend_bench
OUT="${SHEAR_BENCH_OUT:-$HERE/phone-bench-$(date +%Y%m%d-%H%M%S).jsonl}"

command -v adb >/dev/null 2>&1 || { echo "adb not found. Install Android platform-tools." >&2; exit 1; }

BIN="${SHEAR_BENCH_BIN:-}"
if [[ -z "$BIN" ]]; then
  if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_NDK_ROOT:-}" ]]; then
    ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
  fi
  if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME/ndk" ]]; then
    ANDROID_NDK_HOME="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
  fi
  if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "$ANDROID_NDK_HOME" ]]; then
    echo "Set ANDROID_NDK_HOME (NDK r27d) or SHEAR_BENCH_BIN." >&2
    exit 1
  fi
  PREBUILT="$(find "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d | head -1)"
  LINKER="$PREBUILT/bin/aarch64-linux-android${API}-clang"
  export CC_aarch64_linux_android="$LINKER"
  export AR_aarch64_linux_android="$PREBUILT/bin/llvm-ar"
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$LINKER"
  rustup target add aarch64-linux-android >/dev/null 2>&1 || true
  cargo build --release --target aarch64-linux-android \
    --manifest-path "$VENDOR/Cargo.toml" -p shear-fs1 --features bench --bin fs1_spend_bench
  BIN="$VENDOR/target/aarch64-linux-android/release/fs1_spend_bench"
fi

STATE="$(adb get-state 2>/dev/null || true)"
if [[ "$STATE" != "device" ]]; then
  echo "No authorized phone on adb (state: ${STATE:-none}). Enable USB debugging and accept the prompt." >&2
  exit 1
fi

echo "phone: $(adb shell getprop ro.product.model | tr -d '\r') / $(adb shell getprop ro.soc.model | tr -d '\r') / Android $(adb shell getprop ro.build.version.release | tr -d '\r')"
adb push "$BIN" "$REMOTE" >/dev/null
adb shell chmod 755 "$REMOTE"
adb shell "$REMOTE" "$LEAVES" "$RUNS" "$THREADS" "$INPUTS" | tr -d '\r' | tee "$OUT"
adb shell rm -f "$REMOTE"
echo "saved $OUT"
