#!/bin/bash
# Fat release APK. Same applicationId as 0.31; versionCode must exceed 47.
# Split APKs caused "App not installed" on 0.31 sideloads — do not --split-per-abi.
set -euo pipefail
WALLET="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(sed -n "s/^const kWalletVersion = '\\(.*\\)';/\\1/p" "$WALLET/lib/main.dart" | head -1)"
VER="${VER:-0.33}"
BUILD_NUMBER="${BUILD_NUMBER:-71}"
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
echo "ANDROID_APK_OK $OUT $(wc -c < "$OUT")"
