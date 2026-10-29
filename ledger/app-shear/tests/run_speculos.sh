#!/usr/bin/env bash
# Build the Shear device app and run the Speculos tests (docs/LEDGER-VORTICE.md §7).
# On agent-box: flock /root/claude-ci/ledger.lock ledger/app-shear/tests/run_speculos.sh
# Docker there runs with iptables off and no bridge, so containers use --network host.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
img=ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest
devices=${DEVICES:-nanox nanosp stax flex}
docker run --rm --network host -v "$here:/app" -w /app "$img" bash -lc '
  set -e
  [ -d .git ] || git init -q
  for dev in '"$devices"'; do
    case $dev in nanox) sdk=$NANOX_SDK;; nanosp) sdk=$NANOSP_SDK;; stax) sdk=$STAX_SDK;; flex) sdk=$FLEX_SDK;; esac
    make -j4 BOLOS_SDK=$sdk >/tmp/build-$dev.log 2>&1 || { tail -40 /tmp/build-$dev.log; exit 1; }
    echo "built $dev"
  done
  pip install -q --break-system-packages cryptography >/dev/null 2>&1 || true
  for dev in '"$devices"'; do
    pytest -q tests --tb=short --device $dev
  done'
