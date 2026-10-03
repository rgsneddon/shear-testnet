#!/bin/bash
# One fat release APK for public sideload. Same applicationId. versionCode is
# the pubspec +N and must exceed the last published code (91). Never default
# BUILD_NUMBER to 49. Per-ABI split packages are not produced.
set -euo pipefail
WALLET="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(sed -n "s/^const kWalletVersion = '\\(.*\\)';/\\1/p" "$WALLET/lib/main.dart" | head -1 | tr -d '\r')"
VER="${VER:-0.67}"
PUBSPEC_PLUS="$(sed -n 's/^version: .*+\([0-9][0-9]*\).*/\1/p' "$WALLET/pubspec.yaml" | head -1 | tr -d '\r')"
if [ -z "${PUBSPEC_PLUS}" ]; then
  echo "ANDROID_BUILD_NUMBER_MISSING pubspec +N" >&2
  exit 1
fi
if [ -n "${BUILD_NUMBER:-}" ] && [ "$BUILD_NUMBER" != "$PUBSPEC_PLUS" ]; then
  echo "ANDROID_BUILD_NUMBER_MISMATCH env=$BUILD_NUMBER pubspec=$PUBSPEC_PLUS" >&2
  exit 1
fi
BUILD_NUMBER="$PUBSPEC_PLUS"
if [ "$BUILD_NUMBER" = "49" ]; then
  echo "ANDROID_BUILD_NUMBER_REFUSED 49" >&2
  exit 1
fi
if [ "$BUILD_NUMBER" -le 91 ]; then
  echo "ANDROID_BUILD_NUMBER_NOT_ABOVE_91 $BUILD_NUMBER" >&2
  exit 1
fi
FLUTTER_NAME="$VER"
case "$FLUTTER_NAME" in
  *.*.*) ;;
  *.*) FLUTTER_NAME="${FLUTTER_NAME}.0" ;;
esac
cd "$WALLET"
flutter build apk --release --build-name="$FLUTTER_NAME" --build-number="$BUILD_NUMBER"
SRC="$WALLET/build/app/outputs/flutter-apk/app-release.apk"
test -f "$SRC"
DIST="$WALLET/dist"
mkdir -p "$DIST"
OUT="$DIST/shear-wallet-$VER-android.apk"
cp -f "$SRC" "$OUT"
# also copy to repo dist/ for inspect tests
mkdir -p "$WALLET/../dist"
cp -f "$SRC" "$WALLET/../dist/shear-wallet-$VER-android.apk"
python3 "$WALLET/pack/check_android_release.py" "$OUT"
echo "ANDROID_APK_OK $OUT $(wc -c < "$OUT")"
