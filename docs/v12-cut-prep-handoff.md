# v12 cut-prep handoff

Status: **NOT APPLIED**. No genesis cut. No pin fill. No tag. No deploy. No soak.

`docs/v12-cut-readiness.md` (audit `bc-ba79211b`) is not on `feat/shear-testnet-v12` at `d9d828fd4286a0fcf0bf6137155f18a1a2c4ddb4` and was not in the tree this queue used. Nothing below invents findings from that audit.

Feat tip for this queue: `d9d828fd4286a0fcf0bf6137155f18a1a2c4ddb4`.

## Genesis pin — NOT APPLIED

`node/src/chain.js` still has:

```js
export const V12_GENESIS_BLOCK_HASH = '';
export const V12_BOOTSTRAP_CHECKPOINT = Object.freeze({ height: 0, hash: '' });
```

A non-empty pin must be 64 lowercase hex characters. A non-hex pin fails closed. Height 0 means the checkpoint is unset.

Do not run the steps in this section until Russell's GO.

1. Choose an empty directory. `scripts/v12-genesis-cut.mjs` refuses a root inside the git checkout, the live node datadir, `~/.shear`, or `%APPDATA%\Shear`.
2. Run `node scripts/v12-genesis-cut.mjs --root <empty-dir>`. This command was **not** run.
3. Read `block1.hash` and `block1.height` from the `V12_GENESIS_CUT` JSON line. The script does not print a separate checkpoint object.
4. Set `V12_GENESIS_BLOCK_HASH` to that `block1.hash`.
5. Set `V12_BOOTSTRAP_CHECKPOINT` to `{ height: <cut checkpoint height>, hash: '<64 lowercase hex>' }`. If the cut book is only height 1, that checkpoint is `block1.height` and `block1.hash`. Leave height 0 until that hash is in hand. Do not invent a hash.

These two assignments were **not** edited on any branch this queue pushed.

## Tags — NOT APPLIED

Display pins already in the tree are Continuum `0.72`, Shear Sentinel `v19` (`PRODUCT_VERSION` `19.0`), and ShearK `2.9`. There is still no git tag for them.

Do not run these commands until Russell's GO. `<cut-tip>` is the commit Russell names after the pin is filled. It is not this handoff commit and not `d9d828fd`.

```
git tag -a 0.72 <cut-tip> -m "Continuum 0.72"
git tag -a v19 <cut-tip> -m "Shear Sentinel v19"
git tag -a ShearK-2.9 <cut-tip> -m "ShearK 2.9"
git push origin 0.72 v19 ShearK-2.9
```

**NOT APPLIED.** None of those four commands was run. `0.72`, `v19`, and `ShearK-2.9` were not created. No other ShearK tag was created. `0.70`, `0.71`, and `v18` were not moved.

## Queue report

1. **018e Share Commitment.** PR 94, open, not merged. Base `feat/shear-testnet-v12`. Head `4092f25911b92443a52a580e2a2bf108c32bcb08`. Branch `cursor/share-commit-018e-seal`, cut from feat, not from PR 68. `crypto/admit.js` was not changed. `node --test` on the seal: tests 15, pass 15, fail 0, twice. Mergeable. Blocked on Russell's sign-off before merge.
2. **PR 91 licence CI.** PR 91. Head `6cfc6389dfca0b48b2fdd90c8653a78f7711d8b9`. GitHub Actions `notices` and `android-deps` both pass. **PR 77 skipped.** Head is still `b7149d2d978326cff25382c3870bef97b616bad4`, state OPEN, mergeable CONFLICTING. No cloud-agent-finished signal and no force-push GO, so it was not rebased.
3. **Public copy.** PR 75. Head `05416f7feeb7f04b48f2f3a83ef2292002104ace` (merge of feat, no force-push). Mergeable MERGEABLE. GitHub `public-copy` job `copy` SUCCESS. Local `node --test site/tests/test_docs.js tests/test_public_copy.js`: tests 10, pass 10, fail 0. Network copy says `shear-testnet-v12`. The datadir folder and launcher `SHEAR_NETWORK` stay `testnet-v11`. No live deploy and no restyle.
4. **Boot-verify worker.** PR 95, open, not merged. Head `a6b3a88e878af18fadfb3713f2fa5f7cd29af59a`. Branch `cursor/boot-verify-worker-060`. `verifyLoadedChainAsync` runs `stepLoaded` in a worker. Short-chain `node/tests/test_boot_verify_worker.js` twice: tests 3, pass 3, fail 0. The foreign-replay case twice: tests 1, pass 1, fail 0. Event-loop timer turns were above 300000 on each boot-verify run. Accept/reject matched the synchronous load, including a bad height. A soak-length replay was not started. The light tests are the gate.
5. **Windows datadir DACL.** PR 96, open, not merged. Head `7a628b8a2cad0f1b42c5269cbd4e3e5b6fae9214`. Branch `cursor/datadir-acl-065`. `node/tests/test_datadir_acl.js` twice: tests 2, pass 2, fail 0. The temp datadir ACE was only `DESKTOP-ODTSQ56\rgsne`. The test did not use `%APPDATA%\Shear` or `shear-data`. Off Windows the helper returns `applied: false` and does not call `icacls`.
6. **This note.** Pins and tags above are unapplied. PRs 90, 85, and 93 were not rebased, force-pushed, or merged by this queue.

## Left for Russell

- PR 90 head `301d05f1d35e75866f94e2f04c8941e5765ed8ef`. OPEN. MERGEABLE against feat, so it was not treated as stale and was not rebased.
- PR 93 head `a4f5b6a63afaf8e2d9b28213927b8a18cf06203f`. OPEN. MERGEABLE against feat, so it was not treated as stale and was not rebased.
- PR 85 was not edited by this queue. Its live head is `b9c2b4f0f5f7d0ab77411643d7e4314988de26df` (`t21: seal payee-cap overflow as own-round escrow` on `cursor/t21-hidden-coinbase-fb4f`). That is ahead of the earlier `bdf11abc6502f17562f3524b9a1c6846124cf40f`. This queue did not move it back and did not push the branch.
- Consensus and `crypto/admit.js` changes, including merging PR 94, still need Russell's sign-off.
- No force-push was used.
