#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/rgsnedds
export PATH="$HOME/flutter-sdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mkdir -p "$HOME/src"
rsync -a --delete \
  --exclude build --exclude dist --exclude .dart_tool --exclude .git \
  /mnt/c/Users/rgsne/shear-testnet/ "$HOME/src/shear-testnet/"
cd "$HOME/src/shear-testnet/wallet"
flutter pub get
flutter build linux --release --build-name=0.19 --build-number=31
echo "LINUX_BUILD_OK"
