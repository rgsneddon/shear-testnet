# shear-dev runbook

Private live-client network. Magic is `shear-dev`. It is not shear-testnet-v12 and it is not a v13 rename. Coins on this book are not v12 coins. Do not point it at a Continuum datadir.

The dev pool process is backend only: stratum, share accounting, payouts, and IPC. This runbook does not add a dev web UI, banner, or dashboard.

## Clock

Profile S2. Target block time is 9 seconds. ASERT half-life is 720,000 ms. A header may sit at most 5,000 ms ahead of the verifier. One epoch is 32 blocks, 288,000 ms. The withdraw window is 64 slots of 9 seconds. Vote close is block 24. The dev P2P ban is 60 seconds.

Genesis difficulty stays at bits 17 until a host bench says otherwise. That bench has not been run.

NTP is required. Keep clocks within 500 ms. The header-ahead cap is 5 seconds, so a node that is minutes off will orphan every header it sees.

## Datadir

Each node gets its own directory. Do not reuse `testnet-v11`, and do not reuse a Continuum directory.

Suggested paths:

- Linux: `/var/lib/shear/dev-<epoch>`
- Windows: `C:\ShearDev\node-<epoch>`

The default leaf, when `SHEAR_DATA` is unset and `SHEAR_NETWORK=shear-dev`, is `shear-dev` (`~/.shear/shear-dev`, or `%APPDATA%\Shear\shear-dev` on Windows). The wallet dev session is `Shear/shear-dev/session.json`, not `Shear/session.json`.

Do not delete a datadir to “reset” a peer. A new epoch gets a new directory.

## Ports

The hosting firewall already allows 22, 80, 443, 1111, 8080, and 30303. Dev P2P and stratum use those open ports. They are process settings, the same env and flags as v12 (`SHEAR_P2P_PORT`, `SHEAR_STRATUM` / `SHEAR_STRATUM_PORT`). They are not chain parameters and they are not in the fingerprint.

| service | default | bind | override |
| --- | --- | --- | --- |
| P2P | 30303 | peer-facing | `SHEAR_P2P_PORT` |
| stratum | 1111 | the miner listener | `SHEAR_STRATUM` |
| RPC | 18432 | loopback | `SHEAR_RPC_PORT` |
| node IPC | 31313 | loopback | `SHEAR_P2P_IPC` |

The deployment runs dev P2P on 30303 and stratum on 1111. A dev process and a v12 process both want those ports, so they do not share a host. The book magic and the IPC handshake are what refuse the other network.

Loopback stays off the public firewall. RPC is 18432. The node IPC default is `127.0.0.1:31313`. The dev pool IPC default is `127.0.0.1:31314`, which is not the node IPC port and not the v12 pool IPC port `30313`. Pool HTTP stays on loopback `18188`. The pool stratum default is 1111, the same `SHEAR_STRATUM` flag as the v12 pool entry.

Do not open 18432, 31313, or 31314. Continuum’s datadir, session file, and magic stay untouched. Continuum’s public ports are the same numbers; run this book on its own machine.

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

Paper only. Do not deploy it. A separate host and a subdomain (not a path on the v12 pool) would be the place for it. The entry is `pool/src/main_dev.js`. It refuses to start unless the book magic is `shear-dev`, refuses the live v12 fee and admin destination, and refuses an operator seed file outside its own datadir. Payout sweep is 120 seconds. The one-hour env floor does not apply. The minimum payout stays π.

The existing pool web UI is unchanged. Do not serve a dev banner from this tree.
