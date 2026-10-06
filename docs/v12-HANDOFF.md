# shear-testnet-v12 handoff

Branch: `feat/shear-testnet-v12`  
Base: `c732ff5466cbd9f6e7723a5332f3604217a0355d` (`origin/main` at branch cut)  
This push is not a deploy. No tags, no release assets, no merge to `main`.

## Green

Ran with `node --test` from `C:\Users\rgsne\shear-testnet` on 2026-10-06. τ = 2h (`ASERT_TAU_MS` 7_200_000).

- `crypto/asert.test.js` — describe `ASERT 90s block retarget` (and the other describes in that file) passed.
- `crypto/note.test.js` — describe `Pedersen notes` passed (5).
- `node/tests/test_asert_v12.js` — describe `v12 genesis-anchored aserti3-2d` passed (5), including pot from the genesis header on append and ingest.
- `node/tests/test_coinbase_output_v12.js` — describe `v12 coinbase outputs are individually bound` passed (2). Amounts 0, 1, 2_000_000_000, and 100_000_000_000. An extra finder-fee on a sealed block is `levy_split`.
- `node/tests/test_ibd_peer_height_v12.js` — `a tall advertised tip still rejects a continuity lie on the block being checked` passed. `store.ingest` of a rival genesis plus a height-80000 decoy returns `continuity` at index 0. `verifyBlock` with `tipHeight: 1000000` and `samplesPruned` also returns `continuity`.
- `pool/tests/test_round_payout.js` — `provenLag1Shares drops a parent-header miss so the next job stays sealable` passed. A non-empty proven set stays non-empty after `selectBlockShares`.
- `node/tests/test_flow_vin_bind_v12.js` — describe `v12 Flow inputs are bound to Admit proofs` passed (2). Amounts 1, 2_000_000_000, and 100_000_000_000. One vin and two vins. A mismatched `cTilde`, an extra vin, and a coinbase-flagged vin return `admit_membership` from `flowInputsBound`, `admitMempool`, and `verifyBlock`. A bound one-vin send gets past that check and fails `dummy_outs`.
- `node/tests/test_money_range_v12.js` — describe `v12 money outputs are range-proven and withdraws are funded` passed (2). Kinds lock, vote, withdraw, vortice-register, evm-value, and pool-withdraw. Amounts 1, 2_000_000_000, and 100_000_000_000 on the mempool path; 1 and 100_000_000_000 on `verifyBlock`. A plaintext output is `range_proof`. A sealed withdraw with no stake, or with stake below the amount, is `insufficient`. `crypto/dummy.test.js` and `crypto/spend.test.js` passed with the dest20 skip removed.
- `node/tests/test_one_ledger_v12.js` — describe `v12 spendable is one opened-note ledger` passed (2) at `b4a2c91`. Amounts 1, 2_000_000_000, and 100_000_000_000. Note counts 1 and 3. A painted explorer row cannot raise `reconcileSpendable`, `reconstructOwner`, or `store.spendableNanos`. Portal principal (staked, idle, or both) is subtracted once from the opened sum. A stranger portal does not reduce it. `crypto/coinbase_notes.test.js` passed with that file (11 combined).
- `crypto/native/admit` `cargo test --lib exact_length_and_canonical_scalars` passed. Amounts 0, 1, 2_000_000_000, and `u64::MAX`. Trailing byte, short proof, non-canonical `z`, and non-canonical `e0` are rejected. DST `shear-bpplus-v2` and the Fiat-Shamir challenge strings are unchanged. The fingerprint label is already `RANGE=packed-bit`.
- `node/tests/test_range_canonical_v12.js` — describe `v12 range proofs are exact length and canonical` passed (2) at `2c4dbd1` against the rebuilt `shearadmit.node`. Amounts 0, 1, 2_000_000_000, and 100_000_000_000. `verifyRange` and `admitMempool` reject a trailing byte, a short proof, and `s+L` on `z` and on `e0`. `verifyBlock` returns `range_proof` for a trailing byte. `crypto/note.test.js` and `crypto/dummy.test.js` passed on that addon.
- `pool/tests/test_asert_ease_stall_v12.js` — `a stall with no new tx and no new miners eases within the spec window` passed. Gaps `8·T`, `8·T+60s`, `16·T`, and `32·T`. At `8·T` the job stays on the full packed target. Past that window the same jobId takes `quote.eased`, `bitsAcceptAsert` accepts it, and ease stays ≤ 2 bits. Miner count stays 0 and the mempool stays empty. A one-interval child quote has `easeBits` 0. `pool/tests/test_tip_stall.js` passed (3) after this. `node/tests/test_asert_v12.js` passed (5).
- `tests/test_public_copy.js`, `site/tests/test_docs.js`, and `tests/test_admit_v1_grep.js` passed (10). The pin test reads `kWalletVersion` `0.72`, `PRODUCT_VERSION` `19.0`, `SHEARK_MINER_VERSION` `2.9`, and `MAGIC_TESTNET` `shear-testnet-v12`, and the fingerprint is `ASERT_STEP=aserti3-2d` with `ASERT_TAU_MS=7200000`. Product version and the wallet pin are absent from the fingerprint. `.github/workflows/public-copy.yml` runs the docs and public-copy tests. `admit-v1-grep.yml` runs only the ADMIT v1 grep.
- `node/tests/test_job_median_bits.js` — `follows genesis-anchored aserti3-2d, not a caller target` passed. Genesis job bits stay `1114112` when the caller passes `1`. A 2s gap seals `1114913`. Six more 2s gaps seal `1120520`. A stamp 20·T later issues packed `1104136`, not the eased floor `1017397` and not the caller override. `node/tests/test_parent_interval_bits.js` — `retarget and verifyBlock use the anchored quote, not a caller target` passed. A zero gap and a stamp 50ms before the parent quote the anchored formula. `verifyBlock` rejects a same-timestamp child as `timestamp`, accepts a 1ms child and a 45s child at `quote.packed`, and returns `bits` when those headers carry the genesis seed or each other's target.

`verifyOneForkBlock` passes `genesisMs` from the accepted prefix (`genesisHeaderMs`). The epoch-floor check is inside `test_asert_v12.js` (`pot follows the genesis header across append and ingest, including the epoch floor`). A fresh node syncing a multi-epoch chain is not a separate test yet.

## Not green on this run

- `pool/tests/test_round_payout.js` — `pays N and M nanos to two miners plus 1 SHE pot on the next sealed job` failed. The first share submit came back without `result.status === 'OK'` (`undefined !== 'OK'`). Not claimed fixed.

## Open

T21 supply: circulating is the sum of public block mints minus burns, next to expected emission and the difference, plus a UTXO commitment audit. The explorer re-runs both on its own chain and alerts. Per-note coinbase values stay public `valueProof.v` until that milestone. T20 empty-batch pot fallback lands with T22 surge hardening. Wallet shewall v3 and the surge orphan bound. Payouts: work-based PROP, pot hold rule, 50/50 levy on chain, real hash bonus, restamp credit. T1–T18. Wallet Continuum 0.72. Reserve magic (v12 is not in the pinned Reserve bytecode: `bootReserveEvm` throws `reserve_deploy: revert`). ShearK 2.9 packs, sites, tags, soak. The fleet addon is not rebuilt. No soak clock.

T23 live pool.js: read-only SSH to shear-pool (`77.42.91.84`) on 2026-10-06. Checkout is detached `250bded`. `git status` shows `pool/src/pool.js` modified. After stripping CR, that file is byte-identical to `origin/main` `pool/src/pool.js`. The dirty flag is the main content plus CRLF sitting on the old v11 commit. No host-only logic. Not copied onto this branch: copying it would drop the branch's stamp-aware `parentIntervalBits`. No service was restarted.

`crypto/reserve_hold_spendable.test.js` — `sealing a 1 SHE lock drops spender spendable by 1 SHE and not by 2` did not reach the spendable assertion. `submitHeader` returned `reason: evm` because Reserve deploy reverts on this book. Principal-once is proven in `test_one_ledger_v12.js` without the EVM.

Wallet display pin is `kWalletVersion` / `kCliVersion` `0.72` and pubspec `0.72.0+97`. Window titles on Android, Windows, and Linux say `Shear 0.72`. `kBookMagic` is still `shear-testnet-v11`. Apex, README, pool, and explorer strings still say Continuum 0.71 / Sentinel v18 / ShearK 2.8 / v11, and the older public-copy checks still require those sentences. That site pass is OPEN. Wallet send/receive and T18 frame-timing are not started.

## Next step

T20 empty-batch pot rule, then T21 commitment-sum supply. Reserve allowlist is still v11 bytecode. Site strings are still the 0.71 pin set.

## Hosts and services

shear-pool `77.42.91.84`: read-only `git` and `scp` of `/opt/shear-v4/pool/src/pool.js`. No restart, no miner, no phone. `runtime/` and `wallet/android/build/` stay untracked.
