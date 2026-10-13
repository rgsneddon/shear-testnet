# P0 070 and PSA-c2a-1 — one burial tip, and the depth-1000 un-bury

Branch: `cursor/p0-070-c2a1-burial-d437`, cut from PR 67 (`cursor/p0-052-burial-gate-0f14` at `edcb2be9`). No genesis cut, no tag, no deploy. `crypto/admit.js` was not edited.

Status row: `docs/P0-STATUS-2026-10-13-PM.md` on `cursor/p0-status-1013-pm-765f`. 070 is the depth-1000 un-bury and the owed-seed lengths 1000 and 2880. PSA-c2a-1 (113a, CA CONFIRMS) is one burial height for the chain being validated, on commit and on verify. Inbox 112a's J-root rebuild stays out of this patch. `fluxsetFromBlocks` is still the slow path; a fork template extends the flux this store already carries.

PR 67 left a split. `forkBurial` was already the fork's own length. `verifySuffixBody` still seeded and stepped the prefix under `max(local tip, candidate tip)`. `finishAdopt` still stepped that prefix under `max(old tip, adopted tip)`. This branch removes that split.

## Fix

The burial tip is the tip of the chain being validated. A peer `tipHeight` is not that tip. A height field on a block is not that tip. The local store tip does not raise it.

- `forkBurial` returns `fork.length`. It does not take `max` with the store tip.
- `verifySuffixBody` uses one height for `seedHistory`, the prefix `supplyStep`, and the new block's `burialTip`: the linked length of the candidate (`base height + fork.length`). The return value is `burialTip`.
- `finishAdopt` uses that same `burialTip` for the prefix `supplyCarriedTo` and the suffix `supplyStep`. The local tip does not raise it.
- `seedHistory` buries under the candidate tip it was given. A missing share body on a block that tip no longer buries is `samples_pruned`.
- `rebuildSpentB` binds the body that tip would see. A pruned block this tip lifts has to present the batch it kept.

A block pruned at depth 1000 keeps its share batch. `pruneBuried` writes it under `datadir/burial-hold/<block hash>` before it drops the batch. Fast-sync does not write that file. A later tip that no longer buries the block puts the batch back, in memory and in the segment. Verify lifts a copy. A losing fork does not un-prune the canonical block. A missing body fails closed.

`store.fluxThrough(index)` is the carried flux through that block, frontiers included. The owed-seed fork template extends it. Rebuilding J from genesis is not the checkpoint gap, and this patch does not change `crypto/admit.js`.

## Tests

`node/tests/test_burial_tip_v12.js`

- The source names one tip: `forkBurial` is `fork.length` with no `Math.max`; `seedHistory(rows, tipAt, candidateTip)`; adopt steps `supplyCarriedTo(lca - 1, suffixBurial)` and `tipHeight: suffixBurial`.
- A chain of 1000 blocks, then two emergency-eased blocks, buries a credited block at height 2. A peer `tipHeight` does not bury it. A shorter fork from height 20 loses on work (`side_hold`) and leaves the canonical block pruned. The same fork after a reload of `burial-hold` is still `side_hold`. Deleting the hold makes that fork `samples_pruned`. A heavier fork that keeps height 1000 and drops the tip to 1001 adopts, restores the share batch, and reloads that way. `foldSupply` agrees.

`node/tests/test_owed_seed_v12.js` runs lengths 20, 48, 96, 1000, and 2880. The losing fork's owed advances stay within one checkpoint spacing (32). The losing wall stays under 5s and under `min * 4 + 250`. At height 1000 the heavier fork extends, because that block is the reorg floor (`CHECKPOINT_FIRST_HEIGHT`, then every 400). Replacing it is `reorg_checkpoint`. Length 2880 replaces only the tip.

`node/tests/test_burial_gate_v12.js` still rejects a lied height before burial, and still requires `forkBurial` to be the fork length.

## Results

`shearhash.node` was built locally for the full-load parity check and is gitignored. `crypto/admit.js` was not modified.

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 --test-timeout=180000 node/tests/test_burial_gate_v12.js` | tests 2, pass 2, fail 0, duration_ms 335.810608 |
| `node --test --test-concurrency=1 --test-timeout=180000 --test-name-pattern 'names one burial tip' node/tests/test_burial_tip_v12.js` | tests 1, pass 1, fail 0, duration_ms 221.86276 |
| `node --test --test-concurrency=1 --test-timeout=900000 --test-name-pattern 'un-buries a pruned block' node/tests/test_burial_tip_v12.js` | tests 1, pass 1, fail 0, duration_ms 215004.512224 |
| `node --test --test-concurrency=1 --test-timeout=3600000 node/tests/test_owed_seed_v12.js` | tests 2, pass 2, fail 0, duration_ms 1136721.581138 |

Losing owed walls, ms: 20 → 134.9, 48 → 132.1, 96 → 159.3, 1000 → 125.5, 2880 → 189.3. Max 189.3, under 5000 and under `min * 4 + 250`. Advances 18, 15, 31, 7, 31, each within one spacing of 32. Length 1000 extended past the frozen block. Length 2880 reorged the tip.
