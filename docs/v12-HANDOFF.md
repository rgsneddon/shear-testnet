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

`verifyOneForkBlock` passes `genesisMs` from the accepted prefix (`genesisHeaderMs`). The epoch-floor check is inside `test_asert_v12.js` (`pot follows the genesis header across append and ingest, including the epoch floor`). A fresh node syncing a multi-epoch chain is not a separate test yet.

## Not green on this run

- `pool/tests/test_round_payout.js` — `pays N and M nanos to two miners plus 1 SHE pot on the next sealed job` failed. The first share submit came back without `result.status === 'OK'` (`undefined !== 'OK'`). Not claimed fixed.

## Open

One spendable ledger. Range-proof canonical scalars and exact length (Fiat-Shamir DST unchanged). Chain-resummed supply, including the explorer node re-summing pot + hash bonus + levy + Vault mint − burns from its own chain and alerting on a mismatch with the pool figure or the schedule. T20 empty-batch pot fallback, wallet shewall v3, and surge orphan bound. Payouts: work-based PROP, pot hold rule, 50/50 levy on chain, real hash bonus, restamp credit. T1–T18. Wallet Continuum 0.72. Reserve magic, ShearK 2.9 packs, sites, tags, soak. No hosts were deployed. No soak clock.

Wallet Dart files on this branch (`wallet/lib/main.dart`, `shear_ledger.dart`, `shear_native_prove.dart`, `shear_note.dart`, `wallet/test/shear_wallet_test.dart`) are unfinished selector work. They are not Continuum 0.72 done. T18 frame-timing is not started.

## Next step

One spendable ledger: `destSpendableNanos` must not let a plaintext explorer row raise spendable above opened Admit notes. Prove it with `node --test` for more than one note count. Then range-proof exact length and canonical scalars, then chain-resummed supply (node and explorer each publish verified sum, expected emission, and the difference).

## Hosts and services

None. No SSH, no pool, no miner, no phone. `runtime/` and `wallet/android/build/` stay untracked.
