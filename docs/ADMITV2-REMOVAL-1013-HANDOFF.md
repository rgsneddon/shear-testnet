# ADMITv2 removal, steps 1–6 (2026-10-13)

Russell signed off at 12:03 BST. Steps 1–6 are on `cursor/admitv2-removal-1013`, cut from `cursor/close-open-p0-0bcc`. Step 7 (FS-1) was not done. Nothing was tagged, deployed, or copied to `feat/shear-testnet-v12` or `main`.

Parent of step 1: `ff92ba54` (Write the FS-1 gate. The live prover stays the 43490 two-bucket path.).

Toolchain: `rustup update stable` left rustc 1.99.0 (b940084d7 2026-09-28). Native addons were built with `NODE_INC=/home/ubuntu/.nvm/versions/node/v22.23.3/include/node`. The test runner is Node v22.14.0. Flutter 3.47.7 (stable, revision abaf9c5237) and Dart 3.13.5 are installed under `/home/ubuntu/sdk/flutter`. That satisfies `wallet/pubspec.yaml` `sdk: ^3.12.2`.

## Cap

The JS and N-API caps are back at the base value, **40354**. Russell ruled that the 43,490 cap must not be in consensus, and a v3 cap change is outside steps 1–6. The raise in `8c64b230` was reverted.

- `crypto/admit.js:129`: `admitVerifyV3` rejects a proof longer than 40354. v2 stays 32768.
- `crypto/native/admit_napi.c:184`: the v3 prove buffer is 40354.
- `node/tests/test_finder_levy_accept_v12.js:68`: `PROOF_CAP` is 40354.

Left as on the base, for FS-1 Stage 0 to settle: `crypto/native/admit/src/prove.rs:38` `MAX_PROOF_V3 = 43490`, and the length checks against it at `prove.rs:293` and `prove.rs:655`. The cap test still asserts 43490. So JS/N-API (40354) and Rust (43490) still disagree on this branch.

## What stayed

v3 consensus, `admitProveV3`, `admitVerifyV3`, the 64-byte `admit_prove_in` / `admit_verify_in` path, `trees_point`, `dest_leaf_fp`, `ARITY`, `outputJoinsAdmitSet`, `receiptAdmitRejected`, the scalar `jroot` and the frontier (`trees()` still serves both), `ADMIT_ARITY=32`, `ADMIT_LEAF=shear-admit-leaf-v2`, `MAX_PROOF` 32768, `MAX_PROOF_V3` 43490, `kBookMagic`, `V12_GENESIS_BLOCK_HASH` (still empty), and range-proof byte 2 (BP+). `gadget.rs` was not edited. `prove.rs` was edited twice: step 4 (`e8e9f95a`) deleted the v2 prover functions, and `340c1561` made `spend_tag_of` (`prove.rs:604`) accept byte 3 only. `MAX_PROOF_V3` and its checks in `prove.rs` were not touched.

## Commits

### 1. `d8231aee95ec1d661b72f728b77e55b26a96dcdb`

Return `admit_membership` when a flow spend does not finish the v3 check. The block and mempool paths no longer call the v2 verifier on that branch.

Tests:

- `node/tests/test_admit_byte_v12.js` and `crypto/mempool.test.js`: **4 pass, 0 fail** after `shearadmit.node` existed. Before the addon, block verify stopped at `coinbase_output` because the coinbase range proof could not be checked.
- `cargo test` (debug, default stack): **33 pass**, then `select::tests::fast_v3_body_commits_yx_to_the_tree_fingerprint` aborted with a stack overflow (exit 101). **26 not run.** 60 tests were registered.
- Wallet Dart: skipped, no Flutter SDK.

### 2. `61d9ca1d339b6cf4dd0eabe9d4e7cf377139d443`

Rejection tests post a 33-byte stub whose first byte is 2. They do not call the prover.

Tests:

- Combined node run of the retargeted files, 600s file timeout, before the gate-evm bits fix: **20 tests, 14 pass, 3 fail, 3 cancelled**.
- After the gate-evm fixture used fixed timestamps, `GENESIS_BITS_PACKED`, and `compactTx`: the stub case and the GATE case **passed**. The other two failures were already there: extra-mint expects `mint_forbidden` and got `range_proof`; an unvaulted withdraw expects `insufficient` and got `admit_version`.
- `test_admit_membership_bind_v12.js`: **1 pass**.
- `test_flow_conservation.js`: **1 pass**.
- `test_b_debit_v12.js` **4**, `test_b_index_v12.js` **2**, `test_b_leaf_parity_v12.js` **2**, `test_b_owner_v12.js` **2**, `test_bspend_mint_v12.js` **1**. All pass.
- `test_spend_tags_v12.js` stub name pattern (`reads every proof|field-less spend|multi-input spend`): **3 pass, 0 fail**.
- `test_admit_consensus.js`: file timeout at 600s. Jit ShearHash was about 48 H/s. Genesis is 17 bits. That file mines several headers and did not finish.
- `test_ibd_unsigned.js`: file timeout at 600s. The second case calls single-threaded `mineTemplate` (expected tens of minutes at this hashrate).
- `test_levy_verify.js`: file timeout at 600s. Both remaining cases mine. The compact/`admit_version` assertions were not reached.
- A standalone `admitProveV3` of n=1 did not finish (killed after about 563s). That is not a stub regression.
- `cargo test` for this step is the pre-deletion debug run below. Rust did not change in steps 2 or 3.
- Wallet Dart: skipped, no Flutter SDK.

### 3. `6e7de5388b1356c889225dbe021b35c059c5d389`

`proveFlowSpend` throws `StateError('admit_v2_closed')` before `prove_spend`. It does not call `admitProveV3`. The JS helper exits 4 with `{ ok: false, reason: 'admit_v2_closed' }` before the addon check. Range proofs still start with byte 2. The debug hook `debugNativeSpendProver` still injected a fake proof at this step. `05decf83` deleted it.

Tests:

- Hardening P0-1, the v1 grep, and the helper: **3 pass, 0 fail**.
- `prove_spend` exit 4, body `{"ok":false,"reason":"admit_v2_closed"}`. Unknown op still exits 5 `unknown_op` when the addon is loaded.
- Wallet Dart: skipped, no Flutter SDK. `wallet/test/t18_off_ui_check.dart` expects `admit_v2_closed` but was not executed.

### 4. `e8e9f95a49965e3367665a636f0ba54da655c8b6`

Deleted the v2 prover, N-API `prove` / `verify` / `verifyBatch` / `bench`, the C exports `shear_admit_prove`, `shear_admit_verify`, `shear_admit_verify_batch`, `shear_admit_bench`, and the Rust functions `admit_prove`, `admit_verify`, `admit_verify_batch`, `forest_prove`, `forest_verify`, plus the empty-context branch. The v2 Rust tests and `tests/adversary/admit_v2.js` went in the same commit. `shear_admit_max_proof` still returns 32768.

The rebuilt addon exports: `arity`, `frontierAppend`, `jroot`, `jrootPoint`, `leaf`, `maxProof`, `noteH`, `proveRange`, `proveV3`, `verifyRange`, `verifyV3`. `maxProof()` is 32768, `arity()` is 32. `prove`, `verify`, and `bench` are absent.

Tests:

- `crypto/admit.test.js` with the fresh-point case skipped: **2 pass, 0 fail** (fluxset membership, `specs/admit-v2.md` pin including `nativeMaxProof() === 32768`).
- The fresh-point case calls `admitProveV3` and was cancelled by a 120s file timeout on the first run. It was not run to completion.
- `node/tests/test_admit_byte_v12.js`: **2 pass, 0 fail**.
- `tests/test_hardening_p0.js`: **10 pass, 0 fail**.
- `crypto/mempool.test.js`: **1 pass, 0 fail**.
- `tests/test_admit_v1_grep.js`: **2 pass, 0 fail**.
- Debug `cargo test` of the deleted tree, `RUST_MIN_STACK=67108864`: **24 pass, 0 fail**, then interrupted (exit 143) during `gadget::tests::slot_link_r1cs_accepts_honest_commitment` so the release run could use the CPUs. 52 tests were registered (60 minus the 8 deleted v2 tests).
- Release `cargo test` (`RUST_MIN_STACK=67108864`, `--release`): **36 pass, 0 fail** through `leaf_rerand_binds_c_tilde`, then still inside `select::tests::leaf_rerand_v3_blinds_remainder_and_rejects_v2` when this note was written. That test calls `leaf_prove_v3` three times. It is not one of the deleted v2 tests. Debug, the same test was still running after more than 15 minutes, which is why the pre-deletion suite was stopped.
- Wallet Dart: skipped, no Flutter SDK.

Pre-deletion debug `cargo test` (steps 2 and 3, Rust unchanged, large stack): **36 pass, 0 fail**, including `fast_v3_body_commits_yx_to_the_tree_fingerprint` (the case that overflowed the default stack in step 1). Interrupted (exit 143) during `leaf_rerand_v3_blinds_remainder_and_rejects_v2`.

### 5. `b299499d4ca1f1ccf216879d7f974c74eb372d76`

`scripts/audit_admit_byte2.js` walks segments, then `chain.bin`, then `chain.jsonl`, in the same order as `createStore`. It counts admit blobs whose first byte is 2. A range proof that starts with byte 2 is not counted. Exit 0 means the book is contiguous from height 1 and no admit blob starts with 2. Exit 1 means one does. Exit 2 means absence is not proved.

The parser was not changed.

Walk on this machine:

- no path: exit 2, `no_path`
- `/home/ubuntu/.shear`: exit 2, `no_chain` (only `book-seal-keys` is present)
- `/home/ubuntu/.shear/testnet-v11`: exit 2, `missing`
- `--self-check`: exit 0 (in-memory and a synthetic `chain.bin`, not a network book)

`V12_GENESIS_BLOCK_HASH` is still `''`. There is no sealed genesis-to-tip book here to prove that no byte-2 admit blob was sealed. A snap written by an older binary can still carry a tag even though current consensus refuses a new byte-2 flow. At this step `versionedSpendTag` and `spend_tag_of` still accepted byte 2. `340c1561` narrowed them, and `d9b36510` extended this walk to snaps.

Tests: `tests/test_audit_admit_byte2.js` **1 pass, 0 fail**. Rust and C did not change, so the addon was not rebuilt and cargo was not started again. The step 4 release suite was still using `target/release`.

### 6. `f6228cf49a3830bbc558513728e4f8f8d42b2c38`

Display copy that said ADMITv2 now says ADMITv3 (node, pool, RPC, help, site, wallet CLI and UI, README). The Privacy Auditor failed this rename (M65-1). Russell then ruled that the full-set FS-1 proof is branded ADMITv3, so the name stays. Only privacy claims and bucket wording came out. See the auditor round below. `specs/consensus.md` describes the byte-3 gate: a presented flow blob whose first byte is not 3, or byte 3 with no anchor, is `admit_version`; byte 3 with an anchor is `admitVerifyV3`. The dest leaf domain in that section is still `shear-admit-leaf-v2`. `specs/law.md` line 69 is still `ADMIT=ADMITv3`. Line 138 now says ADMITv3. `specs/admit-v2.md` was not rewritten. `ADMIT_ARITY=32` and `ADMIT_LEAF=shear-admit-leaf-v2` were not edited. The docs sentence that called the statement full-chain membership now says a flow spend is a byte-3 proof, not a ring of N.

Tests:

- Public copy, brand, site clients, site docs, the admit spec pin, and the byte-2 audit: **25 pass, 1 fail**. The failure is `tests/test_public_copy.js` “states dest privacy…”. `node/src/help.js` says Continuum 0.72 and the test expects Continuum 0.71. That line was not part of the rename. The ADMITv3 assertions in the later cases of that file passed, as did the whitepaper and pool HTML checks in `pool/tests/test_brand.js`.
- `node/tests/test_p2p.js` `printConfig` admit field: **1 pass, 0 fail**.
- `pool/tests/test_pool.js` `/fingerprint` admit field: **1 pass, 0 fail**.
- `node/tests/test_rpc.js`: **2 pass, 1 fail**. The failure is `shear-testnet-v12` versus an expected `shear-testnet-v11` at `test_rpc.js:110`, before the admit assertion. Pre-existing.
- Spec pin still requires `specs/admit-v2.md` to say ADMITv2, and `nativeMaxProof() === 32768`. **1 pass**.
- Wallet Dart: skipped, no Flutter SDK.
- Rust and C did not change. Addon not rebuilt. Cargo not restarted.

## Follow-up the same evening

Russell retired the v3 group-of-32 send (FS-1 only). The long proving runs were stopped and were not restarted. Those stops are skips, not test failures. Step 7 stays undone. `V12_GENESIS_BLOCK_HASH` is still `''`. No tag, no merge, no genesis cut. `gadget.rs` was not edited. `prove.rs` was edited in step 4 (`e8e9f95a`) and in `340c1561`, as listed under "What stayed". Base stays `cursor/close-open-p0-0bcc`.

Fixes that stayed:

- The `chain.js` reason changes from `8c64b230` were taken back out (see "Follow-up: extra-mint and vault reasons"). `test_gate_evm.js` now asserts the base reasons: extra-mint is `range_proof`, and the unvaulted and over-cap withdraws are `admit_version`.
- `tests/test_public_copy.js` follows the shipped Continuum **0.72** pin in `node/src/help.js`. The site copy that still says 0.71 was left alone.
- `node/tests/test_rpc.js` expects `shear-testnet-v12`.
- JS `admitVerifyV3` and the N-API v3 prove buffer were raised to 43490 in `8c64b230`. `cdfeb2ed` put both back to 40354 (see "Cap"). Rust `MAX_PROOF_V3` stays 43490.
- `decodeWireBlock` omits `hashCredits` and `hashSpillCredits` when the wire did not carry them. An own-property set to `undefined` was making `freshForBlock` / `spillForBlock` return `hash_owed`.

Fast tests after those fixes:

- With those `chain.js` edits in place: `node/tests/test_gate_evm.js`, `node/tests/test_money_range_v12.js`, `node/tests/test_rpc.js`, `node/tests/test_verify_mint.js`, and `tests/test_public_copy.js` together were **14 pass, 0 fail**. After the base `chain.js` came back, see the follow-up section for the current counts.
- `crypto/admit.test.js` without the fresh-point prove: **2 pass, 0 fail**. The fresh-point case calls `admitProveV3` and was not run.
- Dart, `shear_wallet_test.dart` “libsodium ristretto matches dart Element; v4 send is native ADMITv2 only”: **1 pass, 0 fail**. `lib/shear_admit.dart` does not contain `admitProve`. `proveFlowSpend` still throws `admit_v2_closed` before any prover when the debug hook is null, and a hook result still has to be version 2.
- Full `flutter test` in `wallet/` (Flutter 3.47.7, Dart 3.13.5) after the comment edit: **385 pass, 48 fail** in 34m31s. The run before the edit was 384 pass, 49 fail. The one that moved is the `admitProve` source check. No failure mentions `admit_v2_closed` or `admit_native_required`. The 48 are `Isolate.run` source checks, `fee_short`, the old ssa1 short form, `no_note`, timeouts, and refused connections. They were already in the tree and are not part of this removal.
- `node/tests/test_ibd_sequential.js` **7 pass**, `node/tests/test_pruned_flag_v12.js` **1 pass**. Both read `decodeWireBlock`. `test_hash_owed_recover_v12.js` (1 pass, 4 fail) and `test_lose_block_keeps_fetching.js` (2 pass, 1 fail) fail the same way with the pre-fix `p2p.js`, so the decode change did not cause them.

Cargo stack: `.cargo/config.toml` at the repo root sets `RUST_MIN_STACK=67108864` for every `cargo test`. A debug `fast_v3_body_commits_yx_to_the_tree_fingerprint` with nothing exported aborts with a stack overflow (SIGABRT, exit 101) without that file, and passes with it (1 pass, 11.6s). Release `cargo test --lib -- --test-threads=1` with `RUST_MIN_STACK` unset, skipping only the retired v3 prove tests (`leaf_rerand*`, `tests::v3_*`, `tests::seal_v3*`, `tests::honest_c_attacker*`): **40 passed, 0 failed, 12 filtered out**, 131.93s, exit 0.
- `wallet/test/t18_off_ui_test.dart`: **1 pass, 0 fail**. `t18_off_ui_check.dart` used to seal `send` outputs to an empty address, which `sealFlowSpendVouts` refuses as a short ssa1 before the range proof. It now seals them to the wallet's own current dest. The check's pass line shows `proveErr=admit_v2_closed` and `proveClosed=3`: the decoy prove and all three sealed sends fail closed before a prover.

Skipped because the v3 group-of-32 send is retired, not because they failed an assertion:

- The Dart send test that called `admitProveV3` through `wallet_native_prove.mjs`. The node process was killed while that test was still inside the prove. The test wiring was removed so a later `flutter test` does not start it again.
- Release `cargo test` (`RUST_MIN_STACK=67108864`, `--lib`, `--test-threads=1`). **47 tests had already printed `ok`**, including `fast_v3_body_commits_yx_to_the_tree_fingerprint` and `leaf_rerand_v3_blinds_remainder_and_rejects_v2`. The process was then killed inside `tests::v3_paired_remainder_hides_the_child_slot` (n=40). The log line is `signal: 9, SIGKILL` and cargo exit 101. That is the stop, not an assertion failure. `v3_two_bucket_hides_the_spent_notes` (n=64) had not started. The suite was not restarted.
- Mining files that need hours at genesis 17 bits (`GENESIS_BITS_PACKED` unchanged): `node/tests/test_admit_consensus.js`, `node/tests/test_ibd_unsigned.js`, `node/tests/test_levy_verify.js`. They were killed while still hashing. No passing TAP line. An earlier IBD run, before the wire-credit fix, had finished **2 pass, 1 fail** (`hash_owed` on the wired genesis). The re-run after the decode fix was the one that was stopped. Difficulty was not lowered.

Still out of scope: step 7 (FS-1), a tag, a genesis cut, and a merge onto `feat/shear-testnet-v12`.

## Skipped during steps 1–6, with the reason

- Every wallet Dart test, all six steps: Flutter was not on the machine yet. The follow-up above is the run that happened after it was installed.
- Step 2 mining files at a 600s file timeout. The follow-up stopped the long 17-bit runs on purpose.
- `admitProveV3` and the release suite: not finished in steps 1–6. The follow-up stopped them because the group-of-32 send is retired.
- Step 5 parser edit: no genesis-to-tip book, so byte 2 remains a versioned tag.
- Step 7: out of scope.

## Follow-up: extra-mint and vault reasons (not in this PR)

These consensus edits were made in `8c64b230` and taken back out because they are outside steps 1–6. `node/src/chain.js` is the base version again. They should go in as their own PR.

1. Refused-kind range gate (`chain.js` around 2272, `verifyBlockConsensus`). Today a tx with no known kind and a missing or bad output range proof returns `range_proof`, before the mint check. Proposed: when that range check fails and the tx is unfunded (`vin` empty or `tx.mint`) and `extraMintAllowed(tx.programId, { kind: tx.kind })` is false, return `mint_forbidden`. A refused kind that spends a note, or passes range, keeps today's order (`range_proof`, then `kind`).
2. Reserve vault pre-check (`chain.js` just before `verifyTypedAdmitFunding`). Today `typedAdmitStructure` returns `admit_version` for a withdraw that names `from`, before `boundReserveWithdraw` runs. Proposed: for `kind: withdraw`, `tx.mint`, `programId === RESERVE_PROGRAM`, and no non-coinbase vin, call `boundReserveWithdraw(tx, reserveState, drawnWithdraws)` first and return it only when the reason is `insufficient`. A covered draw still falls through to `admit_version`. This needs `RESERVE_PROGRAM` imported from `crypto/asert.js`.

With both edits, `test_gate_evm.js` expected `mint_forbidden` / `insufficient` / `insufficient` / `admit_version`, and `test_verify_mint.js` lines 73 and 76 expected `insufficient`. That version of `test_gate_evm.js` passed 4/4, `test_verify_mint.js` 1/1, and `test_money_range_v12.js` 2/2.

On this branch now (base `chain.js`):

- `node/tests/test_gate_evm.js`: **4 pass, 0 fail**, asserting `range_proof` for the extra-mint and `admit_version` for the unvaulted and over-cap withdraws.
- `node/tests/test_verify_mint.js`: **0 pass, 1 fail**. It is the base file. It expects `mint_forbidden` for the empty-vin thief and gets `range_proof`. That is the same failure as on the base, and follow-up item 1 fixes it.
- `node/tests/test_money_range_v12.js`: **2 pass, 0 fail**.

## Auditor round (Codebase Auditor and Privacy Auditor, 2026-10-13 evening)

Both auditors failed PR 65 at `a1312a88`. Each fix below is its own commit on `cursor/admitv2-removal-1013`. Nothing was merged, tagged, or cut. PR 72 (the FS-1 Stage 0 gate) must land before PR 65 merges.

- `cdfeb2ed`: CA blocker 1 / PA M65-3. JS `admitVerifyV3` cap and the N-API v3 buffer are back at **40354**. Rust `prove.rs:38/293/655` stays at 43490 for FS-1 Stage 0.
- `8d8e0088`: CA blocker 2. `chain.js` is the base version. `test_gate_evm.js` asserts the base reasons. The proposed change is under "Follow-up: extra-mint and vault reasons".
- `40976539`: CA blocker 3. `t18_off_ui_check.dart` seals to a payable dest, so it reaches the `admit_v2_closed` check (`proveClosed=3`).
- `340c1561`: CA SHOULD / PA nit. Spend tags are read only from byte-3 blobs: `versionedSpendTag`, `proofIdentity`, `boundProofTag`, `sameBoundProof`, `versionedHead`, and `bindListedTight` in `crypto/note.js`, `spend_tag_of` in `prove.rs:604`, and the `compactTx` admit label in `crypto/chronoflux.js` (now taken from the blob's first byte, with no default of 2). A byte-2 blob with no posted field is `admit_membership`, and its tag does not enter the fluxset. `test_spend_tags_v12.js` reads byte-3 blobs and asserts that.
- `05decf83`: CA SHOULD / PA nit. `debugNativeSpendProver`, its typedef, and `nativeProveFlowSpend` are deleted. `proveFlowSpend` always throws `admit_v2_closed`, so no hook can supply a v2 (or any) proof. Thirteen wallet tests stopped installing the hook. Three that only passed because of a fake byte-2 proof now assert that the send fails closed, posts nothing, and spends no note. The temp-file test now checks `proveFlowSpend` directly.
- `d9b36510`: PA nit. `scripts/audit_admit_byte2.js` also walks a datadir's snaps. `bootstrap/latest.bin` is walked as a book. `book.snap` passes only when its frame digest matches this book's prefix and every spend tag in it comes from a byte-3 blob or a blob-less shape proof in that prefix. Without the install's seal key (or `--snap-key FILE`) it exits 2 (`snap_unkeyed`).
- `0a49aba5` then `efc0a3d1`: PA M65-1 / M65-2. `0a49aba5` replaced ADMITv3 with neutral wording. Russell then ruled (23:27 BST) that the full-set FS-1 proof is branded ADMITv3, so `efc0a3d1` puts every ADMITv3 mention back, including the `admit: 'ADMITv3'` RPC and config field. What stays removed is every "She is Private", "private cryptocurrency/ledger/notes/dest", "confidential amounts", and "amounts are confidential" claim on the public pages, README, specs (`law.md`, `flow.md`), and wallet (`main.dart:1589`, `shear_cli.dart` balance help, `shear_closure.dart:198`, `shear_privacy_hop.dart:52`, including "Connect bare is private"). Sends are off until FS-1 ships. `shear_cli.dart:77` now says "ADMITv3 is the full-set send proof. Flow sends are off until it ships." `shear_cli.dart:356` keeps "ADMITv3 + BP+ Flow". No public copy described a bucket or group-of-32 set. `tests/test_public_copy.js` now bans the privacy claims and bucket / group-of-32 / 32-anonymity wording on the public pages and the wallet strings, and still requires ADMITv3.

Not changed, and needing a ruling: the consensus fingerprint tokens `ADMIT=ADMITv3` and `AMOUNT=confidential` (`crypto/asert.js`, mirrored in `specs/law.md`). Changing them changes the fingerprint.

Tests in this round:

- Node, against the rebuilt addon: `test_audit_admit_byte2` 1/0, `test_admit_byte_v12` 2/0, `crypto/mempool.test.js` 1/0, `test_hardening_p0` 10/0, `test_gate_evm` 4/0, `test_money_range_v12` 2/0, and the `test_spend_tags_v12` stub pattern 3/0.
- Wider sweep (41 `crypto/*.test.js` files and 20 admit/spend/mempool node files): 13 files fail, and all 13 fail the same way with the byte-3 change stashed (asert, eip712, reserve_evm, shear_hash, spend, the anchor/bspend/flow-vin/mempool-parse/tag-copy/spend-sig node files). Six files hit the 300s timeout on a real prove or mine: `admit.test.js`, `admit_v3.test.js`, `test_admit_consensus`, `test_admit_v3_fund_v12`, `test_lock_tag_respend_v12`, and the full `test_spend_tags_v12`.
- Release cargo, fast subset (`--test-threads=1`, skipping the retired v3 proves): **40 passed, 0 failed, 12 filtered**.
- Copy: `test_public_copy` 5/0, `site/tests/test_clients` 4/0, `site/tests/test_docs` 4/0, `pool/tests/test_brand` 11/0. With the neutral wording, `pool/tests/test_pool` was 33/0 and `node/tests/test_rpc` 3/0. `forbid_foreign_names` (1/1) and `test_p2p_process_split` (1/1) fail identically on the base.
- Dart: the 8 hook-related tests by name 8/0. `t18_off_ui_test.dart` 1/0. `shear_wallet_test.dart` plus `continuum_072_send_v12_test.dart`: **225 pass, 26 fail**. No failure mentions `admit_v2_closed` or the deleted hook. 7 of the 26 used the hook and also failed at `40976539` with the hook in place. The other 19 are UI, timeout, sync, and `Isolate.run` source checks.
