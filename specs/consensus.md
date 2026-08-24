# Shear consensus

Network magic (testnet): `shear-testnet-v1`  
Mainnet magic (`shear-v1`) is a later genesis. Testnet first.

## Header (120 bytes, little-endian)

The field list is authoritative. Packed size is **120 bytes** (4+32+32+32+8+4+8).

| Offset | Size | Field |
|--------|------|--------|
| 0 | 4 | `version` u32, starts at 1 |
| 4 | 32 | `prev_block_hash` |
| 36 | 32 | `merkle_root` of transactions (coinbase first) |
| 68 | 32 | `continuity_root` Merkle root of collated hash samples |
| 100 | 8 | `timestamp` u64 Unix milliseconds |
| 108 | 4 | `bits` u32 Resistance compact target |
| 112 | 8 | `nonce` u64 |

PoW: `ShearHash(header) ≤ target(bits)`.

Personalization: `ShearHash-v1`. Algorithm name on the wire: `ShearHash`.

## Mint

Coinbase is the only source of new SHE.

- Base subsidy: `100_000_000_000` units (**1 SHE**, 11 decimals) for the round. Solo: the finder. Pool: split by proven work in that round (1% of this pot may go to a published development address).
- Per-hash bonus: **10 units = 0.0000000001 SHE per valid hash**, paid **to each miner who produced that hash in the current block round**. Votes move that bonus by **1 unit** (±10⁻¹¹ SHE). If Alice hashes 4_000 times and Bob 1_000 times before the block is found, Alice’s coinbase output includes 40_000 units and Bob’s includes 10_000 units. The block finder does **not** scoop other miners’ hash bonuses.
- Samples under `continuity_root` are the audit trail for those hashes (`nonce`, recipient tag, 1 unit). They are collated **per hasher** (one leaf per miner per round, never one JSON object per hash). After 100 confirmations the sample **bodies** may be pruned from storage. The header `continuity_root`, `merkle_root`, coinbase `vout`, and every user tx stay sealed. Explorer reconstructs history from those sealed txs forever. On-disk `chain.jsonl` stores compact rows only (header hex, collated samples until prune, sealed txs). Nodes do not keep template objects or per-hash JSON.
- Official miner uses a single login.
- Extra emission: **The Reserve only** (`shear-reserve-v1`) may mint interest at the rate observed by The Reserve oracle. Any other dapp mint is invalid.

## Resistance

ASERT toward 90 s, per block. Floor 14 bits, ceiling **256 bits** (SHA-256 width). Genesis 21 bits. Do **not** keep a 32-bit (~4.29e9) lid — that froze GNFP under large CPU farms.

Work of a block: `2^256 / (target + 1)`. Heaviest valid chain wins. Equal work keeps first-seen.

## Addresses

HRP `shear`. Bech32 payload is the 20-byte spend-key hash. Display form starts `shear1`.
