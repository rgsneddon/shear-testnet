#!/usr/bin/env bash
# Cross-compile libshear_admit.so for Android arm64-v8a and stage it where
# the Flutter Gradle build packages jniLibs. No secrets are written.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ADMIT="$HERE/admit"
OUT="$ROOT/wallet/android/app/src/main/jniLibs/arm64-v8a"
API="${SHEAR_ANDROID_API:-29}"

if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_NDK_ROOT:-}" ]]; then
  ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
fi
if [[ -z "${ANDROID_SDK_ROOT:-}" && -n "${ANDROID_HOME:-}" ]]; then
  ANDROID_SDK_ROOT="$ANDROID_HOME"
fi
if [[ -z "${ANDROID_SDK_ROOT:-}" && -f "$ROOT/wallet/android/local.properties" ]]; then
  ANDROID_SDK_ROOT="$(grep '^sdk.dir=' "$ROOT/wallet/android/local.properties" | head -1 | cut -d= -f2- | tr -d '\r')"
fi
if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_SDK_ROOT:-}" && -d "$ANDROID_SDK_ROOT/ndk" ]]; then
  ANDROID_NDK_HOME="$(find "$ANDROID_SDK_ROOT/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
fi

if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "$ANDROID_NDK_HOME" ]]; then
  echo "ANDROID_NDK_HOME is not set and no NDK was found under ANDROID_HOME." >&2
  echo "Install the Android NDK, then re-run make -C crypto/native android-arm64." >&2
  exit 1
fi

PREBUILT="$(find "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [[ -z "$PREBUILT" || ! -x "$PREBUILT/bin/aarch64-linux-android${API}-clang" ]]; then
  echo "NDK llvm prebuilt is missing aarch64-linux-android${API}-clang under $ANDROID_NDK_HOME" >&2
  exit 1
fi

LINKER="$PREBUILT/bin/aarch64-linux-android${API}-clang"
export PATH="$PREBUILT/bin:$PATH"
export CC_aarch64_linux_android="$LINKER"
export AR_aarch64_linux_android="$PREBUILT/bin/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$LINKER"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_AR="$PREBUILT/bin/llvm-ar"
# 16KiB ELF alignment so the .so loads on Android 15+ devices. Not a proof parameter.
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384"

if command -v rustup >/dev/null 2>&1; then
  rustup target add aarch64-linux-android
fi

# admit-v3 stays off. The wallet .so must not export shear_admit_prove_v3.
cargo build --release --target aarch64-linux-android --manifest-path "$ADMIT/Cargo.toml"
mkdir -p "$OUT"
cp "$ADMIT/target/aarch64-linux-android/release/libshear_admit.so" "$OUT/libshear_admit.so"
python3 "$HERE/stamp_admit_pin.py" "$OUT/libshear_admit.so"
echo "staged $OUT/libshear_admit.so"
