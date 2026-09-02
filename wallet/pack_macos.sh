#!/bin/sh
# Classic Mac installer DMG: Shear.app icon + Applications icon (drag onto it).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WALLET="$ROOT/wallet"
DIST="$WALLET/dist"
VER=0.12
APPNAME="Shear"
VOLNAME="Shear $VER"
DMG="$DIST/shear-wallet-$VER-macos.dmg"
RW="$DIST/shear-wallet-$VER-rw.dmg"
BG="$WALLET/pack/dmg-bg.png"
APP="$WALLET/build/macos/Build/Products/Release/$APPNAME.app"

cd "$WALLET"
if [ "${PACK_REBUILD:-}" = "1" ] || [ ! -d "$APP" ]; then
  flutter build macos --release --build-name=$VER --build-number=24
fi
test -d "$APP"
# Wallet does not bundle the official miner. Official miner is a separate release.
if [ -e "$APP/Contents/MacOS/shear-miner" ] || [ -e "$APP/Contents/MacOS/Shear-Miner" ]; then
  echo "wallet app must not include Shear-Miner" >&2
  exit 1
fi

hdiutil detach "/Volumes/$VOLNAME" >/dev/null 2>&1 || true
rm -f "$DMG" "$RW"
mkdir -p "$DIST"

hdiutil create -ov -fs HFS+ -volname "$VOLNAME" -size 100m "$RW" >/dev/null
ATTACH=$(hdiutil attach -nobrowse "$RW")
MNT=$(echo "$ATTACH" | sed -n 's/.*\(\/Volumes\/.*\)$/\1/p')
test -d "$MNT"

# ditto keeps the Developer ID + notarization ticket; cp -R strips them.
ditto "$APP" "$MNT/$APPNAME.app"
# Finder Applications folder icon — user drags Shear.app onto this.
ln -s /Applications "$MNT/Applications"
cat > "$MNT/Move to Applications.txt" <<EOF
Shear wallet $VER

Drag the Shear icon onto the Applications icon.
Do not run it from this disk image, a zip, or Downloads.
EOF
# Keep the advice file for strings/grep; hide it so the window is the two icons.
chflags hidden "$MNT/Move to Applications.txt" || true

python3 "$WALLET/pack/make_dmg_bg.py"
if [ -f "$BG" ]; then
  mkdir -p "$MNT/.background"
  cp "$BG" "$MNT/.background/bg.png"
  chflags hidden "$MNT/.background" || true
  sips -g pixelWidth -g pixelHeight "$MNT/.background/bg.png"
fi

# Background is 540x360. Window chrome ~28px title → 540x388 outer.
# Icon centers stay inside that view (112px icons, ~20px labels).
osascript <<EOF
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {400, 140, 940, 528}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 112
    set text size of theViewOptions to 12
    try
      set background picture of theViewOptions to file ".background:bg.png"
    end try
    set position of item "Shear.app" to {130, 188}
    set position of item "Applications" to {410, 188}
    update without registering applications
    delay 1
    close
  end tell
end tell
EOF

sync
hdiutil detach "$MNT" >/dev/null
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -ov -o "$DMG" >/dev/null
rm -f "$RW"
chmod a+r "$DMG"
echo "wrote $DMG"
ls -lh "$DMG"
hdiutil imageinfo "$DMG" | head
strings "$DMG" | grep -i "Applications" | head

# Keep Dedicated-de /opt/shear-v2/wallet on this pin. Failures stay leftover.
if [ "${SYNC_POOL_WALLET:-1}" = "1" ]; then
  "$WALLET/pack/sync_pool_wallet.sh" || echo "pool wallet sync leftover" >&2
fi
