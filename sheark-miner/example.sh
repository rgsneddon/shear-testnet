#!/bin/sh
# ShearK-Miner 2.9 (ShearHash-v3 light)
# Public pool: stratum+ssl://pool.shear.digital:443
# This build is for shear-testnet-v12. The pool refuses ShearK older than 2.9.
# YOUR_SSA1.worker is a placeholder. Keep each host's worker name and payout address.
# Localhost solo stays cleartext: stratum+tcp://127.0.0.1:1111
#
# Paid login is an ssa1 dest the wallet exported (Copy dest), then .worker.
# she1 without --dest is unpaid. Never use shear1.
#
# 1) Wallet: Copy dest. Paste it below as YOUR_SSA1.
# 2) Change .worker to a unique name for this box (e.g. .vps1).
# 3) Threads: ShearK runs one per logical CPU (at most one per 2 MiB of L3).
#    Add --threads N only to leave CPUs free for other work.
# 4) Wallet: turn on "This wallet mines", copy the Mining address, paste it as
#    YOUR_MINING_ADDRESS. Each share then carries a fresh one-time key (BluNotes);
#    without --blu the pool refuses every share (need_key).

cd "$(dirname "$0")"
if [ ! -x ./ShearK-Miner ]; then
  echo "ShearK-Miner missing or not executable. Unpack the ShearK-Miner 2.9 zip for this machine first."
  exit 1
fi

exec ./ShearK-Miner --pool stratum+ssl://pool.shear.digital:443 --user YOUR_SSA1.worker --blu YOUR_MINING_ADDRESS --backend jit-full

# Solo on your own node (npm run solo), cleartext; --solo sends the mining address to your node only:
# exec ./ShearK-Miner --pool 127.0.0.1:1111 --user YOUR_SSA1.solo --blu YOUR_MINING_ADDRESS --solo --backend jit-full

# she1 login is RAM-only and must also pass --dest (the same Copy dest):
# exec ./ShearK-Miner --pool stratum+ssl://pool.shear.digital:443 --user YOUR_SHE1.worker --dest YOUR_SSA1 --blu YOUR_MINING_ADDRESS --backend jit
