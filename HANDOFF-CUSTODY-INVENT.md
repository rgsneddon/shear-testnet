# HANDOFF — invent after PR #37

PR #37 stopped eight ways of copying pot-after-fee onto the custody hasher, then gated the remaining custodial path on `block.poolDest`. That field is not on `chain.bin`, `compactChainBlock`, or the P2P wire. After a restart, reindex, or IPC apply, custody detection was false.

With custody off, reconstruct still ran solo pot prop. The amount-only arm of `matchSealedCoinbaseVout` (same kind, verify the nanos, ignore noteCommit) then assigned the sealed pool pot — 0.99 SHE — to the sole hasher, because that hasher’s prop share was the whole pot-after-fee. Explorer rows kept the real `toDest20` (the pool) but set `to` to the hasher. `/api/wallet/balance` sums `to`. Each mature block added another 0.99. Notes stayed `kind:hash` and ~1e-4 SHE, because the pot noteCommit is the pool’s. Extra minted stayed 0. Same class as the old 8 × 0.99, now N × 0.99 as blocks accrued (live: 12, then 16, on hasher `ssa1q4ws2yd6…gmp5`).

What #37 missed (the flicker):

#37 made the vout walk fail-closed and deleted the `notes > nanos` override, then ran that walk only when `matureSpendableNanos` was ≤ 0. It still treated a block as solo whenever `sealedPotIsCustody` missed, which is every block whose `poolDest` was not stored. `expectedCoinbasePays` (shares still had dests) and `paysFromALeaves` (shares unbound) then PROP pot-after-fee onto hasher leaves. The amount-only match wrote `to` = hasher and nanos = 0.99. That made mature spendable positive — hash dust or one 0.99 — so the honest walk never ran again, and nothing could pull the sum back down.

That is the flicker on b35c5f4. When the painted `to` matched the queried ssa1, `/api/wallet/balance` was N × 0.99. When `to` was empty, mature spendable was ≤ 0, the walk ran, and the same wallet showed hash dust. Seal and stratum never paid the pot to the hasher. The notes stayed `kind:hash`.

Also still open after the eight removals: `historyFor` spent a row on `to` / `toDest20` even when the sealed noteCommit was the pool, including a missing or overwritten `toDest20`. `Math.max(explorer, notes)` in spendable did the same. Chain.bin boot itself was already Σ hash notes.

This fix:

- Reads the pool dest from the sealed pot note when `poolDest` is missing. A pot whose noteCommit is a hasher leaf stays solo.
- Drops the amount-only match. A pay has to bind the vout noteCommit.
- `historyFor` does not spend a coinbase or hash row to an address whose sealed noteCommit is someone else. A painted `to`, a missing `toDest20`, or a `toDest20` overwritten to the hasher all lose to the note. The pool still receives that pot.
- A pot note that is not a hasher leaf is custody even with dest20 stripped, so `paysFromALeaves` cannot PROP pot-after-fee onto hasher leaves.
- Once any sealed coinbase note exists, it replaces explorer coinbase credit. `matureSpendableNanos > 0` no longer skips that. A zero note scan still keeps unsealed history. `destSpendableNanos` uses the same rule, not `Math.max`.

Solo pot prop when the seal’s noteCommit is the miner is unchanged. HASH_BONUS, pot schedule, ASERT, and book-law fingerprint are unchanged.

After deploy, one pool bounce rebuilds spendable from this code. Already-indexed rows with a painted `to` stop adding N × 0.99 for the hasher without a chain rewrite, because the sealed hash notes replace that coinbase credit.
