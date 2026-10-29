#!/bin/sh
# ShearK-Miner 2.9 (ShearHash-v3 light)
# Public pool: stratum+ssl://pool.shear.digital:443
# This build is for shear-testnet-v12. The pool refuses ShearK older than 2.9.
# Localhost solo stays cleartext: 127.0.0.1:1111
#
# R28 BluNotes: the pool never learns who you are.
# 1) Wallet: turn on "This wallet mines" and copy the Mining address (shm1...).
#    Paste it below as YOUR_MINING_ADDRESS. It stays on this machine; every
#    share carries a fresh one-time key, and only your wallet finds its pay.
# 2) Set --user to a worker name for this box (e.g. rig1). Never an address:
#    ShearK refuses one there, because it would be sent to the pool.
# 3) Threads: ShearK runs one per logical CPU (at most one per 2 MiB of L3).
#    Add --threads N only to leave CPUs free for other work.

cd "$(dirname "$0")"
if [ ! -x ./ShearK-Miner ]; then
  echo "ShearK-Miner missing or not executable. Unpack the ShearK-Miner 2.9 zip for this machine first."
  exit 1
fi

exec ./ShearK-Miner --pool stratum+ssl://pool.shear.digital:443 --user rig1 --blu YOUR_MINING_ADDRESS

# Solo on your own node (npm run solo), cleartext; --solo sends the mining address to your node only:
# exec ./ShearK-Miner --pool 127.0.0.1:1111 --user rig1 --blu YOUR_MINING_ADDRESS --solo
