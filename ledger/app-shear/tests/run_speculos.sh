#!/usr/bin/env bash
# Build the Shear device app and run the Speculos tests (docs/LEDGER-VORTICE.md §7).
# Needs docker. On agent-box run under: flock /root/claude-ci/ledger.lock
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
img=ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest
for dev in nanox nanosp; do
  docker run --rm -v "$here:/app" -w /app "$img" bash -lc \
    "make clean && make BOLOS_SDK=\$${dev^^}_SDK && pip install -q ragger[speculos] cryptography pytest && pytest -q tests --tb=short --device $dev"
done
