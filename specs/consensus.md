# Shear consensus

Network magic (testnet, ADMITv2 book): `shear-testnet-v4`  
Frozen previous books: `shear-testnet-v3` (ADMITv1 LSAG), `shear-testnet-v2`.  
Mainnet magic (`shear-v1`) genesis is `2026-09-18T21:00:00+01:00`. Do not merge v3 into frozen v2 or into v1 until the operator cuts over.

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
- Per-hash bonus: **1 unit = 0.00000000001 SHE** per proven share-unit, paid **to each miner who produced that share on the parent job header**. A floor-meeting share is worth `2^SHARE_FLOOR_BITS` units. Votes move that bonus by **1 unit** (±10⁻¹¹ SHE). Public amounts show eight fractional digits; sealed coinbase still includes the 10⁻¹¹ dust. The block finder does **not** scoop other miners’ hash bonuses.
- Samples under `continuity_root` are the audit trail for those hashes (`nonce`, recipient tag, units from `shareBatch`). They are collated **per hasher** (one leaf per miner per round, never one JSON object per hash). After 1000 confirmations the sample **bodies** may be pruned from storage. The header `continuity_root`, `merkle_root`, coinbase `vout`, and every user tx stay sealed. Explorer reconstructs history from those sealed txs forever. On-disk `chain.jsonl` stores compact rows only (header hex, collated samples until prune, sealed txs). Nodes do not keep template objects or per-hash JSON. Full nodes validate `shareBatch` until prune-1000; money vouts forever.
- Official miner uses a single login.
- Extra emission: **The Reserve only** (`shear-reserve-v1`) may mint interest at the **frozen `epochBps`** for that epoch. Any other dapp mint is invalid. Oracle observations are display-only until freeze.

## Resistance

ASERT toward 90 s, per block, on **Q16.16 packed** header `bits` (`BITS=q16.16`, half-life `ASERT_TAU_MS` = 288 × 90 s). Floor 4 bits (`LIVE_MIN_BITS`), ceiling **256 bits**. Genesis **12** bits packed as `12 << 16`. Per-block cap is **±2 log2** on testnet (`ASERT_HARDEN=2`, `ASERT_EASE=2`) so a farm-off can re-center the long average; mainnet genesis stays `ASERT_EASE=1`. Same-tick intervals are 1 ms and still only +2. Stalls clamp at 8 half-lives. Integer LZ rungs cannot represent the 1.09× work that 90 s needs when hashrate sits between powers of two. Share vardiff stays integer LZ. Do **not** keep a 32-bit (~4.29e9) lid — that froze GNFP under large CPU farms.

Work of a block: `blockWorkBig(bits) => 2^{bits_fp}` as bigint. Heaviest valid chain wins. Equal work keeps first-seen.

Scale (90 s, opt-in B + prune): see [scale.md](scale.md). Tree A is O(miners) per block, not O(hashes). After 1000 confirmations, sample/B bodies drop; sealed vouts and pot remain. At ~10 MH/s that is still GB-class disk for headers + collated A-leaves + sealed txs, not one JSON object per hash.

Consensus spendable is **6 confirmations** (the minimum; ~9 min at 90 s). That depth is in `consensusFingerprint()`. `min_confirms` default **12** is third-party/merchant policy only (~18 min), not a consensus floor. B-spends wait for the same 6-conf consensus depth. 0-conf is merchant policy.

## ADMITv2 membership

ADMITv2 is Curve Trees membership of `H_to_field("shear-admit-leaf-v2" || P)` on the Pasta 2-cycle (arity 32). There is no `RING_SIZE` in the fingerprint. See [admit-v2.md](admit-v2.md).

Live verifier: native `admit_verify` against jroot of dest leaves + C tree. A sampled subset fails (`admit_membership`). ADMITv1 linear `r.length === |J|` blobs fail. Reused `spendTag` fails (`admit_link_tag`). Sealed vin must not name the spent note (`prev`/`index`/`noteCommit`/`dest20`/`address`/original C).

Notes that enter `J`: coinbase hash / pot / levy, Flow pays, dummy value-0 notes, and Reserve money notes that carry `admitPub`. Spent notes stay in `J`; double-spend is a repeated spend-tag.

Thin set: while sealed note count is below **10,000**, public copy must say the membership set is thin. Mining (hash bonus) is how the set grows.

Reject reasons on `verifyBlock` / mempool: `silent_id_on_chain`, `admit_membership`, `admit_link_tag`, `range_proof`, `commit_sum`.

## Addresses

Rest-frame HRP `shear` (`shear1`) — never a login, never a vout. Silent ID `she1` is a versioned payment code (scan+spend pubs); the short 20-byte fingerprint is display-only and is not sufficient to pay. On-chain dest **`ssa1` only**. `verifyBlock` / `admitMempool` check typed HRP on every address field (vin/vout/from/to/miner/sample). HRP `she` → `silent_id_on_chain`. HRP `shear` → `rest_frame_on_chain`. `containsShe1` on JSON is not the consensus check. Spend sig is Ed25519 over the compact body; openings are not persisted. Memo is keyed by the stealth shared secret, not dest20. Fingerprint pins: `DEST_HRP_SSA_ONLY=1`, `SPEND_SIG_ONLY=1`, `MEMO_NOT_DEST_KEYED=1`, `HASH_TX_LIVE=1`.
