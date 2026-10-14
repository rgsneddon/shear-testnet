# P0 070 and PSA-c2a-1: one burial tip, a bounded hold, and proven burial

Branch: `cursor/p0-070-c2a1-burial-d437` (PR 74), cut from PR 67 (`cursor/p0-052-burial-gate-0f14` at `edcb2be9`), into `feat/shear-testnet-v12`. No genesis cut, no tag, no deploy, no merge. `crypto/admit.js` was not edited.

Round 1 (`e8947428`) fixed PSA-c2a-1. The burial tip is the tip of the chain being validated, on commit and on verify, and never `max(local tip, fork length)`. The Pool Share Auditor passed that part and failed 070 on three points. This round fixes those three. The rules still hold: a missing batch never mints, and unpaid work is never dropped.

## PSA-pr74-1 (P0): the held share batches are bounded

The old `heldBodies` kept every pruned block's share batch in memory and on disk forever. `loadHeldBodies` read all of them back at startup.

`node/src/burial_hold.js` replaces that.

- `reorgFloor(tip)` is the bootstrap checkpoint: 0 below height 1000, then 1000, 1400, 1800, and so on.
- `settledHeight(tip)` is the floor minus the prune depth, or 0 when the floor is at or below 1000. A block at or below the settled height is buried under every chain this node can still adopt. Any such chain keeps the floor block, so its tip is at least the floor.
- `createBurialHold` keeps only a `hash -> height` index in memory. Each batch is a file, `burial-hold/<height>-<hash>`, read only when it is lifted or served.
  - `evict(tip)` deletes every file at or below the settled height.
  - `load(tip)` lists the folder without reading bodies, and deletes settled or unknown names.
  - Fast-sync does not write the hold.
- The held window is `tip - 1000 - settled`, which is at most 399 blocks. That is the most the hold ever keeps, for any share count.

## PSA-pr74-2 (P1): every node type adopts the same deep reorg

The auditor's option B. A pruned block is accepted by proven-work header burial plus its sealed credit root. The coinbase `hashCreditRoot` binds the credits.

- `createBurialProof` keeps `hash -> {height, tip}` for every pruned block in the reorg window. It is stored in `burial-proof.json` and HMAC'd with the install's seal key, `bookSealKeyFor(dir)`. A file with a bad MAC or a foreign key loads as empty.
- `noteBurial(tip)` records local burial on every prune and evicts settled rows. A gap-synced block records the top of its proven header run. The proof is saved before the block is persisted.
- `blockForTip(block, tip)` is the one view that verify, `seedHistory`, `rebuildSpentB`, `supplyCarriedTo`, the suffix history and `replayOwedFrom` all use:
  - a block buried under the given tip uses that tip;
  - a pruned block with a proof uses its proven tip;
  - anything else fails closed as `samples_pruned`.
- The same per-block burial feeds the load paths:
  - `verifyLoadedChain` and `stepLoaded` take `burialOf`;
  - `foldSupply` takes `burialOf`;
  - `replayHashOwed` (`crypto/hash_owed.js`) takes `burialOf`.

  Without the last one, a full replay after the reorg threw `hash_owed` on fast-sync, bootstrap and restarted nodes.
- Verify never reads the hold, so archive and fast-sync nodes reach the same verdict. The hold only puts the body back when the block is committed to a chain that no longer buries it, and when the block is served.

The burial predicates (`sealedCreditsBuried`, `freshForBlock`, `spillForBlock`, `flowSkipAllowed`) depend only on the block's own tip. Giving each block its own proven tip therefore changes nothing for a block the local tip already buries.

## 052 gaps: no early reject, and no serving an unburied pruned block

- **Proof by headers.** `store.offerHeaders(rows)` takes the P2P `headers` page, or an IPC `ipc_headers` frame. It is capped at 6000 headers, oldest evicted first. `append` of a pruned block calls `proveBurial`:
  - it needs 1000 linked headers above the block;
  - each header passes `headerLinkReason` (`chain.js`): version, prev, ShearHash work (unless the hash is trusted), ASERT bits from genesis, a timestamp after the parent, at most median-time-past plus 2h, and the clock bound;
  - a bad header is forgotten, and the proof retries up to 3 times;
  - verify and commit both use `burialTip = height + 1000`, the proven top, and the block hash must match the claimed header;
  - with no full proven run the result is `samples_pruned` before any hashing. A lied height field still answers `height`.
- **`p2p_ipc.js:208`.** The up-front `samples_pruned` reject is gone. `ipcBlockFrames` sends the burial headers in an `ipc_headers` frame before each pruned block. Only headers the receiver does not yet have are sent. The store decides. IPC never trusts a hash, so headers are ShearHashed off the event loop, 16 at a time.
- **`chain.js:2001`** (now 2042). The check stays, but it now fires only for a pruned block that is neither buried nor proven. It is the fail-closed rule, not an early reject.
- **`p2p.js:520,532`.** `flushGetblockServe` serves `store.servableBlock(block)`:
  - a full block as is;
  - a held block whole;
  - a pruned block only when the local tip buries it;
  - anything else gets a `getblock_nak`, and the peer fails over to the next peer.
- **Wire decode fix.** `decodeWireBlock` set `hashCredits` and `hashSpillCredits` to `undefined` when they were absent. That broke `hash_owed` on every wire ingest of a block without a spill. The keys are now set only when present. The base branch fails `test_fee_fold_v12` on this. Feat made the same fix in `639cc075`, and the merge of feat at `36296798` (PR 65) keeps feat's version, so this branch no longer changes `decodeWireBlock`.

## PSA-pr74b-1 (P1): junk header offers cannot stall catch-up

The old offer cache was one 6000-entry FIFO with no work check. Junk could push out the honest run and force up to about 4000 RandomX hashes per pruned block. Consensus is unchanged: the same headers prove the same burial.

- **Cheap work check before caching.** `offerHeaders(list, { peer })` caches a header only if:
  - its parent is a local block, a cached header or a proven header;
  - it passes `headerLinkReason` under its claimed hash: version, link, ASERT bits from genesis, the packed range, a timestamp after the parent, and a claimed hash that meets its own bits;
  - a root header passes `rootHeaderReason` (genesis prev, `GENESIS_BITS_PACKED`, claimed hash under the bits), and only when this store is empty.

  No ShearHash runs at offer time. A header with an unknown parent, or one more than `HEADER_AHEAD_MS` past this clock, is ignored without a strike.
- **Per-peer limits.**
  - Each peer has its own FIFO bucket of `OFFER_PEER_CAP` (4000) headers.
  - At most `OFFER_PEER_SLOTS` (8) peers are tracked. When a new peer needs a slot, the peer with the fewest proven headers, then the smallest bucket, then the stalest is evicted.
  - A header offered by several peers stays cached while any of them still holds it.
- **Drop on a bad link.**
  - A header that fails the cheap check, or reuses a cached hash with different bytes, drops the sending peer. So does a header that fails its real ShearHash inside `proveBurial`; there, every peer that offered it is dropped.
  - A dropped peer's unproven headers are purged, and its offers are refused for `OFFER_DROP_MS` (10 min).
  - P2P disconnects a dropped peer. IPC offers come from peer `ipc`.
- **Proven paths first.** A header that passes its hash keeps its bytes in a separate proven pool of `PROVEN_HEADER_CAP` (6000), which junk cannot evict. `offeredPath` tries proven headers first, then headers from peers whose headers have proven out.
- **Bounded hashing.**
  - Each failed attempt drops at least one peer, so `proveBurial` retries at most `OFFER_PEER_SLOTS + 1` times.
  - The off-loop path starts with a batch of 2 and doubles up to 16, so a bad run costs at most 2 hashes (1 on the sync path) before its peer is dropped.
- **IPC.** `ipcBlockFrames` now starts each header run at the pruned block's own header, so every header in the run links to one the receiver has.

## PSA-pr74c-1 (P1): sybils cannot evict an honest peer's headers before its first proof

Before this round, a peer that had not yet proven anything could lose its slot to 8 or more sybil peers, and one IPv6 /64 was enough to produce them. Consensus and the burial path are unchanged: `proveBurial`, `headerLinkReason`, the 1000-header depth and the proven pool all stay as they were. Only the choice of which offered headers stay cached is new.

- **Slots by network group.** `offerHeaders(list, { peer, tier, group })` keys each P2P slot by group, not by peer. `p2p.peerNetGroup` maps IPv4 (including `::ffff:` mapped addresses) to its /24 and IPv6 (expanded, zone ignored) to its /64. Every address in one /24 or /64 shares one slot, one 4000-row bucket and one rate budget.
- **Reserved slots by tier.** `p2p.offerTierOf(rec)` names the tier.

  | Tier | Who | Slot key | Pool |
  | --- | --- | --- | --- |
  | `pinned` | seeds (`dialSeeds`) and RPC `connect` | the peer | reserved |
  | `outbound` | dials learned from addr gossip | `out:<group>` | 8 outbound slots |
  | `inbound` | accepted sockets | `in:<group>` | 8 inbound slots |
  | `local` | IPC (`ipc`) and in-process callers | the peer | reserved |

  Inbound peers can never take an outbound, pinned or local slot. A newcomer only evicts within its own pool, and never a slot of a higher tier.
- **The proof path is never evicted.** `pathFromTip()` walks the best header path up from the local tip, or from genesis on an empty store, to the prune depth plus one. `protectedSlots()` picks the smallest set of slots that covers that path: greedily, the slot holding the most path rows, then the higher tier, then the oldest. Taking a minimal cover, rather than every slot that holds a path row, means sybils that replay honest rows do not protect themselves. Eviction skips protected slots. If every candidate is protected, the newcomer is refused (`refused`) and nothing is evicted. Otherwise the order is lowest tier, then fewest proven, then smallest bucket, then stalest.
- **Path choice cannot be bought with more groups.** `kidRank` prefers a proven row, then the highest tier holding the row, then the most proven slot, then the first seen. The number of groups offering a row no longer counts, because sybils can always bring more groups.
- **Drops.** A bad link bans the peer key and evicts its slot. For an inbound or outbound slot it also bans the group key, so other addresses in the same /24 or /64 are refused for `OFFER_DROP_MS`. In `proveBurial`, every sender of a row that fails its real ShearHash is dropped. The retry bound becomes `2 * OFFER_PEER_SLOTS + 1`.
- **Limit.** If honest peers are inbound only and sybils fill the inbound pool first, the honest slot is not guaranteed to survive. Hashing stays bounded either way. The guarantee comes from outbound and pinned slots, which inbound sybils cannot reach, and from proof-path protection once an honest slot holds the path.

## P2: per-slot rate limit for header offers

Checking 1.6M junk rows took 40 to 75 s on the main event loop. Each inbound or outbound slot now has a token bucket of `OFFER_RATE_BURST` (4000 rows), refilled at `OFFER_RATE_PER_SEC` (2000 rows/s). Each offered row costs one token whether or not it is cached. Rows past the budget are skipped unread and counted in `limited`. Local, IPC and pinned callers are not limited. Since the budget belongs to the slot, it is shared by a whole /24 or /64.

`burialView()` now also reports `offerSlotTiers`, `refused` and `limited`. `offerPeerRows` is keyed by slot.

## Tests

- **`node/tests/test_burial_offers_v12.js`** (new).
  - Unit checks, with no hashing at offer time:
    - garbage, a claimed hash that misses its bits, bits off ASERT, a rewound timestamp, and a reused hash with other bytes each drop the peer, and its later offers are refused;
    - an orphan, and a header ahead of the clock, are ignored without a strike;
    - a 6000-row flood stays at 4000 rows, and the honest run is untouched;
    - ten sybils do not take the honest slot;
    - the flood's forged run fails its first real hash, its peer is dropped, and the honest run proves.
  - Matrix: junk ratio {0, 50%, 99%} × {1, 4} honest peers × hash mode. The jit-full and light modes each run in a child process with `SHEAR_HASH_BACKEND`, and the lanes report `jit-full` and `jit`. The light child also runs the in-process sync path.
    - Junk is the expensive kind: full-length forged runs that pass the cheap check and fail only a real ShearHash. They are offered after the honest run, with fresh attacker ids for every block.
    - Honest headers are the test chain's stand-ins, passed in `trustedHeaderHashes`. Every junk header is hashed for real.
  - PSA-pr74c-1 updates: the flood and the matrix junk are offered before the honest run, and a separate root peer offers the first header. The maximum cached rows bound is `2 * OFFER_PEER_SLOTS * OFFER_PEER_CAP`.
- **`node/tests/test_burial_sybil_v12.js`** (new). It builds a 1004-block fast-sync source with 4 pruned blocks.
  - Units: `peerNetGroup` handles /24, /64, `::`, mapped IPv4 and zones; `offerTierOf` names the tiers; and the source pins seeds and RPC `connect`, and marks attached dials as pinned.
  - Matrix: four layouts × {1, 4} honest peers × {8, 32, 256} sybils. Each case runs three waves, so 24, 96 or 768 sybil peers in total, each offering full-length forged runs that pass the cheap check and fail a real ShearHash. The layouts are:
    - inbound sybils on distinct /24s vs outbound honest;
    - sybils on one IPv6 /64 vs inbound honest (the /64 must be one slot);
    - outbound sybils from addr gossip vs pinned honest;
    - inbound honest offered first, holding the proof path, vs inbound sybils.
  - Each case asserts that the honest slots are kept (in the last layout, at least one), that each pool has at most 8 slots and each bucket at most 4000 rows, that all 4 pruned blocks prove, that block 1 hashes at most 8 and later blocks hash 0.
  - Rate: 1.6M rows over 4 inbound slots read at most 16,000 rows in under 5 s. One second refills 2000 rows. IPC is not limited.
- **`node/tests/test_burial_hold_v12.js`** (new). It checks the settled height at the floor edges. It runs shares per block {1, 1000, 8000, 65,536} × pruned chain length {1000, 3000, 10,000} through a real hold, and asserts that:
  - held blocks equal `tip - 1000 - settled` and never exceed 399;
  - the proof row count stays at or below 399;
  - the file count equals the index;
  - disk use is at most 399 bodies;
  - heap and buffer growth stay under 64 MB.

  A restart reads no bodies, keeps the same heights and reloads the proof. A foreign seal key loads nothing. A fast-sync hold stays empty.
- **`node/tests/test_burial_proof_v12.js`** (new).
  - Setup: archive A grows to 1448, with credited blocks at 17, 384, 415, 416, 417 and 448. B is fast-sync and D is fast-sync with a restart. Both are wire-fed in lockstep. C is a bootstrap node installed from A's `chain.bin`. A 16-block on-time fork from 1400 replaces the eased tail 1401..1448, so the credited blocks sit at depth 1399, 1032, 1001, 1000, 999 and 968. That covers k = 399, 32 and 1 above 1000, k = 0, and k = 1 and 32 below it.
  - All four nodes answer `side_hold` and then `ok` at the same fork block, and end with the same height, hash, supply state and owed map. A puts the bodies for 417..448 back, and the others keep them pruned and proven. The heights at or below 400 are settled and evicted. A fork 400 blocks deeper breaks the checkpoint.
  - Each node reloads from the snap and from a full replay to the same state.
  - Gap-spread: a fresh fast-sync node E syncs from B, falling back to A, and sees every gap from 1 to 1416. It proves 416 pruned blocks from the headers page, gets 32 refusals from B, which correctly does not serve its unburied pruned blocks, restarts at height 300 (from the snap and from a full replay), and ends equal to the others.
  - Negatives: no headers, 999 headers, a rewound timestamp at 501, and headers without real ShearHash all give `samples_pruned`, and nothing is minted. 1000 headers are accepted.
  - IPC: header frames come in order before each pruned block, only missing headers are sent, no frame is sent for an unburied pruned block on fast-sync, and the archive sends the whole body. The pool store refuses non-ShearHash headers.
- **`test_burial_tip_v12.js`** now hides the hold folder instead of deleting it. That fork is `side_hold` on proof alone, which is the point of PSA-pr74-2.
- **`test_burial_gate_v12.js`** awaits the off-loop IPC path.

## Results

The same machine was used throughout, with 4 cores and other runs going at the same time. `shearhash.node` and `shearadmit.node` were built locally and are gitignored.

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 --test-timeout=7200000 node/tests/test_owed_seed_v12.js` at `b93d77b8` | tests 2, pass 2, fail 0, 1140.8 s |
| `node --test --test-concurrency=1 --test-timeout=9000000 node/tests/test_burial_proof_v12.js` at `394ffa6f` (the conditional clean run) | tests 6, pass 6, fail 0, 2683.7 s; 1416 gaps, 416 pruned, 32 NAKs |
| the same at `b93d77b8` | tests 6, pass 6, fail 0, 2784.2 s; 1416 gaps, 416 pruned, 32 NAKs |
| `node --test --test-concurrency=1 --test-timeout=7200000 node/tests/test_burial_offers_v12.js` | tests 3, pass 3, fail 0 (children: jit-full 6/6, light 12/12) |
| `node --test node/tests/test_burial_hold_v12.js` | tests 14, pass 14, fail 0, 32.6 s |
| `node --test node/tests/test_burial_tip_v12.js` | pass 2, fail 0, 198.2 s |
| `node --test node/tests/test_burial_gate_v12.js` | pass 2, fail 0 |
| `test_load_body_v12`, `test_load_snap_v12`, `test_pruned_flag_v12`, `test_bootstrap`, `test_bootstrap_image_v12`, `test_fork_choice`, `test_frontier_window_v12`, `test_getblock_nak_failover`, `test_getblock_serve_pace`, `test_getblock_taller`, `test_hash_spill_v12`, `test_ibd_peer_height_v12`, `test_ibd_sequential`, `test_ibd_status`, `test_snap_interest_v12` | all pass |

Header offers, hashes per pruned block (blocks 1 to 4), junk rows offered for the 4 blocks, and the most headers cached. Results match across jit-full off-loop, light off-loop and light sync, except that the sync path hashes half as much:

| Junk | Honest peers | Junk rows | Hashed (off-loop) | Hashed (sync) | Max cached |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 / 4 | 0 | 0, 0, 0, 0 | 0, 0, 0, 0 | 1004 |
| 50% | 1 | 4000 | 2, 0, 0, 0 | 1, 0, 0, 0 | 4004 |
| 50% | 4 | 16,000 | 8, 0, 0, 0 | 4, 0, 0, 0 | 5004 |
| 99% | 1 | 396,000 | 2, 0, 0, 0 | 1, 0, 0, 0 | 13,004 |
| 99% | 4 | 1,592,000 | 8, 0, 0, 0 | 4, 0, 0, 0 | 17,004 |

Each attacker costs at most 2 hashes off-loop and 1 on the sync path, and is then dropped. Later blocks take the proven run and hash nothing. The old cache could force about 4000 per block. The longest cell (99% junk, 4 peers, 1.6M junk rows) took 31 s, almost all of it the cheap check. Fresh attacker ids that are never hashed stay cached, at most 4000 each within the 8 slots.

At `8322d90d` a peer that had not yet proven anything could lose its slot to 8 or more sybils before its first proof. That is PSA-pr74c-1, fixed below.

### PSA-pr74c-1 and P2 (this round)

| Command | Result |
| --- | --- |
| `node --test --test-timeout=9000000 node/tests/test_burial_sybil_v12.js` | tests 26, pass 26, fail 0, 211.7 s |
| `node --test --test-timeout=9000000 node/tests/test_burial_offers_v12.js` | tests 3, pass 3, fail 0, 276.7 s |
| `node --test --test-concurrency=1 --test-timeout=9000000 node/tests/test_burial_proof_v12.js` at `a527207c` | tests 6, pass 6, fail 0, 2694.6 s; 1416 gaps, 416 pruned, 32 NAKs |
| `test_burial_gate_v12` 2/2, `test_burial_tip_v12` 2/2 (207 s), `test_burial_hold_v12` 14/14, `test_pruned_flag_v12`, `test_bootstrap`, `test_bootstrap_image_v12`, `test_fork_choice`, `test_getblock_nak_failover`, `test_getblock_serve_pace`, `test_getblock_taller`, `test_ibd_peer_height_v12`, `test_ibd_sequential`, `test_ibd_status` | all pass |
| `test_ipc_backfill` (4), `test_p2p_wedge` (3 to 7), `test_p2p_process_split` (2) | the same failures as base, listed below |

Sybil matrix, hashes per pruned block (blocks 1 to 4). "Sybils" is the total over three waves. Offer time is the wall time of all offers in the case, on the main thread.

| Layout | Honest | Sybils | Hashed | Slots kept | Rows limited | Offer time |
| --- | --- | --- | --- | --- | --- | --- |
| inbound /24 sybils vs outbound honest | 1 / 4 | 24 | 0, 0, 0, 0 | honest kept | 0 | 0.4 s |
| | 1 / 4 | 96 | 0, 0, 0, 0 | honest kept | 0 | 1.3 s |
| | 1 / 4 | 768 | 0, 0, 0, 0 | honest kept | 0 | 7.0 s |
| one IPv6 /64 vs inbound honest | 1 / 4 | 24 | 1, 0, 0, 0 | /64 is one slot, dropped once | 19.6k | 0.2 s |
| | 1 / 4 | 96 | 1, 0, 0, 0 | same | 91k | 0.5 s |
| | 1 / 4 | 768 | 1, 0, 0, 0 | same | 764k | 0.6 s |
| outbound sybils vs pinned honest | 1 / 4 | 24, 96, 768 | 0, 0, 0, 0 | pinned kept | 0 | 0.4 to 6.8 s |
| inbound honest on the proof path vs inbound sybils | 1 / 4 | 24, 96, 768 | 0, 0, 0, 0 | path slot kept | 0 | 0.4 to 7.2 s |

Rate limit: 1.6M junk rows over 4 inbound slots read 16,000 and skip 1,584,000, in 44 ms. Unlimited, that took 40 to 75 s.

At `b93d77b8` the slowest losing wall was 205.1 ms (2880) and length 1000 took 125.9 ms. Earlier run, owed-seed losing walls, in ms: 20 → 137.5, 48 → 131.5, 96 → 160.9, 1000 → 128.2, 2880 → 187.5. Advances were 18, 15, 31, 7 and 31, each within one checkpoint spacing of 32. Length 1000 extended past the frozen block, and length 2880 reorged the tip.

Bounded hold, 65,536 shares per block (3.8 MB per body):

| Pruned blocks | Max held | Max disk | Unbounded disk | Heap growth |
| --- | --- | --- | --- | --- |
| 1000 | 399 | 1447 MB | 3627 MB | 3.1 MB |
| 3000 | 399 | 1447 MB | 10,881 MB | 8.9 MB |
| 10,000 | 399 | 1447 MB | 36,270 MB | 5.9 MB |

The 1000-share and 8000-share rows cap at 22.9 MB and 177 MB, compared with 573 MB and 4445 MB unbounded at 10,000 blocks.

### Merge of feat at `36296798` (PR 65, ADMITv2 removal)

Merged as `f55c790d`, a merge commit with no force-push. Only `node/src/p2p.js` conflicted, in `decodeWireBlock`. Both sides leave absent `hashCredits` and `hashSpillCredits` off the decoded block, so the merge takes feat's version. `chain.js`, `store.js` and `rpc.js` merged cleanly. They keep feat's FS-1 stage-0 gates, the removed v2 verifier and the `ADMITv3 (sends off)` label, alongside this branch's burial and offer code. RPC `connect` still dials pinned. No conflict touched the burial path, so the long proof test was not rerun. Its last clean run is the one at `a527207c` above.

| Test after the merge | Result |
| --- | --- |
| `test_burial_gate_v12` | 2/2 |
| `test_burial_tip_v12` | 2/2, 205 s |
| `test_burial_hold_v12` | 14/14 |
| `test_burial_offers_v12` | 3/3, 272 s |
| `test_burial_sybil_v12` | 26/26, 204 s |
| `test_fs1_send_gate_v12` | 11/11 |
| `test_anchor_notes_v12`, `test_notes_range_030` | 1/1 each |
| `test_mempool_depth_v12` 2/2, `pool/tests/test_mempool_lattice` 6/6 | pass |
| `test_mempool_parse_v12` 0/1, `test_mempool_tag_copy_v12` 0/1, `site/tests/test_mempool` 3/4 | fail identically on feat `36296798` and on `9fbb28c0` before the merge |

### Failing on both base (`e8947428`) and this branch

These fail or time out the same way before this round. The error text is identical, apart from one timing number.

- `test_prune` 1/1: an explorer assertion at line 92.
- `test_share_credit_v12` 4: `height` vs `share_slot`.
- `test_ipc_backfill` 4: `ipc_hello` vs `ipc_getblock`.
- `test_wire_sharebatch` 2: the sealed block keeps its shareBatch.
- `test_p2p_wedge` 3 to 7, including "wedge block 1 misses genesis bits".
- `test_p2p_process_split` 2.
- `test_hash_owed_frame_v12` 3.
- `test_hash_owed_recover_v12` 1, 2, 3 and 5.
- `test_ibd_unsigned` 3: fails on base, and times out here at 1700 s under load.
- `test_p2p`, `test_snap_anchor_v12` and `test_frontier_burial_v12`: time out on both (1700 s, 1700 s and 5400 s).
- `test_fee_fold_v12` fails on base on the wire decode bug. With the decode fix it fails later, on an unrelated `1x1 c0 stranger live pool_fee_dest`.

### Known cost, not fixed here

Once pruning starts, each append costs about 1 s at roughly 1000 blocks, and the cost grows linearly. Most of it is `persistBookSnap`, `chainDiskDigest` and the frame-hash reset. It predates this branch. That is why `test_burial_proof_v12` takes about 46 minutes to build its 1448-block, three-store chain. It should be its own P0 before the 72-hour soak.
