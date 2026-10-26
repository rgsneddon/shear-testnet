#!/usr/bin/env bash
# wallet_pin.sh [pin] [build_number]: the wallet release pin and build number
# for a pack workflow, from wallet/pubspec.yaml (version: x.y.0+N), the one
# source. An empty argument takes pubspec's value; a given one must equal it,
# and so must the PKGBUILD's pkgver. Android's versionCode is this +N and
# wallet/pack/zip_windows.py refuses a Windows version.json that is not
# pubspec's x.y.0+N, so no platform keeps its own counter (Russell 26 Oct).
# Writes WALLET_PIN, WALLET_BUILD and WALLET_NAME (x.y.0) to $GITHUB_ENV
# when set, and prints them.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
line="$(tr -d '\r' < "$root/wallet/pubspec.yaml" | sed -n 's/^version: \([0-9]*\.[0-9]*\)\.0+\([0-9]*\)$/\1 \2/p' | head -1)"
[ -n "$line" ] || { echo "::error::wallet/pubspec.yaml has no x.y.0+N version"; exit 1; }
want="${line% *}"; build="${line#* }"
have="$(tr -d '\r' < "$root/wallet/pack/archlinux/PKGBUILD" | sed -n 's/^pkgver=//p' | head -1)"
if [ "$have" != "$want" ]; then echo "::error::PKGBUILD pkgver $have is not pubspec's $want"; exit 1; fi
pin="${1:-$want}"
if [ "$pin" != "$want" ]; then echo "::error::pin $pin is not pubspec's $want"; exit 1; fi
num="${2:-$build}"
if [ "$num" != "$build" ]; then echo "::error::build_number $num is not pubspec's +$build"; exit 1; fi
out="WALLET_PIN=$pin
WALLET_BUILD=$num
WALLET_NAME=$pin.0"
if [ -n "${GITHUB_ENV:-}" ]; then printf '%s\n' "$out" >> "$GITHUB_ENV"; fi
printf '%s\n' "$out"
