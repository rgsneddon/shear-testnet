#!/usr/bin/env bash
# Cross-compile libshear_v3.so for every ABI wallet/android ships.
# abiFilters in android/app/build.gradle.kts is the list. Today that is
# arm64-v8a only. RandomX is built for that ABI, interpreter at runtime,
# 16 KiB ELF alignment. The .so is gitignored. NDK r27d when SHEAR_NDK_PIN=r27d.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MINER="$ROOT/sheark-miner/src"
RX="$ROOT/crypto/randomx"
GRADLE="$ROOT/wallet/android/app/build.gradle.kts"
API="${SHEAR_ANDROID_API:-29}"
JNI="$ROOT/wallet/android/app/src/main/jniLibs"

if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_NDK_ROOT:-}" ]]; then
  ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
fi
if [[ -z "${ANDROID_SDK_ROOT:-}" && -n "${ANDROID_HOME:-}" ]]; then
  ANDROID_SDK_ROOT="$ANDROID_HOME"
fi
if [[ -z "${ANDROID_SDK_ROOT:-}" && -f "$ROOT/wallet/android/local.properties" ]]; then
  ANDROID_SDK_ROOT="$(grep '^sdk.dir=' "$ROOT/wallet/android/local.properties" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
fi
if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_SDK_ROOT:-}" && -d "$ANDROID_SDK_ROOT/ndk" ]]; then
  ANDROID_NDK_HOME="$(find "$ANDROID_SDK_ROOT/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
fi
if [[ -n "${SHEAR_NDK_PIN:-}" ]]; then
  if [[ ! -f "${ANDROID_NDK_HOME:-}/source.properties" ]]; then
    echo "NDK pin is ${SHEAR_NDK_PIN}, source.properties missing under ${ANDROID_NDK_HOME:-unset}" >&2
    exit 1
  fi
  NDK_REL="$(awk '/^Pkg.ReleaseName/{print $3}' "$ANDROID_NDK_HOME/source.properties")"
  if [[ "$NDK_REL" != "$SHEAR_NDK_PIN" ]]; then
    echo "NDK pin is ${SHEAR_NDK_PIN}, found ${NDK_REL:-unknown} at $ANDROID_NDK_HOME" >&2
    exit 1
  fi
fi
if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "$ANDROID_NDK_HOME" ]]; then
  echo "ANDROID_NDK_HOME is not set and no NDK was found. libshear_v3.so was not staged." >&2
  exit 1
fi
TOOLCHAIN="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake"
if [[ ! -f "$TOOLCHAIN" ]]; then
  echo "NDK cmake toolchain missing: $TOOLCHAIN" >&2
  exit 1
fi

mapfile -t ABIS < <(grep -oE 'abiFilters\.add\("[a-zA-Z0-9_-]+"\)' "$GRADLE" | sed -E 's/.*"([^"]+)".*/\1/')
if [[ ${#ABIS[@]} -eq 0 ]]; then
  echo "no abiFilters in $GRADLE" >&2
  exit 1
fi

triple_for() {
  case "$1" in
    arm64-v8a) echo "aarch64-linux-android" ;;
    armeabi-v7a) echo "armv7a-linux-androideabi" ;;
    x86_64) echo "x86_64-linux-android" ;;
    x86) echo "i686-linux-android" ;;
    *) echo "" ;;
  esac
}

PREBUILT="$(find "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d | head -1)"
for abi in "${ABIS[@]}"; do
  triple="$(triple_for "$abi")"
  if [[ -z "$triple" ]]; then
    echo "no clang triple for shipped ABI $abi" >&2
    exit 1
  fi
  CC="$PREBUILT/bin/${triple}${API}-clang"
  CXX="$PREBUILT/bin/${triple}${API}-clang++"
  if [[ ! -x "$CC" || ! -x "$CXX" ]]; then
    echo "NDK clang missing: $CC" >&2
    exit 1
  fi
  BUILD="$HERE/build/android-$abi"
  cmake -S "$RX" -B "$BUILD" \
    -DARCH=default \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DANDROID_ABI="$abi" \
    -DANDROID_PLATFORM="android-${API}" \
    -DANDROID_STL=c++_static \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build "$BUILD" --target randomx -j"$(nproc)"
  RXLIB="$(find "$BUILD" -name 'librandomx.a' | head -1)"
  if [[ -z "$RXLIB" ]]; then
    echo "librandomx.a missing under $BUILD" >&2
    exit 1
  fi
  OUT="$JNI/$abi"
  OBJ="$BUILD/wallet"
  mkdir -p "$OUT" "$OBJ"
  # C sources stay C. clang++ only links, so libstdc++ is static.
  "$CC" -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJ/shear_v3_export.o" "$HERE/shear_v3_export.c"
  "$CC" -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJ/shear_hash.o" "$MINER/shear_hash.c"
  "$CC" -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJ/sha512.o" "$MINER/sha512.c"
  "$CC" -fPIC -O2 -Wall -I"$MINER" -I"$RX/src" -c -o "$OBJ/sha256.o" "$MINER/sha256.c"
  "$CXX" -shared -fPIC -O2 \
    -static-libstdc++ \
    -Wl,-z,max-page-size=16384 \
    -o "$OUT/libshear_v3.so" \
    "$OBJ/shear_v3_export.o" "$OBJ/shear_hash.o" "$OBJ/sha512.o" "$OBJ/sha256.o" \
    "$RXLIB" \
    -pthread -lm
  echo "staged $OUT/libshear_v3.so"
done
