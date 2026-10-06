# Shear consensus

Network magic (testnet, ADMITv2 book): `shear-testnet-v12`  
Frozen previous books: `shear-testnet-v11`, `shear-testnet-v9`, `shear-testnet-v8`, `shear-testnet-v6`, `shear-testnet-v5`, `shear-testnet-v4`, `shear-testnet-v3` (ADMITv1 LSAG), `shear-testnet-v2`. A v11, v9, or v8 payload does not load on this book (no soft-merge). Quarantine v8/v9-wrong packs and git head `6054186`.  
Mainnet magic (`shear-v1`) genesis is `2026-09-18T21:00:00+01:00`. Do not merge v3 into frozen v2 or into v1 until the operator cuts over.

Difficulty is network-wide. Every node sets the next header's bits from the canonical genesis header with genesis-anchored aserti3-2d. A pool, a solo miner, shareBits vardiff, or `SHEAR_BITS` cannot publish a private target. Hashrate fluctuates. It is not a constant and it is not linear. `T=90000` and `τ=2h` (`ASERT_TAU_MS=7200000`). `GENESIS_BITS=17` is the anchor (v10 seeded 15, v11 used a median-11 step). It is not a lasting equilibrium and not `log2(H×90)`. 288 blocks is not a Ready bar. This cut does not relax invent-must-not-return.

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

- Base subsidy: `subsidy(epoch) = max(20e9, 100e9 - epoch * 1e9)` nanos. Epoch 0 is **1.00 SHE**; after 80 epochs a permanent **0.20 SHE** tail. Epoch length is fingerprinted: **4 days testnet**, **400 days mainnet**. Solo: the finder. Pool: split by proven work in that round (1% of this pot may go to a published development address). Votes and the Reserve oracle cannot move this schedule.
- Per-hash bonus: **1 unit = 0.00000000001 SHE** per proven share-unit, paid **to each miner who produced that share on the parent job header**. A floor-meeting share is worth `2^SHARE_FLOOR_BITS` units (`SHARE_FLOOR_BITS=8`). A block includes at most `MAX_SHARES_PER_BLOCK=65536` of those shares (`MAX_HASH_UNITS_PER_BLOCK=16777216`). The closed v10 book capped shares at 8192. The 32768 rung is cancelled. `HASH_BONUS_NANOS` stays 1. Votes move that bonus by **1 unit** (±10⁻¹¹ SHE). Public amounts show eight fractional digits; sealed coinbase still includes the 10⁻¹¹ dust. The 1 SHE pot is not reduced by that bonus. Hash notes are extra. Every dest in the share batch is paid its own hash bonus in the sealing block, including when a different pool or solo miner found it. The block finder does **not** scoop other miners’ hash bonuses.
- Samples under `continuity_root` are the audit trail for those hashes (`nonce`, recipient tag, units from `shareBatch`). They are collated **per hasher** (one leaf per miner per round, never one JSON object per hash). After 1000 confirmations the sample **bodies** may be pruned from storage. The header `continuity_root`, `merkle_root`, coinbase `vout`, and every user tx stay sealed. Explorer reconstructs history from those sealed txs forever. On-disk `chain.jsonl` stores compact rows only (header hex, collated samples until prune, sealed txs). Nodes do not keep template objects or per-hash JSON. Full nodes validate `shareBatch` until prune-1000; money vouts forever.
- Official miner uses a single login.
- Extra emission: **The Reserve only** (`shear-reserve-v1`) may mint interest at the **frozen `epochBps`** for that epoch. Any other dapp mint is invalid. Oracle observations are display-only until freeze.

## Resistance

ASERT toward 90 s, per block, on **Q16.16 packed** header `bits` (`BITS=q16.16`, `ASERT_STEP=aserti3-2d`, `ASERT_TAU_MS` = 7200000). Floor 4 bits (`LIVE_MIN_BITS`), ceiling **256 bits**. The anchor is the canonical genesis header: height, timestamp, and `GENESIS_BITS=17` packed as `17 << 16`. v10 seeded 15. v11 used median-11 plus a ±1 lid. Both are closed books. Hashrate fluctuates, so the anchor is not `log2(H×90)` and it is not recomputed from a forecast. The child header's bits are `asertNextBits` from that anchor and this block's own timestamp. Parent bits are not the anchor, so an emergency ease does not stick. Template voids caller `bitsIn` and quotes the full packed target for the stamp it will seal. A block on the `T=90000` schedule adds zero. `τ=2h`, fingerprint-pinned. Move to 4h only if a soak shows bits chatter. That change is a new book. The ±1 lid is gone (`ASERT_HARDEN=0`, `ASERT_EASE=0` on this testnet). A candidate whose own timestamp is more than `8·T` after its parent may be up to 2 bits easier (`ASERT_EMERGENCY=2`). The next child returns to the full quote. Skew inside `HEADER_AHEAD_MS` does not unlock that ease. `ASERT_FLOOR=clamp-live-min-max`. MTP-11, the 2h MTP-future limit, and monotonic timestamps stay. Same-tick intervals are 1 ms. Integer LZ rungs cannot represent the 1.09× work that 90 s needs when hashrate sits between powers of two. Share vardiff stays integer LZ and is not a retarget. Do **not** keep a 32-bit (~4.29e9) lid — that froze GNFP under large CPU farms. A pool job's block target is this same next-work value. A share that misses it is not a block. The single-gap `bitsForBlock` helper is not the verify or template path.

Work of a block: `blockWorkBig(bits) => 2^{bits_fp}` as bigint. The chain with more work wins, whoever mined it. Equal work follows the lower tip hash (`FORK=work-then-lowhash`), not the block that arrived first and not which pool found it. A competing branch stays staged so a later heavier child can still win. A second genesis, or any chain that shares no block with the local tip, is downloaded when that peer is ahead.

Scale (90 s, opt-in B + prune): see [scale.md](scale.md). Tree A is O(miners) per block, not O(hashes). After 1000 confirmations, sample/B bodies drop; sealed vouts and pot remain. At ~10 MH/s that is still GB-class disk for headers + collated A-leaves + sealed txs, not one JSON object per hash.

Consensus spendable is **9 confirmations** (the minimum; ~9 min at 90 s). That depth is in `consensusFingerprint()`. `min_confirms` default **12** is third-party/merchant policy only (~18 min), not a consensus floor. B-spends wait for the same 9-conf consensus depth. 0-conf is merchant policy.

## ADMITv2 membership

ADMITv2 is Curve Trees membership of `H_to_field("shear-admit-leaf-v2" || P)` on the Pasta 2-cycle (arity 32). There is no `RING_SIZE` in the fingerprint. See [admit-v2.md](admit-v2.md).

Live verifier: native `admit_verify` against jroot of dest leaves + C tree. A sampled subset fails (`admit_membership`). ADMITv1 linear `r.length === |J|` blobs fail. Reused `spendTag` fails (`admit_link_tag`). Sealed vin must not name the spent note (`prev`/`index`/`noteCommit`/`dest20`/`address`/original C).

Notes that enter `J`: coinbase hash / pot / levy, Flow pays, dummy value-0 notes, and Reserve money notes that carry `admitPub`. Spent notes stay in `J`; double-spend is a repeated spend-tag.

Thin set: while sealed note count is below **10,000**, public copy must say the membership set is thin. Mining (hash bonus) is how the set grows.

Reject reasons on `verifyBlock` / mempool: `silent_id_on_chain`, `admit_membership`, `admit_link_tag`, `range_proof`, `commit_sum`.

## Addresses

Rest-frame HRP `shear` (`shear1`) — never a login, never a vout. Silent ID `she1` is a versioned payment code (scan+spend pubs); the short 20-byte fingerprint is display-only and is not sufficient to pay. On-chain dest **`ssa1` only**. `verifyBlock` / `admitMempool` check typed HRP on every address field (vin/vout/from/to/miner/sample). HRP `she` → `silent_id_on_chain`. HRP `shear` → `rest_frame_on_chain`. `containsShe1` on JSON is not the consensus check. Spend sig is Ed25519 over the compact body; openings are not persisted. Memo is keyed by the stealth shared secret, not dest20. Fingerprint pins: `DEST_HRP_SSA_ONLY=1`, `SPEND_SIG_ONLY=1`, `MEMO_NOT_DEST_KEYED=1`, `HASH_TX_LIVE=1`.
