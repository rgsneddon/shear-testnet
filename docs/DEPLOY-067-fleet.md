# Fleet deploy 2026-10-03 — p2p catch-up eligibility

Russell GO covered this restart. Book `shear-testnet-v10` was not wiped. `tip.json` was not copied. `crypto/spend.js` was not overwritten. Fee-payout ssa1 was not rotated. `sheark-v4-afk` was not restarted. Contabo was skipped.

Backup on each host: `/opt/shear-v4/node/src/p2p.js.bak-pre-stallfix-20261003T003936Z` (previous md5 `7606cc3b88263b3112a5114f5eefa20b`, 75986 bytes).

Deployed `/opt/shear-v4/node/src/p2p.js` md5 `de640956169e06b3fc9d648fdcb4b312`, 76461 bytes (LF). `node/src/status.js` was already `91bddc3d528b8b00856c87846484614b` (5062 bytes) and was left in place. `crypto/spend.js` stayed `9af20e6d8744a72cdd0fb3ca4e3d3bd3` (16814 bytes) on every host.

Bounce order and ActiveEnterTimestamp (UTC):

| Host | Unit | Entered | MainPID |
| --- | --- | --- | --- |
| p2p-a 157.180.70.110 | shear-node | 2026-10-03 00:41:26 | 470459 |
| p2p-b 2.28.8.89 | shear-node | 2026-10-03 00:41:28 | 401003 |
| p2p-c 178.156.222.223 | shear-node | 2026-10-03 00:41:30 | 395948 |
| ubuntu-soak 2.28.39.91 | shear-node | 2026-10-03 00:41:31 | 253558 |
| fedora-soak 178.105.75.124 | shear-node | 2026-10-03 00:41:32 | 125444 |
| shear-pool 77.42.91.84 | shear-p2p | 2026-10-03 00:41:34 | 807725 |
| shear-pool 77.42.91.84 | shear-pool | 2026-10-03 00:41:35 | 807810 |

Post-restart `tip.json` on all six datadirs, including the pool sidecar: height **673**, hash `0000121878a8e6f1e212cb67777cdd586c327f75875bc2b71faa3ef9eb392dad`. Journal status from the new PIDs: `want=0`, `ibd=false`, magic `shear-testnet-v10`. `peerMaxHeight` on the node units is 673. `syncEligiblePeers` is 0 and `syncPeerHeight` is null, because the mesh is already on that sealed tip and no later body has been served. The pool unit reports `p2p=0` (the sidecar owns the P2P port) and was accepting shares after the restart (`accepted` climbing, `rejected=0`).
