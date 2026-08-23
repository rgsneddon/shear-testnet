#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/rgsnedds
export PATH="$HOME/flutter-sdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mkdir -p "$HOME/src"
rsync -a --delete \
  --exclude build --exclude dist --exclude .dart_tool --exclude .git \
  /mnt/c/Users/rgsne/shear/ "$HOME/src/shear/"
cd "$HOME/src/shear/wallet"
flutter pub get
flutter build linux --release --build-name=0.0.1 --build-number=1
echo "LINUX_BUILD_OK"
