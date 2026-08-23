#!/bin/sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WALLET="$ROOT/wallet"
MINER="$ROOT/miner/shear-miner"
DIST="$WALLET/dist"
VER=0.0.1
APPNAME="Shear"
STAGE="$DIST/dmg-stage"
DMG="$DIST/shear-wallet-$VER-macos.dmg"

cd "$WALLET"
flutter build macos --release --build-name=$VER --build-number=1
APP="$WALLET/build/macos/Build/Products/Release/$APPNAME.app"
test -d "$APP"

if [ -f "$MINER" ]; then
  cp "$MINER" "$APP/Contents/MacOS/shear-miner"
  chmod +x "$APP/Contents/MacOS/shear-miner"
fi

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/Move to Applications.txt" <<EOF
Shear wallet $VER

Move the Shear app (the extracted executable) into Applications.
Do not run it from this disk image, a zip, or Downloads.

Drag Shear.app onto the Applications folder, then eject this image and open Shear from Applications.
EOF

hdiutil create -volname "Shear $VER" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
echo "wrote $DMG"
ls -lh "$DMG"
hdiutil imageinfo "$DMG" | head
strings "$DMG" | grep -i "Applications" | head
