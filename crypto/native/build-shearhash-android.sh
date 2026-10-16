#!/usr/bin/env bash
# Cross-compile libshearhash.so for every ABI the wallet can ship and stage
# each one under jniLibs with a SHA-256 sidecar. The libraries are gitignored.
# Android integrity of the packaged soname is the APK signature. The sidecar
# is what the jniLibs test checks, same as libshear_admit.so.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RX="$ROOT/crypto/randomx"
MINER="$ROOT/sheark-miner/src"
JNI="$ROOT/wallet/android/app/src/main/jniLibs"
API="${SHEAR_ANDROID_API:-29}"

if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_NDK_ROOT:-}" ]]; then
  ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
fi
if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "$ANDROID_NDK_HOME" ]]; then
  echo "ANDROID_NDK_HOME is not set." >&2
  exit 1
fi

PREBUILT="$(find "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [[ -z "$PREBUILT" ]]; then
  echo "NDK llvm prebuilt is missing under $ANDROID_NDK_HOME" >&2
  exit 1
fi

declare -a ABIS=(armeabi-v7a arm64-v8a x86 x86_64)
declare -A TRIPLE=(
  [armeabi-v7a]=armv7a-linux-androideabi
  [arm64-v8a]=aarch64-linux-android
  [x86]=i686-linux-android
  [x86_64]=x86_64-linux-android
)

for abi in "${ABIS[@]}"; do
  triple="${TRIPLE[$abi]}"
  clang="$PREBUILT/bin/${triple}${API}-clang"
  if [[ ! -x "$clang" ]]; then
    echo "missing $clang" >&2
    exit 1
  fi
  outdir="$JNI/$abi"
  so="$outdir/libshearhash.so"
  # A second Gradle pass must not change the digest already compiled into the APK.
  if [[ -f "$so" && "$so" -nt "$HERE/shearhash_wallet.c" && "$so" -nt "$MINER/shear_hash.c" ]]; then
    python3 "$HERE/stamp_shearhash_pin.py" "$so"
    echo "kept $so"
    continue
  fi
  build="$RX/build-android-$abi"
  cmake -S "$RX" -B "$build" \
    -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI="$abi" \
    -DANDROID_PLATFORM="android-$API" \
    -DCMAKE_BUILD_TYPE=Release \
    -DARCH=default \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  cmake --build "$build" -j"$(nproc)"
  lib="$(find "$build" -name 'librandomx.a' | head -1)"
  if [[ -z "$lib" ]]; then
    echo "librandomx.a missing for $abi" >&2
    exit 1
  fi
  mkdir -p "$outdir"
  "$clang" -shared -fPIC -O2 \
    -Wl,-z,max-page-size=16384 \
    -I "$MINER" -I "$RX/src" \
    -o "$outdir/libshearhash.so" \
    "$HERE/shearhash_wallet.c" \
    "$MINER/shear_hash.c" \
    "$MINER/sha512.c" \
    "$MINER/sha256.c" \
    "$lib" \
    -static-libstdc++ -llog
  python3 "$HERE/stamp_shearhash_pin.py" "$outdir/libshearhash.so"
  echo "staged $outdir/libshearhash.so"
done
