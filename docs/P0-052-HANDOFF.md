# P0 052 — P2P burial gate

Branch: `cursor/p0-052-burial-gate-0f14`, cut from `feat/shear-testnet-v12` at `690d35a7`. No genesis cut, no tag, no deploy. `crypto/admit.js` and ADMITv2 were not edited.

Census row: `docs/P0-CENSUS-2026-10-13.md`. Explicit output kind is already `explicitTypedKindRejected` (`crypto/spend.js`). The open half is the burial rule. Wake and `docs/v12-HANDOFF.md` item 79 call it inbox 052, the P2P burial gate. A peer `samplesPruned` flag is not that gate. `sealedCreditsBuried` / `flowSkipAllowed` stay the depth rule (`SAMPLE_PRUNE_CONFIRMATIONS`). This change does not add a second prune protocol.

## Fix

A block is buried only under the tip of the chain being validated, and only at its structural height (the accepted parent, plus one).

- `assessHeader` (`node/src/chain.js`) rejects a `height` field that is not that structural height with `height`, before slot burial, ASERT, or `skipFlow`. A missing field stays the structural height. `verifyBlockConsensus` uses the same height.
- `verifyAgainstTip` (`node/src/store.js`) no longer sets `samplesPruned` from the peer height. A peer-advertised height must not prune.
- `forkBurial` is the candidate fork's own length. The local store tip does not bury a shorter chain.
- A suffix still replays an already-pruned prefix under `max(local tip, candidate tip)`. Blocks the suffix adds are buried only by the candidate tip (`suffixBurial` on adopt).
- `applyVerifiedIpcBlock` (`node/src/p2p_ipc.js`) uses this tip plus one. A disagreed height is `height`. `samplesPruned` on that next block stays `samples_pruned`.

## Tests

`shearhash.node` and `shearadmit.node` were not built. The height and `samples_pruned` rejects return before a coinbase range proof.

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 --test-timeout=180000 node/tests/test_burial_gate_v12.js` | tests 2, pass 2, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 310.426288 |

`rejects a peer height before it can open burial` (63.913131 ms). Genesis heights 2, 80000, and 0 are `height`. Height 1 and a missing height, with `tipHeight` 1000000, are `samples_pruned`. A child of a height-5 parent at heights 1, 5, and 80000 is `height`. Ingest of height 80000 is `height` and the tip stays empty. IPC of height 80000 is `height`. IPC of height 1 with `samplesPruned` is `samples_pruned`.

`does not bury a new block under the local tip` (1.36454 ms). `forkBurial` is `fork.length` and does not take `Math.max` with the store tip. `verifyAgainstTip` does not call `shouldPruneSamples(incomingH`. The suffix path names `candidateTip` and `suffixBurial`.

`node --test --test-concurrency=1 --test-timeout=180000 --test-name-pattern 'verifyBlock still rejects|wire blocks carry|shipped p2p headers' node/tests/test_ibd_sequential.js` — tests 3, pass 3, fail 0, duration_ms 352.268728.

`node/tests/test_ibd_peer_height_v12.js` stopped at `coinbase_output` on the first honest append (duration_ms 59.122621). That is the missing range-proof addon, before the burial gate. It was not re-run after a native build.
