# P0 018e — Share Commitment

Branch: `cursor/share-commit-018e-d0ad`, cut from `cursor/cloud-p0-sweep-1013` at `bb238e803301ac326e6e6d8eef5a88bf6113e410`. Pushed only to this branch. No genesis cut, no tag, no deploy, no SSH. `crypto/admit.js` and ADMITv2 were not edited. `gadget.rs`, `prove.rs`, `kBookMagic`, and `V12_GENESIS_BLOCK_HASH` were not touched. `shearhash.node` was not built.

Census row: `docs/P0-CENSUS-2026-10-13.md`. Sweep note: `docs/CLOUD-SWEEP-1013-HANDOFF.md`. Both name the same open item: Share Commitment is uncoded. There is no `Timely`, `Prod`, or `CapUnits_prod` in `crypto/hash_owed.js`. The smallest fix is Timely times plus invalidate-omit, then the 018f tests, and a full cross-producer hash bonus. Zeroing `shareBatch` pay would imitate the rule. This is a design seal, not a patch, and it is not the 017 owed ledger.

## The seal

`Timely(commitMs, parentMs, blockMs)` is true only when all three times are non-negative integers and `parentMs < commitMs <= blockMs`. A missing time is not timely.

`Prod(shares)` is the sum of strict `2^b` units. An illegal width returns null. An empty list is `0n`.

`CapUnits_prod(prod)` is `0n` when production or the block cap is zero, otherwise `min(prod, MAX_HASH_UNITS_PER_BLOCK)`. An invalid input returns null.

`shareCommitAccount` is invalidate-omit. Parent carry is due ahead of new timely commits. Rows sort by `commitMs`, then `noteCommit`, then nonce. The same `noteCommit` and nonce is one row, and the carry wins the duplicate. A due row that fits the remaining cap is fresh hash-bonus credit (`shareCommitPay`). It does not take a `shareBatch` seat. A new timely commit that fits, while seats remain under `MAX_SHARES_PER_BLOCK`, is mandatory and must be in `included`. A row whose units exceed the remaining cap goes to the next carry, and a later smaller row can still fit. Omitting a mandatory share returns `ok: false`, `bad: false`, `reason: share_commit`. A malformed row returns `bad: true`. `shareBatch` pay is not cleared. Extra included shares stay paid through `freshCreditsFromShares`.

The next producer pays a fitting parent carry as hash-bonus credit beside this block's `shareBatch`. The parent coinbase `shareCommitRoot` seals that carry. A child that drops the pay, or a parent root that does not match the carry, is `share_commit`. This block's `shareCommits` that are not already in `shareBatch` are PoW-checked with `verifyShareBatch` on the parent header, with the same trust and skip flags as the batch. A buried `skipFlow` skips that extra PoW and still runs `shareCommitOfBlock`. Consensus cannot see a share the pool never published. The pool still chooses the published commit set. Default templates do not stamp lag-1 shares as `shareCommits`. Callers pass `shareCommits`. An honest `buildTemplate` puts a missing mandatory share back before `bindShareProofSlots`, and throws `share_commit` when the set is still omitted or the parent root disagrees.

`freshForBlock` is unchanged when `shareCommitPay` is absent. When the pay list is present, recorded `hashCredits` must equal the merge of share-batch credits and the pay rows, and the share witness is against the share-batch credits only. The 017 owed-ledger walk is not changed.

The fingerprint token is `SHARE_COMMIT=timely-omit-v1`, immediately after `HASH_ACCEPTED_UNITS=validated`. An absent root does not change a coinbase digest. A present root is bound with the `sharecommit1` prefix.

Trailers are `hscm1` (carry), `hscn1` (commit list), and `hscp1` (pay credits). A share row is 72 bytes: `noteCommit`, nonce, bits, `commitMs`, dest20. Pay credits are `hscp1` plus the existing `hcrd1` credit pack.

## Files

| File | What changed |
| --- | --- |
| `crypto/hash_owed.js` | `Timely`, `Prod`, `CapUnits_prod`, `shareCommitAccount`, pack and unpack, `shareCommitOfBlock`, and the pay merge inside `freshForBlock`. |
| `crypto/asert.js` | Fingerprint token `SHARE_COMMIT=timely-omit-v1`. |
| `crypto/asert.test.js` | The existing fingerprint case matches that token. |
| `crypto/spend.js` | `shareCommitRoot` is a coinbase body key, next to `shareSlotRoot`. |
| `crypto/chainbin.js` | Epoch trailers for carry, the commit list, and pay. |
| `node/src/chain.js` | Template inclusion, coinbase root, digest suffix, and the verify gate. |
| `node/src/store.js` | Stamp merged credits, pass `shareCommits` into the template, copy carry onto prev views, and copy the three lists onto a submitted header. |
| `node/src/p2p.js` | Wire the three packed lists. |
| `pool/src/pool.js` | `blockFromTpl` copies the three lists and `hashCredits` when the template has them. The issue path does not auto-publish omitted shares. |
| `node/tests/test_share_commit_018f_v12.js` | The 018f residuals. |

## Tests

`shearhash.node` is missing. Each run logs `shearhash_native ok: false` and continues. That warning is not a failure. The 55-file pool suite and `node/tests/test_hash_bonus_cap.js` were not run. `shearadmit.node` was not built.

| Command | Result |
| --- | --- |
| `node --test node/tests/test_share_commit_018f_v12.js` | tests 8, pass 8, fail 0, duration_ms 198.04499 |
| `node --test --test-name-pattern "bakes HASH_TX_LIVE" crypto/asert.test.js` | tests 1, pass 1, fail 0, duration_ms 196.807335 |

The eight residuals are the Timely window, Prod and CapUnits_prod, invalidate-omit of a timely share, an untimely share that may be left out, next-producer pay of a parent carry with `shareBatch` pay left intact, a block that drops the pay or lies about the parent root, the epoch-trailer round trip, and the fingerprint token.

An empty height-1 `buildTemplate` with a real dest returns no shares, no credits, no commit root, and empty carry, commits, and pay. It does not throw `share_commit`.
