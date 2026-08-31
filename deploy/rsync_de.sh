#!/usr/bin/env bash
# Push Amelia source to Dedicated-de without overwriting Linux native binaries.
# Never rsync Darwin Mach-O as ShearK-Miner / shearhash.node (that made hash_failed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${SHEAR_DE_HOST:-de}"
DEST="${SHEAR_DE_DEST:-/opt/shear-v2}"
rsync -az \
  --exclude node_modules \
  --exclude '.git/' \
  --exclude 'crypto/randomx/build/' \
  --exclude 'crypto/randomx/build-win/' \
  --exclude 'crypto/randomx/build-mingw/' \
  --exclude 'crypto/native/shearhash.node' \
  --exclude 'sheark-miner/ShearK-Miner' \
  --exclude 'sheark-miner/ShearK-Miner.exe' \
  --exclude 'miner/Shear-Miner' \
  --exclude 'miner/Shear-Miner.exe' \
  --exclude 'wallet/build/' \
  --exclude 'wallet/android/build/' \
  --exclude 'wallet/dist/' \
  --exclude 'dist/' \
  --exclude '.shear/' \
  --exclude '*.log' \
  "$ROOT/" "$HOST:$DEST/"
echo "rsync_ok $HOST:$DEST (Darwin binaries excluded)"
