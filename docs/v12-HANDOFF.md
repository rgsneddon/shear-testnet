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
- `pool/tests/test_empty_round_pot_v12.js` — empty rounds of counts 0, 1, 4, and 17 mint only this subsidy's pool-fee (`POOL_FEE_BPS`) and carry the miner remainder, including parent carry. A kind `pot` skim beside that carry is `pot_carry`. Zeroing the carry word is `pot`. Proven rounds of 1 miner, 3 miners, and a mixed idle/work set pay subsidy plus carry; the fee is the bps slice of the new subsidy, not of the carried pot. Idle miners are unpaid. Minted notes plus outstanding carry equal the sum of subsidies. `node/tests/test_coinbase_output_v12.js` passed (2) after this.
- `pool/tests/test_fee_dest_v12.js` — the pool page paragraph that ends `Testnet.`, `GET /api/stats` `feeDest`, and `THIS_POOL_DIRECT_FEE_DEST` are the same address `ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv`. `isDestAddress` accepts it. The first pool coinbase (height 1, empty round) seals one `pool-fee` note to that dest for the bps slice and carries the miner pot. No `kind: pot` on that coinbase. v10 and v11 fee pins are refused, including via `SHEAR_POOL_FEE_PAYOUT_DEST`. `pool/tests/test_posture_067.js` fee-identity and public-stats checks passed. Worker dests, pubs, and the fluxset stay off public stats. No fee amount field.

- `node/tests/test_supply_v12.js` — describe `v12 circulating supply is the public mint` passed (4) on 2026-10-06. Epochs 0, 1, 7, 80, and 120. Share counts 1, 4, and 15. Empty-round streaks of 1, 3, and 6. An oversized hash note is `mismatch` and is not credited. `node/src/supply.js` does not call `openedCoinbaseNanos` or `coinbaseVoutsBound` and does not read `valueProof`.
- `pool/tests/test_block_status.js` — three `networkSupply` cases passed: unopened coinbase commitments are not painted as the schedule, a Tree-A count or a zero hash vout is not a minted bonus, and painted pot nanos, vault mint bank, pull credit, and open-round counts are not emission. The older assertion that height 1 is confirmed at tip 6 was not part of this run.
- `node/tests/test_synthetic_pow_v12.js` — `verify, submit, RPC, ingest, and IPC hash the header` passed. A target-meeting stand-in seals only with in-process `{ trusted: true }`. `verifyBlock`, `submitHeader` without that flag, RPC `submitblock` and `submitHeader` (including a caller `trustedPowHash`), default `ingest`, P2P `ingest({ offLoopPow: true })`, and `applyVerifiedIpcBlock` return `pow`. `shearHash(header)` does not meet the genesis target.
- `node/tests/test_ipc_backfill.js` passed (4). A gap wider than 8 is still offered. The empty sidecar stays at a null tip and logs `ipc_apply` reason `pow`. A jumped block still asks for its parent. `pool/tests/test_admit_template.js` — `forwards an admitted lock from a non-mining node into the job store` passed after that IPC change.
- `pool/tests/test_empty_round_pot_v12.js` passed (4). A carried pot is one split of (subsidy − this block's fee + carry), using the same weights as that round's pot. Live rows sort by address. A share batch sorts by note commit. Shuffled order pays the same nanos. The fee stays `floor(subsidy * POOL_FEE_BPS / 10000)`. Consensus seals that split and returns `pot_prop` for a last-row dump.
- Work-based PROP. `unitsForShare(shareBits)` is `2^bits` at or above `SHARE_FLOOR_BITS`. `unitsForShare()` with no bits stays 256. `collateShareUnits`, `aLeavesFromShares`, and `verifyShareBatch` use the share's credited bits. A dest-bound hash that misses the claimed bits is `share_pow`. The packed work frame (`ENC_SHARE_WORK`) keeps those bits on the wire. A v5 frame with no bits still pays the floor. The unit cap still drops a share whose units alone exceed `MAX_HASH_UNITS_PER_BLOCK`. `node/tests/test_work_prop_v12.js` passed (3): equal share counts at bits floor and floor+4 do not pay the same across subsidies 10000, 100000003, and the epoch-0 subsidy, and carries 0, 17, and 50000; a count-weighted coinbase on that batch is `pot_prop`; a work-weighted coinbase seals. `pool/tests/test_round_payout.js` passed (2). The old fixed N-and-M stratum grind is gone. The replacement sweeps subsidies, carries, and miner mixes (1, 2, 3, 4, and 5 dests), shuffled order pays the same nanos, minted notes equal subsidy plus carry, and the fee stays the subsidy bps. A carried pot is not added whole to one row when both weights are positive. `node/tests/test_supply_v12.js` credits hash units of `2^bits` for bits floor, floor+1, floor+4, and floor+8, and a floor-sized hash note at a higher bit is `mismatch`. `pool/tests/test_block_status.js` still returns 256 for an empty batch with one confidential hash vout (4 networkSupply cases passed).
- `node/tests/test_pot_prop.js` — `epoch pot follows the genesis header, and height 1 stays epoch 0` passed, with the other 7 cases in that file (8). Epochs 1, 2, 7, 80, and 120. Height 1 pays `potSubsidyNanos(0)` even when its timestamp is one or more epochs after an external clock. Paying that epoch's subsidy on height 1 is rejected (`pot_carry`: the template carries the underpay beside a pot note). A child of the genesis header, stamped one or more epochs later, pays `potSubsidyNanos` of that epoch and rejects the epoch-0 subsidy and one nano over. The mint check is unchanged.

`verifyOneForkBlock` passes `genesisMs` from the accepted prefix (`genesisHeaderMs`). The epoch-floor check is inside `test_asert_v12.js` (`pot follows the genesis header across append and ingest, including the epoch floor`). A fresh node syncing a multi-epoch chain is not a separate test yet.

## Genesis procedure (READY for CoS)

Build does not cut, deploy, SSH, bounce, or start the soak. CoS runs this from a clean checkout of the pushed `feat/shear-testnet-v12` tip.

```
node scripts/v12-genesis-cut.mjs --root <empty-dir-outside-the-repo-and-outside-testnet-v11>
```

A second run on the same root checks the book and does not reseal. A root inside the git checkout, under `~/.shear`, or under `%APPDATA%\Shear` exits 2 and does not wipe. Missing `--root` exits 2.

Pins the script asserts: magic `shear-testnet-v12`, product `19.0`, wallet `0.72`, ShearK `2.9`, fee dest `ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv`. It writes `<root>/pool/pool-v12.json` from those pins. `kBookMagic` is still `shear-testnet-v11` (`walletBookPin: open`). Do not treat the wallet book pin as flipped.

Genesis params: aserti3-2d, T = 90000 ms, τ = 7200000 ms, genesis bits packed 1114112, HEADER_AHEAD 15000 ms, MTP future 7200000 ms, pool fee 100 bps.

sha256 at the dry run:

- `crypto/asert.js` `4bb5b217138a8ba72f7dfe486804c13a71ca8a4429958f36a8f500360f9ebf7b`
- `pool/src/posture.js` `5a7bce04524860750692b945fef280f4ea76f905a3cb281fe169c34d31794286`
- `pool/src/pool.js` at the dry run was `49492529b7928b7b04eed741e4979a5d522869d409e11ca6f5a1e642c87662ac`. This push's pool.js is `501a44ea035ed3da652f70ab1f43eaab6bfe1273c144b00f88d12d617891980e` (pro-rata carry). CoS uses the hash the script prints.
- `node/src/supply.js` `1336bf473f9b4fad30b2946ea8456e3615361a410c69e491cf184c59b14e8598`
- `wallet/lib/main.dart` `cd12154b548da5f57c2014abd4d356ae799565b09aad356d54a14d8e240c964e`
- `wallet/lib/shear_identity.dart` `be2f4be597ef4f85ff62bb5eff19e1b08af6e5d2d083f0dab944747f36f1ac35`
- `scripts/v12-genesis-cut.mjs` `792dc71e19e1755a6bca1588df50aa8ad5d39dd6227f6154673d8b45379bef03`

### PoW bypassed locally

The dry run seals a digest that meets the 17-bit genesis target. It is not `ShearHash(header)`. This host hashes at about 2.5 H/s, so a real grind is not the dry run. `localSeal` in the script output is `target-meeting digest, not ShearHash(header)`.

Mandatory after the live cut, before the soak clock: a real ShearK miner finds block 1, and a node that is not the sealing pool verifies that header's ShearHash itself. P2P ingest does not take a caller digest. RPC `submitblock` / `submitHeader` ignore `trustedPowHash`, `powHash`, and `skipSharePow`. IPC apply hashes the header. In-process `{ trusted: true }` remains for tests and for the pool process after that process has already hashed the share. Reloading an already-accepted header in `rebuildSpentB` still skips ShearHash so status does not stall the event loop. That shortcut is not a peer-accept path.

### Local dry run (2026-10-06, scratch dir, not a live datadir)

`git HEAD` at the run was `cf83dbcdb04e545fa3f63237dbad1fbbe518553c` and the tree was dirty. First run exit 0, `cut: true`, `idempotent: false`. Second run exit 0, `cut: false`, `idempotent: true`, same hash and timestamp. `--root` set to the repo exited 2, `root is inside the git checkout`.

Block 1: height 1, hash `0000000000000000000000000000000000000000000000000000000000000001`, feeNanos 1000000000, carryNanos 99000000000, subsidyNanos 100000000000, bits 1114112, timestamp 1791295054358, nextPacked 1114112, easeBits 0. Supply `verified`, circulatingNanos 1000000000, schedulePotNanos 100000000000, carryNanos 99000000000, differenceNanos 0, hashNanos 0. Explorer height 1, same hash, `supplyStatus: verified`, `inSync: true`. `walletBookPin: open`.

CoS post-cut checks, on the real chain: block 1 coinbase pays one `pool-fee` note to the published fee address and carries the miner remainder; ASERT anchor and the supply audit are `verified`; the explorer tip matches the pool tip; block 1 was mined by ShearK and a second node accepted it by hashing the header.

## Open

The 50/50 levy, a real hash bonus from `shareBatch` with `included:true` only after the mint, and restamp credit are open. Work-based PROP is in the green list above. Carried pot uses those same work weights. T22 surge hardening, wallet shewall v3, and the surge orphan bound are open. T1–T18 except the public-copy CI split. Wallet Continuum 0.72 send/receive is not started. Reserve magic: v12 is not in the pinned Reserve bytecode (`bootReserveEvm` throws `reserve_deploy: revert`). ShearK 2.9 packs, site pin sentences, tags, and the soak are open. The fleet addon is not rebuilt. No soak clock. No pool-fee keys were created or imported. No tags.

`kBookMagic` is still `shear-testnet-v11`. Apex, README, pool, and explorer sentences still say Continuum 0.71 / Sentinel v18 / ShearK 2.8 / v11. The pool fee address line on `pool/public/index.html` stays as shipped when those sentences change. Wallet send/receive and T18 frame-timing are not started.

`crypto/reserve_hold_spendable.test.js` — `sealing a 1 SHE lock drops spender spendable by 1 SHE and not by 2` did not reach the spendable assertion. `submitHeader` returned `reason: evm` because Reserve deploy reverts on this book. Principal-once is proven in `test_one_ledger_v12.js` without the EVM.

T23 live pool.js was read earlier. No host was contacted for this push. No service was restarted.

## Next step

CoS cuts v12 from the genesis procedure above when the open payout items they care about are acceptable. Build's next code is the 50/50 levy (finder half to the miner who found the block, reserve half to the Reserve and the Vault fee bank) and a real hash bonus from `shareBatch`. The pin flip stays deferred. τ stays 2h. `pool.js`, `chain.js`, `share_batch.js`, `pack.js`, and `supply.js` moved after the dry run. CoS uses the hashes the genesis script prints at cut time.

## Hosts and services

None this push. No SSH, no bounce, no miner change, no phone. `runtime/` and `wallet/android/build/` stay untracked. A branch push is not a deploy.
