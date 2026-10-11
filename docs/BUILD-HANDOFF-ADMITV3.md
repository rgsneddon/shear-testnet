# Build handoff — ADMITv3 point-leaf root

PowerShell Build: this file is the instruction. Read it before landing another ADMITv3 prove. Branch `cursor/admit-v3-point-root-0bcc`. Draft PR https://github.com/rgsneddon/shear-testnet/pull/55. The same pointer is the first paragraph of `docs/v12-HANDOFF.md` on this branch.

Date: 2026-10-11
For: the PowerShell Build agent on Russell's laptop
From: the cloud agent on `cursor/admit-v3-point-root-0bcc`
Base: `origin/feat/shear-testnet-v12` at `25e610f` (Paint rho per second and name the atomic unit a sheath.)

CoS is asleep until Tuesday 15:00. This branch does not launch v12. Do not cut genesis, move tags, flip `kBookMagic`, deploy, SSH to the pool, or start the 72 hour soak. When CoS is back, the cut is still theirs: `node scripts/v12-genesis-cut.mjs` into an empty directory outside this repo and outside the v11 datadir. A soak stamp is a real start and a real end after a live block 1 that a second node accepts by hashing ShearHash. The dry-run digest is not that hash. There is no soak stamp in this tree.

`f6efcdf` was not on any remote when this branch was cut. Do not invent it. If that commit appears, replay it onto `25e610f` and do not drop the rho paint or this point-root work. Do not push `feat/shear-testnet-v12` from this branch. Do not merge it yourself.

## Commits

- `172ef9f` Seal the book fingerprint as `ADMIT=ADMITv3`.
- `9d29431` Point ADMITv3 funding at the point-leaf root.
- `5440021` Drop unused v3 leaf offsets from the prover import. This was wrong for the forge tests.
- `7889414` Keep the v3 leaf offsets for the forge tests. `V3_Y` and `V3_YX` are `#[cfg(test)]`.

The token is `ADMIT=ADMITv3` with a lowercase v, the same shape as `ADMIT=ADMITv2`. Display strings that say ADMITv2 (node stats, pool pages, wallet copy, `fp.admit`) are not the sealed token. They were left alone. `specs/law.md` and `specs/admit-v2.md` still name the old token. `docs/v12-HANDOFF.md` item 87 is the earlier audit and still says the cap is 40354. That paragraph is history.

## What closed in code

The fingerprint token in `consensusFingerprint()` is `ADMIT=ADMITv3`.

The v3 book root is `jroot_hash_point`: SHA-512 of `shear-jroot-point-v3 || dest_root || c_root`, first 32 bytes. `jroot()` and the chain fluxset root stay `shear-jroot-v2`. `trees_v3` has its own cache, so a v3 prove does not replace the v2 root. `frontier` still uses the v2 root.

The first v3 C fold is `r·U + Σ C_i` under `shear-admit-c-point-v3`. A zero child is the identity. A non-zero child that is not a ristretto point fails closed. Upper folds stay the scalar commitment `commit_ristretto_encodings`. The dest fold is still `commit_vesta`.

One exception, and it has to stay visible: when that first fold is a single node (one bucket, n ≤ 32), the C root stays the scalar commitment. That root is the public parent the existing leaf IPA opens. Rewriting the leaf MSM was not done. `jroot_v3` still differs from `jroot` for n ≤ 32 because the domain string differs. There is no second bucket to hide on that path, and the proof does not carry the raw bucket or the trailer.

For n > 32 the glue in front of the leaf is no longer `commit_vesta` and `commit_ristretto_encodings` of the raw 32-note bucket. The wire is `V3_RAW_LINK` = 2240 bytes: 1024 dest rows, 32-byte dest blind, 1024 C rows, 32-byte C blind, then 128 bytes `Q || A || z_u || z_h`. The verifier recomputes `commit_vesta` for the dest opening and `commit_ristretto_points` for the upper C opening, and passes the recomputed scalar C commitment into `leaf_verify_v3`. The leaf equations are unchanged. Upper paired layers stay the old 128-byte scalar links.

The trailer is `Q = C_i + ρ·U`, bound to `Kc = C_i + ρ_c·H` by a two-base Schnorr. `Q` is not `C_i` (`ρ` is nonzero). It is written only when `n_layers > 1`. It is not a membership proof. The scalar OR in the leaf still is.

`MAX_PROOF_V3` is 42466. That is `HDR + 2*(PAIRED_LEN+128) + PAIRED_LEN + V3_RAW_LINK + LEAF_V3_LEN` for four layers. Height 5 is 48930 and does not fit. The v2 cap stays 32768. The napi prove buffer and `admitVerifyV3` use 42466. `jrootV3` is exported beside `jroot`.

`verifyTypedAdmitFunding` keeps `admitV3Context({ root: live.jroot })`. That context root is the v2 fluxset root the existing prove sites already bind. When `pubs` and `commits` both have length `n`, funding requires `jroot` of that slice to equal the stored fluxset root, requires `anchorRootHashPoint` of the proof header roots to equal `jrootV3` of the same slice, and passes that point root as `extra.jroot` into `admitVerifyV3`. A record with no note set still compares `anchorRootHash` (`shear-jroot-v2`) to `live.jroot`, so the 129-byte tag checks in `node/tests/test_spend_tags_v12.js` still fail as `admit_link_tag` or `admit_tag` before native verify. `noteFromAnchor` now also returns `pubs` and `commits` sliced to the anchor's `n`. Callers that only read `jroot` and `n` are unchanged.

## What this does not close

Do not mark the release gates closed.

- `kBookMagic` in `wallet/lib/shear_identity.dart` is still `shear-testnet-v11`.
- Tags `0.72`, `v19`, and ShearK were not created. Tag `v12` is still the old Continuum 0.62 commit.
- `V12_GENESIS_BLOCK_HASH` stays empty. No genesis was cut.
- No deploy, no SSH, no soak. The 72 hour clock starts only after live block 1.
- `NODE_DISPLAY` is still Shear Sentinel v18. `node/pack/README.md` still says product 18.0.
- FS-1 stays wired false.
- Continuum does not emit v3 proofs. A wallet send is still an ADMITv2 proof.
- An n > 32 proof publishes the raw 32 notes of the spent bucket. An observer who can read those notes knows which group of 32 was spent. That is the anonymity set. The deterministic point commitment of that bucket is not stored as its own 32-byte field. Do not claim the bucket id is hidden.
- Items that need a phone, a fleet blob compare, a live chain, a macOS ShearK pack, or an on-chain payout stay open. The 50/50 finder/reserve split is already in the tree (`splitLevy`, `floor(fee * 5000 / 10000)`). No live payout was observed.
- `node/tests/test_spend_tags_v12.js` field-less send fails `value_open` on feat tip `25e610f` as well. This branch did not cause it and did not fix it.
- Reader copy that still says "hash nanos" (pool intro, `site/docs/content.js`, repo-root `dag/index.html`) was left. Rho paint is already on feat. Do not redo it in this branch.

## Tests already run

- `cargo test --manifest-path crypto/native/admit/Cargo.toml --lib -- v3_point_root_does_not_move_v2_jroot --test-threads=1` passed. n = 64 and n = 32. The v3 cache does not move the v2 root. `commit_ristretto_points` of a bucket differs from `commit_ristretto_encodings`.
- `cargo test --manifest-path crypto/native/admit/Cargo.toml --lib -- v3_cap_fits_height_4 --test-threads=1` passed. `v3_proof_len(4) == 42466`. Height 5 does not fit.
- `node --test crypto/asert.test.js` passed, including `ADMIT=ADMITv3`.
- `node --test node/tests/test_spend_tags_v12.js`: the short-blob tag cases passed, and a note set whose v2 root is not the anchor root returns `admit_anchor_root`. The field-less send and the multi-input send fail `value_open`. The same field-less failure reproduces on a clean checkout of `25e610f`.
- After `npm run build:admit`, `jrootV3` of valid ristretto notes differs from `jroot` at n = 1, 2, 31, 32, 33, and 64, and a second `jroot` call matches the first.

## IPA suite

Started 2026-10-11T10:43:03Z, release, `--test-threads=1`, log `/opt/cursor/artifacts/admit-v3-ipa.log`:

1. `leaf_rerand_v3_blinds_remainder_and_rejects_v2`
2. `admit_honest_v3_hides_the_note_and_rejects_a_different_set`
3. `fresh_point_outside_the_set_fails_admit_verify_v3`
4. `honest_c_attacker_p_fails_admit_verify_v3`
5. `two_bucket_v3_does_not_publish_the_spent_group`

Do not treat items 1–9, the out-of-set spend, or the n = 64 bucket link as closed until that log ends in `ALL_PASS` and the assertions are still the ones in `crypto/native/admit/src/lib.rs`. A failure means the publication or the opening is wrong. Do not weaken `two_bucket_v3_does_not_publish_the_spent_group` to make a commitment window pass.

Prior timing on the dest-bind leaf: `honest_c_attacker_p --release` was one test in 4375.77s. Expect the same order of cost here.

## Tuesday

If this IPA log is `ALL_PASS` and you have not found a conflicting prove on the laptop, the point-leaf funding gap from item 87 is the part this branch set out to close. The book is still not genesis-ready until CoS cuts it. Tuesday 15:00 is when CoS can start that cut. It is not a licence for this agent or for Build to cut, tag, deploy, or start the soak while they are asleep.
