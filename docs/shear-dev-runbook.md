# shear-dev runbook

Private live-client network. Magic is `shear-dev`. It is not shear-testnet-v12 and it is not a v13 rename. Coins on this book are not v12 coins. Do not point it at a Continuum datadir.

The dev pool process is backend only: stratum, share accounting, payouts, and IPC. This runbook does not add a dev web UI, banner, or dashboard.

## Clock

Profile S2. Target block time is 9 seconds. ASERT half-life is 720,000 ms. A header may sit at most 5,000 ms ahead of the verifier. One epoch is 288,000 ms of chain time, read from the block timestamp on the same vortex clock v12 uses. It is not 32 blocks. Vote close is 24 target intervals (24 × 9,000 ms) into the epoch. The table records 64 withdraw slots of 9 seconds. That span is longer than the 288,000 ms epoch, so the shear-dev gate uses the largest whole count that finishes strictly inside the epoch: 15 period slots (15 × 18,000 ms) and 31 slots of 9,000 ms. v12 and mainnet slot counts are unchanged. The dev P2P ban is 60 seconds.

Genesis difficulty for this book is bits 12. A RandomX-light bench on one 4-vCPU host (huge pages unavailable, JIT) measured 45.65 H/s at 1 thread, 94.53 H/s at 2 threads, and 246.53 H/s at 4 threads. Three cache rebuilds averaged 0.108 s. Steal was 0 during each window. Two hosts at the 4-thread rate are 246.53 × 2 ≈ 493 H/s, and 2^12 / 493 ≈ 8.3 s. The floor is 10. The chosen seed is 12. ASERT moves the target after genesis. v12 and mainnet stay at bits 17. The dev fingerprint's positional GENESIS_BITS slot is 12. The v12 slot stays 17.

NTP is required. Keep clocks within 500 ms. The header-ahead cap is 5 seconds, so a node that is minutes off will orphan every header it sees.

## Datadir

Each node gets its own directory. Do not reuse `testnet-v11`, and do not reuse a Continuum directory.

Suggested paths:

- Linux: `/var/lib/shear/dev-<epoch>`
- Windows: `C:\ShearDev\node-<epoch>`

The default leaf, when `SHEAR_DATA` is unset and `SHEAR_NETWORK=shear-dev`, is `shear-dev` (`~/.shear/shear-dev`, or `%APPDATA%\Shear\shear-dev` on Windows). The wallet dev session is `Shear/shear-dev/session.json`, not `Shear/session.json`.

Do not delete a datadir to “reset” a peer. A new epoch gets a new directory.

## Ports

The hosting firewall already allows 22, 80, 443, 1111, 8080, and 30303. Deployment units set `SHEAR_P2P_PORT=30303` and `SHEAR_STRATUM=1111` (or `SHEAR_STRATUM_PORT=1111`) so the process binds those open ports. An unset env does not. The code defaults are P2P 31303 and stratum 11211, so a dev process does not silently take the v12 ports. Those ports are process settings. They are not chain parameters and they are not in the fingerprint.

| service | code default | deployment | override |
| --- | --- | --- | --- |
| P2P | 31303 | 30303 | `SHEAR_P2P_PORT` |
| stratum | 11211 | 1111 | `SHEAR_STRATUM` |
| RPC | 18432 | 18432 | `SHEAR_RPC_PORT` |
| pool IPC | 31314 | loopback only | `SHEAR_P2P_IPC` |

Each book has its own host. Deployment binds P2P 30303 and stratum 1111. The book magic and the IPC handshake refuse a peer from the other network.

Loopback stays off the public firewall. RPC is 18432. The dev row does not carry a node `ipcPort`. The sidecar dial is the dev row's `poolIpcPort`, 31314 (`127.0.0.1:31314`), and that is the port the dev pool listens on when `SHEAR_P2P_IPC` is unset. v12 pool IPC stays `30313` and attaches only when `SHEAR_P2P_IPC` is set. Pool HTTP stays on loopback `18188`. The pool stratum code default is 11211. The unit sets 1111. The legacy `shear-pool.service` on 77.42.91.84 stays disabled. The dev pool must never run alongside it.

Do not open 18432 or 31314. Continuum’s datadir, session file, and magic stay untouched. Continuum’s public ports are 30303 and 1111; the unit sets those explicitly, and this book still runs on its own machine.

## Seeds

`shear-dev` has no default seeds. An unset `SHEAR_SEEDS` dials nobody. On PowerShell, clearing a variable deletes it; that must not fall back to `p2p.shear.digital`. Pass the peer list explicitly when you want connections:

```
SHEAR_NETWORK=shear-dev
SHEAR_SEEDS=10.0.0.2:30303,10.0.0.3:30303
```

## First block

The first node mints genesis. Every other node syncs that chain before it mines. Start miners only after the tip hash matches the first node. There is no published genesis pin in this tree.

EVM chain id is 2799. The dev Reserve artifact is `contracts/dev/ReserveDev.json`. `shear-dev` is not in `RESERVE_BOOKS`. `contracts/Reserve.json` stays the v12 and mainnet artifact.

## Dev pool

Paper only. Do not deploy it. A separate host and a subdomain (not a path on the v12 pool) would be the place for it. The entry is `pool/src/main_dev.js`. It refuses to start unless the book magic is `shear-dev`, refuses the live v12 fee and admin destination, and refuses an operator seed file outside its own datadir. Payout sweep is 120 seconds. The one-hour env floor does not apply. The minimum payout stays π. It must never run alongside the legacy `shear-pool.service` on 77.42.91.84, which stays disabled.

The existing pool web UI is unchanged. Do not serve a dev banner from this tree.
