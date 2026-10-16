#!/usr/bin/env bash
# Build the pinned libsodium.so for the Android wallet's jniLibs from the
# tarball in wallet/android/libsodium.lock.json. The tarball must match the
# pinned sha256; with minisign installed (or SHEAR_REQUIRE_MINISIGN=1) its
# signature must also verify against libsodium's published key. The .so and
# its .sha256 record are gitignored. A matching existing build is reused.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LOCK="$ROOT/wallet/android/libsodium.lock.json"
JNI="$ROOT/wallet/android/app/src/main/jniLibs"
CACHE="${SHEAR_LIBSODIUM_CACHE:-$ROOT/wallet/build/libsodium-android}"

lock() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v=eval("d"+sys.argv[2]); print("\n".join(v) if isinstance(v,list) else (" ".join(v) if isinstance(v,dict) else v))' "$LOCK" "$1"; }
VERSION="$(lock '["version"]')"
SHA256="$(lock '["sha256"]')"
PUBKEY="$(lock '["minisign_public_key"]')"
API="$(lock '["android_api"]')"
NDK_PIN="$(lock '["ndk"]')"
TARBALL="libsodium-$VERSION.tar.gz"

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
if [[ -z "${ANDROID_NDK_HOME:-}" || ! -f "$ANDROID_NDK_HOME/source.properties" ]]; then
  echo "ANDROID_NDK_HOME is not set and no NDK was found under ANDROID_HOME." >&2
  exit 1
fi
NDK_REL="$(awk '/^Pkg.ReleaseName/{print $3}' "$ANDROID_NDK_HOME/source.properties")"
NDK_REV="$(awk -F' = ' '/^Pkg.Revision/{print $2}' "$ANDROID_NDK_HOME/source.properties")"
NDK_ID="${NDK_REL:-$NDK_REV}"
if [[ -n "${SHEAR_NDK_PIN:-}" && "$NDK_ID" != "$SHEAR_NDK_PIN" ]]; then
  echo "NDK pin is ${SHEAR_NDK_PIN}, found ${NDK_ID:-unknown} at $ANDROID_NDK_HOME" >&2
  exit 1
fi
if [[ "$NDK_ID" != "$NDK_PIN" ]]; then
  echo "warning: libsodium.lock.json pins NDK $NDK_PIN, building with $NDK_ID" >&2
fi
PREBUILT="$(find "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d | head -1)"

record() {
  printf 'sha256 %s\nlibsodium %s\nsource_sha256 %s\nndk %s\nandroid_api %s\nabi %s\n' \
    "$(sha256sum "$1" | cut -d' ' -f1)" "$VERSION" "$SHA256" "$NDK_ID" "$API" "$2"
}

fresh() {
  local so="$1" rec="$1.sha256" abi="$2"
  [[ -f "$so" && -f "$rec" ]] && [[ "$(record "$so" "$abi")" == "$(cat "$rec")" ]]
}

fetch() {
  mkdir -p "$CACHE"
  local dst="$CACHE/$TARBALL"
  if [[ ! -f "$dst" ]] || ! echo "$SHA256  $dst" | sha256sum -c --status; then
    rm -f "$dst"
    local ok=
    while read -r url; do
      if curl -fsSL --retry 3 -o "$dst.part" "$url"; then
        if echo "$SHA256  $dst.part" | sha256sum -c --status; then
          mv "$dst.part" "$dst"
          ok=1
          if command -v minisign >/dev/null 2>&1 || [[ "${SHEAR_REQUIRE_MINISIGN:-0}" == "1" ]]; then
            curl -fsSL --retry 3 -o "$dst.minisig" "$url.minisig"
          fi
          break
        fi
        echo "sha256 mismatch from $url; refusing it" >&2
      fi
      rm -f "$dst.part"
    done < <(lock '["urls"]')
    [[ -n "$ok" ]] || { echo "could not fetch $TARBALL with sha256 $SHA256" >&2; exit 1; }
  fi
  echo "$SHA256  $dst" | sha256sum -c --status || { echo "cached $dst does not match the pin" >&2; exit 1; }
  if command -v minisign >/dev/null 2>&1; then
    [[ -f "$dst.minisig" ]] || curl -fsSL --retry 3 -o "$dst.minisig" "$(lock '["urls"][0]').minisig"
    minisign -Vm "$dst" -x "$dst.minisig" -P "$PUBKEY" >/dev/null
    echo "minisign ok $TARBALL"
  elif [[ "${SHEAR_REQUIRE_MINISIGN:-0}" == "1" ]]; then
    echo "SHEAR_REQUIRE_MINISIGN=1 but minisign is not installed" >&2
    exit 1
  fi
  echo "$dst"
}

for ABI in $(lock '["abis"]'); do
  OUT="$JNI/$ABI/libsodium.so"
  if fresh "$OUT" "$ABI"; then
    echo "libsodium $VERSION for $ABI is current: $OUT"
    continue
  fi
  HOST="$(lock "[\"abis\"][\"$ABI\"][\"host\"]")"
  ABI_CFLAGS="$(lock "[\"abis\"][\"$ABI\"][\"cflags\"]")"
  SRC_TGZ="$(fetch | tail -1)"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  tar -xzf "$SRC_TGZ" -C "$WORK"
  SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
  (
    cd "$SRC"
    export CC="$PREBUILT/bin/${HOST}${API}-clang"
    export AR="$PREBUILT/bin/llvm-ar" RANLIB="$PREBUILT/bin/llvm-ranlib" STRIP="$PREBUILT/bin/llvm-strip"
    export CFLAGS="$ABI_CFLAGS"
    # 16 KiB ELF alignment so the .so loads on Android 15+ devices.
    export LDFLAGS="-Wl,-z,max-page-size=16384"
    ./configure --host="$HOST" --prefix="$WORK/prefix" --disable-soname-versions \
      --disable-static --enable-shared >/dev/null
    make -j"$(nproc)" install >/dev/null
  )
  BUILT="$WORK/prefix/lib/libsodium.so"
  "$PREBUILT/bin/llvm-strip" --strip-unneeded "$BUILT"
  grep -aq "$VERSION" "$BUILT" || { echo "built libsodium.so does not report $VERSION" >&2; exit 1; }
  WANT="$(lock "[\"abis\"][\"$ABI\"][\"so_sha256_with_pinned_ndk\"]")"
  GOT="$(sha256sum "$BUILT" | cut -d' ' -f1)"
  if [[ "$NDK_ID" == "$NDK_PIN" && "$GOT" != "$WANT" ]]; then
    echo "libsodium.so for $ABI is $GOT; NDK $NDK_PIN must reproduce $WANT" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$OUT")"
  cp "$BUILT" "$OUT"
  record "$OUT" "$ABI" > "$OUT.sha256"
  rm -rf "$WORK"
  trap - EXIT
  echo "staged libsodium $VERSION ($ABI, NDK $NDK_ID) at $OUT"
done
