#!/bin/sh
# Example launch for ShearK-Miner 1.6 (ShearHash-v3 light).
# 1 hash = 1 tx. Default pool is pool.shear.digital:1111 (shear-testnet-v2).
# Replace YOUR_SHE1 and set --threads to this box's CPUs.

cd "$(dirname "$0")"
if [ ! -x ./ShearK-Miner ]; then
  echo "ShearK-Miner missing or not executable. Unpack ShearK-Miner-1.6-macos.zip or -linux.zip first."
  exit 1
fi
exec ./ShearK-Miner --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --dest YOUR_SSA1 --backend jit --threads 8
