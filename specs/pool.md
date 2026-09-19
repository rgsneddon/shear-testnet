# Shear pool

The public pool is **not** the ledger. It is a stratum in front of a local
validating node. Mint happens only when that node accepts a block whose header
meets Resistance.

## Header jobs (required)

Every stratum job is a full candidate **header template** from the node, not a
synthetic puzzle. The miner must receive every field needed to hash and to
submit a complete block:

| Field | In the job | Why |
|-------|------------|-----|
| `version` | yes | hashed |
| `prev_block_hash` | yes | hashed; stale if tip moves |
| `merkle_root` | yes | hashed; commits coinbase + user txs |
| `continuity_root` | yes | hashed; commits this round’s samples |
| `timestamp` | yes | hashed; MTP / future-time rules |
| `bits` | yes | hashed; share vs block target |
| `nonce` | zeroed in the template; miner fills | hashed |
| `jobId` | yes | bind submit to this template |
| `height` | yes | coinbase height |
| `shareBits` | yes | vardiff share target |
| `blockBits` | yes | equals header `bits` |
| `header` | 256 hex of the 128-byte template | single object the miner hashes |

If any of those header fields is missing, the job is invalid and must not be
served. A found block is the **same header** with the winning nonce, plus the
body the node already associated with that template (txs + samples). The pool
does not invent roots.

## CPU thread inventory (inherit from GNFP 2026-08-24)

Do **not** last-write `threads` / `cpuCores` / `cpuThreads` onto the login name.

GNFP live pool had worker EP01 flipping **32/32 ↔ 230/256** every few seconds while proven H/s stayed ~56 MH/s. Two TCP clients shared `wallet.EP01`. Each submit overwrote the banner; accepts from both still summed. Honesty saw `claimed <= device` on whichever packet arrived last, so the tile said HONEST.

Shear pool book:

1. One inventory record **per TCP session** (socket id, not remote IP — two processes on one box share an IP).
2. Worker row (`ssa1.worker`) **sums** utilised threads and **sums** each session’s device cores/threads. Folded totals are **not** capped at 256.
3. No thread-honesty / inflate flags. Folded inventory is claimed threads and proven H/s only.
4. Disconnect drops only that session’s inventory; other sockets on the same worker stay listed.
5. Key the book by **full login** (`ssa1.worker`), not dest-only. `dest.alpha` and `dest.beta` are distinct rows; several sockets on `dest.alpha` still sum.
6. No miner-fee dual-login / fee route. Miners keep any dev fee themselves.
7. Per-session share **vardiff** moves share bits with accepted-share rate and **never exceeds** current block `bits`. Default share max is the SHA-256 width (256), same as header ASERT. Block retarget stays ASERT 90 s. Do **not** clamp vardiff at 24 or header bits at 32.

`foldConnectionInventory` and `refreshMinerRow` in `pool/src/pool.js`; share bits in `pool/src/share_vardiff.js`.

## What this pool must not do

- Credit value on a share that is not a valid header hash
- Seal a “window” that the node cannot independently re-validate
- Drop a still-connected hasher from the miner table when a block is found
- Dual-login a miner fee
- Charge the 1% pool fee on hash bonus (fee is pot-only)
- Instant-pay hash bonus on the public pool (it accumulates to π SHE)
- Keep a miner “Withdraw confirmed sum” / wallet “Pull from pool” button (auto-payout replaced both)
- Last-write CPU inventory on a worker name (see above)
- Cap folded worker threads at 256
- Mention any other project in the UI

## Ports

- Stratum: `127.0.0.1:1111` behind a TLS terminator (`SHEAR_STRATUM_BIND=127.0.0.1`, `SHEAR_STRATUM_AUTH=1`). Dev dest-only is `SHEAR_STRATUM_AUTH=0`. Do not recommend bare `0.0.0.0:1111` in production. Confirm via `/api/stats` (`stratumBind`, `loginAuth`). This tree does not ship TLS certificates.
- Dashboard: nginx `pool.shear.digital` (TLS) reverse-proxied to the pool HTTP

## UI

Same layout as the current operator pool (banner, command box, stat tiles,
miner table, last transfers). **Light** palette. Shear names only.
