# ADMITv2 removal, steps 1–6 (2026-10-13)

Russell signed off at 12:03 BST. Steps 1–6 are on `cursor/admitv2-removal-1013`, cut from `cursor/close-open-p0-0bcc`. Step 7 (FS-1) was not done. Nothing was tagged, deployed, or copied to `feat/shear-testnet-v12` or `main`.

Parent of step 1: `ff92ba54` (Write the FS-1 gate. The live prover stays the 43490 two-bucket path.).

Toolchain: `rustup update stable` left rustc 1.99.0 (b940084d7 2026-09-28). Native addons were built with `NODE_INC=/home/ubuntu/.nvm/versions/node/v22.23.3/include/node`. The test runner is Node v22.14.0. Dart and Flutter are not installed (`command -v dart` and `command -v flutter` are empty). `wallet/pubspec.yaml` wants `sdk: ^3.12.2` and the Flutter SDK, so every wallet Dart test was skipped.

## Cap mismatch (not fixed)

The JS v3 verify cap and the Rust cap disagree.

- JS, `crypto/admit.js`: a proof longer than **40354** bytes fails `admitVerifyV3`. The comment still says a height-4 v3 proof is 40354 bytes and that v2 stays 32768.
- Rust, `crypto/native/admit/src/prove.rs`: `MAX_PROOF_V3` is **43490**. The cap test still asserts 43490.
- The N-API v3 prove buffer is also allocated at 40354.

That was left as it is.

## What stayed

v3 consensus, `admitProveV3`, `admitVerifyV3`, the 64-byte `admit_prove_in` / `admit_verify_in` path, `trees_point`, `dest_leaf_fp`, `ARITY`, `outputJoinsAdmitSet`, `receiptAdmitRejected`, the scalar `jroot` and the frontier (`trees()` still serves both), `ADMIT_ARITY=32`, `ADMIT_LEAF=shear-admit-leaf-v2`, `MAX_PROOF` 32768, `MAX_PROOF_V3` 43490, `kBookMagic`, `V12_GENESIS_BLOCK_HASH` (still empty), and range-proof byte 2 (BP+). `gadget.rs` was not edited. `spend_tag_of` still accepts byte 2 or byte 3, because step 5 did not prove the book is free of sealed byte-2 blobs.

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

`proveFlowSpend` throws `StateError('admit_v2_closed')` before `prove_spend`. It does not call `admitProveV3`. The JS helper exits 4 with `{ ok: false, reason: 'admit_v2_closed' }` before the addon check. Range proofs still start with byte 2. The debug hook `debugNativeSpendProver` still injects a fake proof so existing wallet pipeline tests can run.

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

`V12_GENESIS_BLOCK_HASH` is still `''`. There is no sealed genesis-to-tip book here to prove that no byte-2 admit blob was sealed. A snap written by an older binary can still carry a tag even though current consensus refuses a new byte-2 flow. `versionedSpendTag` in `crypto/note.js` and `spend_tag_of` in `prove.rs` still accept byte 2.

Tests: `tests/test_audit_admit_byte2.js` **1 pass, 0 fail**. Rust and C did not change, so the addon was not rebuilt and cargo was not started again. The step 4 release suite was still using `target/release`.

### 6. `f6228cf49a3830bbc558513728e4f8f8d42b2c38`

Display copy that said ADMITv2 now says ADMITv3 (node, pool, RPC, help, site, wallet CLI and UI, README). `specs/consensus.md` describes the byte-3 gate: a presented flow blob whose first byte is not 3, or byte 3 with no anchor, is `admit_version`; byte 3 with an anchor is `admitVerifyV3`. The dest leaf domain in that section is still `shear-admit-leaf-v2`. `specs/law.md` line 69 is still `ADMIT=ADMITv3`. Line 138 now says ADMITv3. `specs/admit-v2.md` was not rewritten. `ADMIT_ARITY=32` and `ADMIT_LEAF=shear-admit-leaf-v2` were not edited. The docs sentence that called the statement full-chain membership now says a flow spend is a byte-3 proof, not a ring of N.

Tests:

- Public copy, brand, site clients, site docs, the admit spec pin, and the byte-2 audit: **25 pass, 1 fail**. The failure is `tests/test_public_copy.js` “states dest privacy…”. `node/src/help.js` says Continuum 0.72 and the test expects Continuum 0.71. That line was not part of the rename. The ADMITv3 assertions in the later cases of that file passed, as did the whitepaper and pool HTML checks in `pool/tests/test_brand.js`.
- `node/tests/test_p2p.js` `printConfig` admit field: **1 pass, 0 fail**.
- `pool/tests/test_pool.js` `/fingerprint` admit field: **1 pass, 0 fail**.
- `node/tests/test_rpc.js`: **2 pass, 1 fail**. The failure is `shear-testnet-v12` versus an expected `shear-testnet-v11` at `test_rpc.js:110`, before the admit assertion. Pre-existing.
- Spec pin still requires `specs/admit-v2.md` to say ADMITv2, and `nativeMaxProof() === 32768`. **1 pass**.
- Wallet Dart: skipped, no Flutter SDK.
- Rust and C did not change. Addon not rebuilt. Cargo not restarted.

## Skipped, with the reason

- Every wallet Dart test, all six steps: Dart and Flutter are not on this machine.
- Step 2 mining files (`test_admit_consensus.js`, `test_ibd_unsigned.js`, `test_levy_verify.js`): 600s file timeout. Genesis difficulty is 17 bits and Jit ShearHash on this VM was about 48 H/s. Difficulty was not lowered.
- `admitProveV3` / the fresh-point JS case, and the release `leaf_rerand_v3` (and the lib.rs v3 prove tests behind it): not finished. One n=1 prove was killed after about 563s. The release suite was still inside the first `leaf_prove_v3` test when this note was written.
- Step 5 parser edit: no genesis-to-tip book, so byte 2 remains a versioned tag.
- Step 7: out of scope.
