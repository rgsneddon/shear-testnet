#!/bin/sh
# Example launch for Shear miner 0.1.7.
# Sends this miner's own hashes/hashrate on each share. Does not wait for ACK per share.
# 1 hash = 1 tx. Default pool is pool.shear.digital:1111 (shear-testnet-v1).
# Replace YOUR_SHE1 and set --threads to this box's CPUs.

cd "$(dirname "$0")"
if [ ! -x ./shear-miner ]; then
  echo "shear-miner missing or not executable. Unpack shear-miner-0.1.7-linux.zip first."
  exit 1
fi
exec ./shear-miner --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --threads 8
