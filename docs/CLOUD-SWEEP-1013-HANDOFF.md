# Cloud sweep 1013 — handoff for Build

Branch: `cursor/cloud-p0-sweep-1013`, cut from `cursor/close-open-p0-0bcc` at `38592720`. Pushed only to this branch. No tag, no deploy, no SSH. `gadget.rs`, `prove.rs`, and the n=64 prove were not touched. `MAX_PROOF_V3` stays 43490. `kBookMagic`, `V12_GENESIS_BLOCK_HASH`, the tags, `crypto/admit.js`, and ADMITv2 were not edited. The 55-file pool suite was not run.

Census of what was open at the parent tip: `docs/P0-CENSUS-2026-10-13.md`.

## Commits

| SHA | Closes | What landed |
| --- | --- | --- |
| `45bd003512229b347a9915cbb1ea106dfd22d56e` | census | `docs/P0-CENSUS-2026-10-13.md`. One row per still-open P0 and P1, with file:line evidence on tip `38592720`. |
| `106b2fa3b67e7fd059a5a697789452b01ef04856` | N-49 | Unauthenticated wallet, queue, and stratum bodies are capped at 1 MiB (`HTTP_TX_BODY_MAX` in `crypto/json_bounds.js:8`). A block submit still uses the 16 MiB P2P frame. `flowInputsBound` matches an extra `admit_proof` by the 32-byte tag already bound (`crypto/note.js:881`) and runs `sameBoundProof` only on a tag hit. |
| `f9897d506c20a1bbd7cc8aff34e9cf277b75667a` | 072 | `custodialPullRejected` (`crypto/levy.js:248`) returns `custodial_pull` for a disabled pool-withdraw before the kind gate, on queue, `queueSend`, mempool, funded body, and `verifyBlock`. Other refused kinds stay `kind`. |
| `a4b132b80e952bf25d02be9bb3140e48fa5a1f9e` | PSA-5a56-3 | Fresh logins are capped at 4 per IP per 10s (`LOGIN_PER_IP_MAX`, `pool/src/pool.js:953`) before `miners.set` and before `jobForSession`. A known worker reconnect is not counted. A cache miss returns the shared job and `scheduleFinderAim` (`pool/src/pool.js:3956`) seals one new dest on a later turn. The fee socket does not aim. |
| `890c39de09d4355267fbb453f51d3685922266bf` | PSA-5a56-1r | `collectIssuedHeaders` (`pool/src/pool.js:1225`) pins the live job, then walks jobs newest first, and stops at `ISSUED_HEADER_CAP`. `snapshotIssuedHeaders` passes `lastJob` as that pin. |

## Tests

Native range proofs were required for the 072 `verifyBlock` cases. `rustup update stable` installed rustc 1.99.0 (1.83 cannot build zeroize 1.9). `shearadmit.node` was built with `make -C crypto/native shearadmit.node` and is gitignored. `shearhash.node` was not built. These commands do not hash a header.

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 --test-timeout=180000 node/tests/test_tx_cap_v12.js` | tests 4, pass 4, fail 0, duration_ms 897.005 |
| `node --test --test-concurrency=1 --test-timeout=180000 node/tests/test_typed_inflation_v12.js pool/tests/test_custodial_pull_v12.js` | tests 9, pass 9, fail 0, duration_ms 16414.374 |
| `node --test --test-concurrency=1 --test-timeout=180000 pool/tests/test_login_aim_cap_v12.js` | tests 2, pass 2, fail 0, duration_ms 674.001 |
| `node --test --test-concurrency=1 --test-timeout=180000 pool/tests/test_inbox012_bounds_v12.js node/tests/test_finder_sibling_v12.js node/tests/test_finder_levy_v12.js` | tests 3, pass 3, fail 0, duration_ms 11310.848 (templateForFinder peek refactor) |
| `node --test --test-concurrency=1 --test-timeout=180000 pool/tests/test_issued_headers_v12.js` | tests 1, pass 1, fail 0, duration_ms 268.449 |

Before `shearadmit.node` existed, `test_typed_inflation_v12.js` stopped at `coinbase_output` on the parent commit as well. That was the missing range-proof addon, not the reason split.

## Left for Build

| Id | Why it stayed |
| --- | --- |
| VS-1 | Interest zeros in `supplyFromScalar` (`node/src/supply.js:383-385`). Restoring them needs the supply walk, not a one-line edit. |
| 018e | Share Commitment is uncoded. No `Timely`, `Prod`, or `CapUnits_prod`. |
| 052 | Explicit output kind is already `kind` (`crypto/spend.js:575`). P2P burial itself is not in. |
| 017 | The owed carry is coded. A pruned block still does not re-check a sealed owed commitment. |
| 16–23 | Continuum send and receive were not run on a device. |
| 40 | Public stats still publish the full fee dest. The tests that lock that value were not retuned. |
| N-25, N-26 | Named open. No function or test carries the id. |

## Left for Russell

| Id | Why it stayed |
| --- | --- |
| cut | Genesis hash is empty. No `0.72`, no `v19`, no ShearK tag. No soak stamp. |
| 31 | Fleet Reserve blobs. This sweep did not SSH. |
| 33–37 | ShearK 2.9 source pin is in. macOS pack and the live spread are not. |
| D-3 | `crypto/admit.js` is still ADMITv2. Sign-off required before any edit. |
| 035 | Out-of-set spend was not started. The hide pass does not close it. The prove lane owns `gadget.rs` and `prove.rs`. Cap stays 43490. |

## Left for Contabo

| Id | Why it stayed |
| --- | --- |
| pool-55 | The 55-file suite stays the recorded fail (285 tests, 256 pass, 27 fail, 2 cancelled on `aba1a9e9`). Not started here. |
| 033b | `test_hash_bonus_cap.js` was not re-run. |

## Checked and already closed on the parent tip

N-43, N-28, L-1/L-1b, N-47, 093b (law; the `value_open` test was left), P0-da9-1, PSA-5a56-1 except the header residual closed above, PSA-5a56-2, n=64 hide. WH-1 is not an id in the wake, the Stage section, the v12 handoff, either attached review, or the tree.
