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
| `header` | 240 hex of the 120-byte template | single object the miner hashes |

If any of those header fields is missing, the job is invalid and must not be
served. A found block is the **same header** with the winning nonce, plus the
body the node already associated with that template (txs + samples). The pool
does not invent roots.

## What this pool must not do

- Credit value on a share that is not a valid header hash
- Seal a “window” that the node cannot independently re-validate
- Drop a still-connected hasher from the miner table when a block is found
- Dual-login a miner fee
- Mention any other project in the UI

## Ports

- Stratum: `0.0.0.0:1111`
- Dashboard: nginx `pool.shear.digital` (TLS) reverse-proxied to the pool HTTP

## UI

Same layout as the current operator pool (banner, command box, stat tiles,
miner table, last transfers). **Light** palette. Shear names only.
