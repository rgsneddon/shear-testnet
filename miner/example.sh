#!/bin/sh
# Example launch for Shear-Miner 1.1.
# Free to use: no miner fee (1.0 was the last build that took a cut).
# Sends this miner's own hashes/hashrate on each share. Does not wait for ACK per share.
# 1 hash = 1 tx. Default pool is pool.shear.digital:1111 (shear-testnet-v1).
# Replace YOUR_SHE1 and set --threads to this box's CPUs.

cd "$(dirname "$0")"
if [ ! -x ./Shear-Miner ]; then
  echo "Shear-Miner missing or not executable. Unpack Shear-Miner-1.1-linux.zip first."
  exit 1
fi
exec ./Shear-Miner --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --threads 8
