#!/bin/sh
# Copy this cut's wallet sources onto Dedicated-de (/opt/shear-v2/wallet).
# Run on every wallet pin so the pool tree is never left on an old cut.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WALLET="$ROOT/wallet"
HOST="${SHEAR_POOL_HOST:-de}"
DEST="${SHEAR_POOL_WALLET:-/opt/shear-v2/wallet}"
VER="$(sed -n "s/^const kWalletVersion = '\\(.*\\)';/\\1/p" "$WALLET/lib/main.dart" | head -1)"
test -n "$VER"
test -f "$WALLET/lib/main.dart"
test -f "$WALLET/lib/shear_eip712.dart"

RSYNC_EXCLUDES="--exclude build --exclude dist --exclude .dart_tool --exclude .git"
RSYNC_EXCLUDES="$RSYNC_EXCLUDES --exclude android/build --exclude ios/Pods --exclude macos/Pods"
RSYNC_EXCLUDES="$RSYNC_EXCLUDES --exclude .flutter-plugins-dependencies --exclude .DS_Store"

# shellcheck disable=SC2086
rsync -a --delete $RSYNC_EXCLUDES "$WALLET/" "$HOST:$DEST/"
# pin snapshot next to the live tree
# shellcheck disable=SC2086
rsync -a --delete $RSYNC_EXCLUDES "$WALLET/" "$HOST:${DEST}-${VER}/"
echo "POOL_WALLET_OK $VER -> $HOST:$DEST and ${DEST}-${VER}"
