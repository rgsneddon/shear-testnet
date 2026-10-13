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
- **Wire decode fix.** `decodeWireBlock` set `hashCredits` and `hashSpillCredits` to `undefined` when they were absent. That broke `hash_owed` on every wire ingest of a block without a spill. The keys are now set only when present. The base branch fails `test_fee_fold_v12` on this.

## Tests

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
| `node --test --test-concurrency=1 --test-timeout=7200000 node/tests/test_owed_seed_v12.js` | tests 2, pass 2, fail 0, 1171.7 s |
| `node --test --test-concurrency=1 --test-timeout=9000000 node/tests/test_burial_proof_v12.js` | tests 6, pass 6, fail 0, 2770.7 s |
| `node --test node/tests/test_burial_hold_v12.js` | tests 14, pass 14, fail 0, 32.6 s |
| `node --test node/tests/test_burial_tip_v12.js` | pass 2, fail 0, 198.2 s |
| `node --test node/tests/test_burial_gate_v12.js` | pass 2, fail 0 |
| `test_load_body_v12`, `test_load_snap_v12`, `test_pruned_flag_v12`, `test_bootstrap`, `test_bootstrap_image_v12`, `test_fork_choice`, `test_frontier_window_v12`, `test_getblock_nak_failover`, `test_getblock_serve_pace`, `test_getblock_taller`, `test_hash_spill_v12`, `test_ibd_peer_height_v12`, `test_ibd_sequential`, `test_ibd_status`, `test_snap_interest_v12` | all pass |

Owed-seed losing walls, in ms: 20 → 137.5, 48 → 131.5, 96 → 160.9, 1000 → 128.2, 2880 → 187.5. Advances were 18, 15, 31, 7 and 31, each within one checkpoint spacing of 32. Length 1000 extended past the frozen block, and length 2880 reorged the tip.

Bounded hold, 65,536 shares per block (3.8 MB per body):

| Pruned blocks | Max held | Max disk | Unbounded disk | Heap growth |
| --- | --- | --- | --- | --- |
| 1000 | 399 | 1447 MB | 3627 MB | 3.1 MB |
| 3000 | 399 | 1447 MB | 10,881 MB | 8.9 MB |
| 10,000 | 399 | 1447 MB | 36,270 MB | 5.9 MB |

The 1000-share and 8000-share rows cap at 22.9 MB and 177 MB, compared with 573 MB and 4445 MB unbounded at 10,000 blocks.

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
