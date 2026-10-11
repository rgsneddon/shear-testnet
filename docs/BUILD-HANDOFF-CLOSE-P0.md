# Build handoff — closeable items on the feat point-leaf layout

Watch C:\Users\rgsne\shear-testnet\.cos-inbox\ and read every new item before each change. First read docs/BUILD-HANDOFF-ADMITV3.md on branch cursor/admit-v3-point-root-0bcc at 4262675 before landing another ADMITv3 prove, and do not cut genesis, move tags, flip kBookMagic, deploy, or start the soak.

Date: 2026-10-11
For: the PowerShell Build agent on Russell's laptop
From: the cloud agent
Branch: `cursor/close-open-p0-0bcc`
Base: `feat/shear-testnet-v12` at `5a5685ad9b9d9d7c4efca095abb5003264023c3c`

This branch starts at Build's merge. It does not replace it. `MAX_PROOF_V3` stays 43490. The raw arity-32 C bucket stays on the wire until the hide proof lands. `v3_two_bucket_spent_link_stays_on_the_wire` still requires those raw notes. Do not flip that test to fake a hide. Do not land `cursor/admit-v3-point-root-0bcc` on top of this branch. That branch is cap 42466 and a different glue. Do not push `feat/shear-testnet-v12`. Do not merge. Do not cut genesis, move tags, flip `kBookMagic`, deploy, SSH, or start the soak.

The n=64 spent-bucket hide is the open proof on this branch. Cursor is on that proof now. It keeps Build's cap 43490. `cursor/admit-v3-point-root-0bcc` stays at cap 42466. Do not start a second prove of that hide. Do not replay the 42466 glue here.

CoS is asleep until Tuesday 2026-10-13 16:30 Europe/London. The earlier 15:00 figure was wrong. That 16:30 clock is still CoS's cut, and this work does not start it. Do not ping CoS before then. Do not cut genesis, deploy, or start the soak while they are out. `scripts/v12-genesis-cut.mjs` is CoS's. `V12_GENESIS_BLOCK_HASH` stays empty. There is no soak stamp.

## Stage

One board for every agent. Update this section in place. Do not start a second handoff. Do not push `feat/shear-testnet-v12`. Do not merge this branch onto feat. Do not cut genesis, move tags, flip `kBookMagic`, deploy, SSH, or start the soak.

Checked 2026-10-11 15:31 +0100 from Russell's laptop. The laptop fast-forwarded onto `c3ce0cb`. CoS is asleep until Tuesday 2026-10-13 16:30 Europe/London. The earlier 15:00 figure was wrong. Agents keep closing local work. They do not cut genesis, move tags, deploy, or start the soak before that. Newest inbox file is still `161-CLOUD-readonly-checks-6ee12af2.md` (2026-10-09 19:26). Nothing newer in `C:\Users\rgsne\shear-testnet\.cos-inbox\`. Cursor checked this same file at 2026-10-11 15:30 +0100 from the cloud worktree and fast-forwarded onto `6076932` before editing. That check found no further hide circuit since `f36682e`. The laptop inbox path is not readable from the cloud VM. This Stage section is refreshed about every 30 minutes. No new lane was pushed. `feat/shear-testnet-v12` stays `5a5685ad9b9d9d7c4efca095abb5003264023c3c`. `cursor/coinbase-u64-0bcc` stays `26f72396383ce38b9d2dcee33123ac2be6e4f41f`. `cursor/admit-fund-land` stays `5a5685a`.

| Lane | Where | Stage |
| --- | --- | --- |
| n=64 spent-bucket hide | `cursor/close-open-p0-0bcc` | In progress. Cursor owns it. `f36682e` reduces the chained SHA-512 digest mod the ristretto order. That is not the hide. The raw arity-32 C bucket stays on the wire. `v3_two_bucket_spent_link_stays_on_the_wire` still requires those notes. Cap stays 43490. Do not start a second prove. The gate note under this table is the current blocker. |
| Point-leaf funding prove, set sizes 1, 8, and 40 | Laptop tree `C:\Users\rgsne\shear-admit-fund-land`, branch `cursor/admit-fund-land`, HEAD `5a5685a`, addon built from that commit | Running. Not the hide. `node --test --test-name-pattern "point-leaf proof" crypto/admit_v3.test.js`. Node pid 17608, started 2026-10-11 13:56:33 +0100. At 15:31 +0100 the process was still alive, about 95 minutes of wall time, CPU about 14753s. Working set was about 1.35 GB and private memory was about 1.48 GB. The log is still 178 bytes and only the missing `shearhash.node` warning. No pass and no fail. Do not start another release IPA on this 4-core host until that process exits. |
| `feat/shear-testnet-v12` | `5a5685ad9b9d9d7c4efca095abb5003264023c3c` | Frozen at the admit merge. Do not push. |
| Yx filter `honest_c_attacker_p` | Laptop only, on the `5a5685a` combined layout | Release pass, 1 passed, 0 failed, 51 filtered, 5088.59s. Not committed on this branch and not on feat. The "not re-run" line below is still true for this branch. |
| Rho copy and `RHO=1sheath` | Dirty and uncommitted on `shear-admit-fund-land` | Do not land. This branch already sealed `ADMIT=ADMITv3` at `6e2d5f5`. A local paragraph numbered 89 on that tree's `docs/v12-HANDOFF.md` collides with item 89 (the cut gates). Do not push it. |
| Genesis, tags `0.72` / `v19` / ShearK, book magic, fleet, soak | CoS, asleep until Tuesday 2026-10-13 16:30 Europe/London | Not started. No soak stamp. Do not cut while CoS is out. `kBookMagic` stays `shear-testnet-v11`. |
| Coinbase u64 open | `cursor/coinbase-u64-0bcc` at `26f72396383ce38b9d2dcee33123ac2be6e4f41f` | Pushed. Not merged. Not on feat. `openedCoinbaseNanos` and `coinbaseVoutsBound` keep any amount in `0..2^64-1`. A safe integer still returns a number. A rounded JS number does not open. `node/tests/test_coinbase_output_v12.js` passed 2. The amount case was 3867.8937 ms. The sealed-block levy case was 2131.1246 ms. |
| Continuum send amounts | This tree, addon from `5a5685a` | Not closed. `crypto/range_exact.test.js` passed 1 while HEAD was `e8f684b`. The case was 1093.28 ms, duration_ms 2073.9884. Amounts 0, 1, 256, 2^53-1, 2^53+1, 2^62, 2^63, and 2^64-1 went through `proveRange` as decimal strings. A value of 2^64, `-1`, `1.5`, and ` 1` return an empty proof. `d5c27e2` does not change that test. `pool/tests/test_wallet_send.js` passed 16, 0 fail, duration_ms 83909.2107, on the same tree. T18 was not run. The Flutter runner was not started. Windows-to-Android was not run. |

Hide, cloud check 2026-10-11 15:30 +0100. No further hide circuit since `f36682e`. That commit puts the ristretto scalar of the chained SHA-512 digest on `V[0]`. It does not hide the bucket. Debug `bind_sha512_wide_matches_ristretto_scalar`: 1 passed, 0 failed, 54 filtered, 6.34s. Cleartext samples, including the group order itself, match `from_bytes_mod_order_wide`. A 200-byte message is 429042 gates, padded 524288. A second 200-byte message has the same constraints. A residue one away from the honest scalar fails. The point domain plus 32 zero notes is 1919937 gates, padded 2097152. The raw notes are still published. The earlier pieces still stand: one-block SHA-512 is 214081 gates, ristretto compress is 32945, order reduce is 1780, and `c_bind` is 808917. Putting 32 compresses, 32 on-curve checks, one windowed mul, and 32 point adds on top of these 1919937 hash-and-reduce gates still points at about 4.94 million gates and a 2^23 pad. A 2^23 blob with two committed wires is 64 bytes past the 3264-byte tail, so height 4 would be 43554 bytes. The cap test requires 43490. No IPA was started. `seal_v3`, fresh-point, attacker, and the n=64 test are not claimed.

## Closed on this branch

`8d9ee67` Fail closed when a version-3 C child is not a ristretto point. `commit_ristretto_points` returns `None` when a child does not decompress. The all-zero pad decompresses to the identity, so an honest bucket sum is the same sum as the old skip. `jroot_point`, the v3 prove path, and verify follow that `Option`. A scan of `[b; 32]` for `b` in `1..64` found a non-point and rejected it. `[2u8; 32]` does decompress, so a single `2` byte is not the reject case.

`3f463ce` Bind typed funding to the anchor notes and the stored v2 root. `noteFromAnchor` returns `pubs` and `commits` sliced to `n`. `verifyTypedAdmitFunding` requires `jroot` of that slice to equal the stored `jroot` when both books are present, then still checks the point root `fundingJroot` and passes that root into `admitVerifyV3`. The context root stays the point root. A stored root of 32 bytes of `0x09` returns `admit_anchor_root` and does not set `proofChecked`. A chain record whose v2 root matches, and whose proof header does not, returns `admit_anchor_root` with `proofChecked` true.

`6e2d5f5` Seal the fingerprint token as `ADMIT=ADMITv3`. The sealed list in `crypto/asert.js`, the law line, and the backtick token in `specs/admit-v2.md` use the lowercase v. Display fields that say `ADMITv2` were left, including node stats `admit` and the pool page. `kBookMagic` stays `shear-testnet-v11`. The pool HTML pin stays `shear-testnet-v11`.

`978f395` Cap network JSON nesting and HTTP body size. `crypto/json_bounds.js` and `wallet/lib/shear_json_bounds.dart` share the caps: body 16 MiB, nesting 32, stratum line 64 KiB. RPC POST, pool POST, admin POST, stratum, solo stratum, p2p frames, p2p IPC frames, public HTTP follow, the watch client, the payout watch client, and the wallet node JSON readers use them. A body over the cap is `body_cap` (HTTP 413). Nesting over the cap is `json_cap` (HTTP 400). A long stratum line destroys the socket. Local ledger files were not capped.

## What was run

Debug, not release. `cargo test --manifest-path crypto/native/admit/Cargo.toml --lib -- --test-threads=1 commit_ristretto_points_rejects_a_non_point` passed. 1 passed, 0 failed, 52 filtered out, finished in 0.05s. The debug compile before that run was 0.82s. `npm run build:admit` was not run. `shearadmit.node` was not rebuilt. The Node tests below used the addon built from `5a5685a`. Honest points still verify on that addon. The fail-closed native path is the Rust test until the addon is rebuilt from this tree.

`node --test node/tests/test_anchor_notes_v12.js` passed 1, the case 114.146975 ms, duration_ms 366.711207. One real note. `noteFromAnchor` keys are `commits`, `jroot`, `n`, `pubs`, sliced to `n` 1. The v2 root and the point root differ. A 129-byte version-3 junk header through that record is `admit_anchor_root` with `proofChecked` true. The same notes with `jroot` set to 32 bytes of `0x09` are `admit_anchor_root` with `proofChecked` undefined.

`node --test --test-name-pattern 'shaped bad proof' node/tests/test_supply_parents_v12.js` passed 1, the case 121.675864 ms, duration_ms 433.293512. The stub now carries one real note and the matching v2 root, so the 40-byte version-3 blob still reaches the short-proof return. `proofChecked` is true. `anchorFluxRebuilds()` stays 0. The lookups count is 1.

`node --test --test-name-pattern 'bakes HASH_TX_LIVE' crypto/asert.test.js` passed 1, the case 225.844567 ms, duration_ms 355.746779. The fingerprint matches `ADMIT=ADMITv3`.

`node --test crypto/json_bounds.test.js` passed 1, the case 0.703552 ms, duration_ms 70.52084. Depth `JSON_MAX_DEPTH` is accepted. Depth `JSON_MAX_DEPTH + 1` throws `json_cap`. Brackets inside a string, and an escaped quote, stay inside the string.

`node --test node/tests/test_http_follow.js` passed 1, the case 1.733101 ms, duration_ms 279.449012. The mock still uses `text()`. A stream body is capped when `getReader` exists.

`node --test --test-name-pattern 'pins the shipped native book' crypto/admit.test.js` passed 1, the case 5.764579 ms, duration_ms 176.737207. The spec title still contains the word ADMITv2. The sealed token line is `ADMIT=ADMITv3`.

`tests/privacy.walk.js` case 11 failed before the fingerprint line. `admitMempool` of the `she` send returned `range_proof`. The assert wanted `silent_id_on_chain`. Line 326. duration_ms 563.09457. That file was not retuned. The fingerprint assert in it was not reached. `node/src/chain.js` and `crypto/admit_v3.js` are not on that path. `crypto/mempool.js` was not edited.

Not re-run on this branch, and not claimed here: `seal_v3_opens_the_note_in_the_set`, `v3_fresh_point_outside_the_set_fails`, `honest_c_attacker_p_fails_admit_verify_v3`, `v3_two_bucket_spent_link_stays_on_the_wire`, the Yx filter, and `crypto/admit_v3.test.js` for sets of 1, 8, and 40. Those are IPA. Build's `seal_v3` n=8 on `5a5685a` was 4592.82s. The laptop Yx pass and the still-running funding prove are recorded in Stage above. They are not commits on this branch. Do not start a second full release IPA while another admit suite is already running.

## Still blocked

The n=64 spent bucket is still published. Hiding it while the leaf IPA opens those bytes is a new proof, not a patch. Do not flip the two-bucket test to make a hide-bucket layout pass.

`kBookMagic` stays `shear-testnet-v11`. Pool `public/index.html` stays on that pin, Continuum 0.71, and ShearK 2.8, because `pool/tests/test_pool.js` asserts that HTML. The pin flip stays deferred.

Genesis, tags, deploy, SSH, and the 72h soak stay with CoS. No fleet Ready. No phone. Items 16-23 stay open. `pool/tests/test_wallet_send.js` passed 16 on `e8f684b`. T18 and Windows-to-Android were not run. macOS ShearK is open: no Mac host, and `zip_unix.py` refuses a binary that is not Mach-O. Live soak binaries still print 2.8 and `shear-testnet-v4`. Item 36 vardiff reconnect spread was not run. Continuum does not emit v3 proofs. FS-1 stays unwired. T21 option A (blinded per-dest work plus a split proof) stays a design hold. Inbox 018e Share Commitment is uncoded. Inbox 012, 015, 018-018f, 019, 022-024, 025, 027, 052, and 088 were not implemented. D-3, N-6ee-2, N-25, and N-26 stay open. 070 checkpoint leftovers and 072 full pool regression were not run. 033b `test_hash_bonus_cap` was not re-run. There is no priority P2. P2P burial is inbox 052, not a priority.

`node/tests/test_spend_tags_v12.js` field-less spend and multi-input spend fail `value_open` on this tree and on `25e610f`. That was left as it was.

Tuesday 2026-10-13 16:30 Europe/London is not a start by itself. The earlier 15:00 figure was wrong. CoS is asleep until 16:30. The chain path can now see the anchor notes. The cut still needs a genesis, one book magic, packs, a fleet match, a live payout, and the gates in `docs/v12-HANDOFF.md` item 89.
