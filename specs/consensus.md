# Shear consensus

Network magic (testnet, ShearHash-v3 book): `shear-testnet-v2`  
Frozen previous book: `shear-testnet-v1` (readable, not mined).  
Mainnet magic (`shear-v1`) is a later genesis. Do not merge v2 into live v1 until the operator cuts over.

PoW for this book is **ShearHash-v3** (RandomX light). See [shearhash-v3.md](shearhash-v3.md). Header size is still **128 bytes**.

Hash-tx law is consensus, not env: `HASH_TX_LIVE=1`, `HASH_TX_COLLATE=1`, confirm on block-found. 1 hash = 1 bonus unit. Collate is O(miners), never one JSON object per hash. Mainnet genesis seals `consensusFingerprint()` (includes `HASH_TX_LIVE=1`); flipping it is a different book.

## Header (128 bytes, little-endian)

The field list is authoritative. Packed size is **128 bytes** (4+32+32+32+8+4+8+8).

| Offset | Size | Field |
|--------|------|--------|
| 0 | 4 | `version` u32, starts at 1 |
| 4 | 32 | `prev_block_hash` |
| 36 | 32 | `merkle_root` of packed txs (coinbase first) |
| 68 | 32 | `continuity_root` = `H(rootA ∥ rootB)` |
| 100 | 8 | `timestamp` u64 Unix milliseconds |
| 108 | 4 | `bits` u32 Resistance compact target |
| 112 | 8 | `nonce` u64 |
| 120 | 8 | `base_fee` u64 Flow levy base |

PoW: `ShearHash-v3(header) ≤ target(bits)` (RandomX light, 128 MiB cache). Algorithm name on the wire: `ShearHash`. Personalisation: `ShearHash-v3`. v1/v2 pretender hashes mint nothing.

## Mint

Coinbase is the only source of new SHE.

- Base subsidy: `100_000_000_000` units (**1 SHE**, 11 decimals) for the round. Solo: the finder. Pool: split by proven work in that round (1% of this pot may go to a published development address).
- Per-hash bonus: **1 unit = 0.00000000001 SHE** per proven share-unit, paid **to each miner who produced that share on the parent job header**. A floor-meeting share is worth `2^SHARE_FLOOR_BITS` units. Votes move that bonus by **1 unit** (±10⁻¹¹ SHE). Public amounts show eight fractional digits; sealed coinbase still includes the 10⁻¹¹ dust. The block finder does **not** scoop other miners’ hash bonuses.
- Samples under `continuity_root` are the audit trail for those hashes (`nonce`, recipient tag, units from `shareBatch`). They are collated **per hasher** (one leaf per miner per round, never one JSON object per hash). After 1000 confirmations the sample **bodies** may be pruned from storage. The header `continuity_root`, `merkle_root`, coinbase `vout`, and every user tx stay sealed. Explorer reconstructs history from those sealed txs forever. On-disk `chain.jsonl` stores compact rows only (header hex, collated samples until prune, sealed txs). Nodes do not keep template objects or per-hash JSON. Full nodes validate `shareBatch` until prune-1000; money vouts forever.
- Official miner uses a single login.
- Extra emission: **The Reserve only** (`shear-reserve-v1`) may mint interest at the rate observed by The Reserve oracle. Any other dapp mint is invalid.

## Resistance

ASERT toward 90 s, per block. Floor 4 bits (`LIVE_MIN_BITS`), ceiling **256 bits**. Genesis **12** bits. Do **not** keep a 32-bit (~4.29e9) lid — that froze GNFP under large CPU farms.

Work of a block: `blockWorkBig(bits) => 1n << BigInt(bits)`. Heaviest valid chain wins. Equal work keeps first-seen.

Scale (90 s, opt-in B + prune): see [scale.md](scale.md). Tree A is O(miners) per block, not O(hashes). After 1000 confirmations, sample/B bodies drop; sealed vouts and pot remain. At ~10 MH/s that is still GB-class disk for headers + collated A-leaves + sealed txs, not one JSON object per hash.

Consensus spendable is **6 confirmations** (the minimum; ~9 min at 90 s). That depth is in `consensusFingerprint()`. `min_confirms` default **12** is third-party/merchant policy only (~18 min), not a consensus floor. B-spends wait for the same 6-conf consensus depth. 0-conf is merchant policy.

## Addresses

Rest-frame HRP `shear` (`shear1`) — never a login, never a vout. Silent ID `she1` is a versioned payment code (scan+spend pubs); the short 20-byte fingerprint is display-only and is not sufficient to pay. On-chain dest **`ssa1` only**. `verifyBlock` / `admitMempool` check typed HRP on every address field (vin/vout/from/to/miner/sample). HRP `she` → `silent_id_on_chain`. HRP `shear` → `rest_frame_on_chain`. `containsShe1` on JSON is not the consensus check. Spend sig is Ed25519 over the compact body; openings are not persisted. Memo is keyed by the stealth shared secret, not dest20. Fingerprint pins: `DEST_HRP_SSA_ONLY=1`, `SPEND_SIG_ONLY=1`, `MEMO_NOT_DEST_KEYED=1`, `HASH_TX_LIVE=1`.
