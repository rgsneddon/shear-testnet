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
ADMIT="$HOME/src/shear-testnet/crypto/native/admit"
cargo build --release --manifest-path "$ADMIT/Cargo.toml"
DEFINE="$(python3 "$HOME/src/shear-testnet/crypto/native/stamp_admit_pin.py" --define "$ADMIT/target/release/libshear_admit.so")"
flutter build linux --release --build-name=0.30 --build-number=42 $DEFINE
echo "LINUX_BUILD_OK"
