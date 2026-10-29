#!/usr/bin/env bash
# Reproducible Ledger vortice bundle (docs/LEDGER-VORTICE.md §8): sorted entries,
# mtime 0, uid/gid 0, gzip -n. Prints the bundle path and its SHA-256.
# Minting the vort1 waits for Russell's GO. This script never mints.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/artifacts/ledger-vortice.tar.gz}
files=(
  docs/LEDGER-VORTICE.md
  vortices/ledger/donate-addresses.json
  wallet/lib/ledger_hw/ledger_transport.dart
  wallet/lib/ledger_hw/ledger_chains.dart
)
cd "$root"
manifest=$(mktemp)
for f in "${files[@]}"; do
  printf '%s  %s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(wc -c < "$f")" "$f"
done > "$manifest"
cp "$manifest" vortices/ledger/MANIFEST.sha256
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=a+rX,u+w,go-w \
  -cf - vortices/ledger/MANIFEST.sha256 "${files[@]}" | gzip -n -9 > "$out"
rm -f "$manifest"
echo "$out"
sha256sum "$out"
