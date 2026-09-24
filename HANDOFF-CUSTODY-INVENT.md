# HANDOFF — invent after PR #37

PR #37 stopped eight ways of copying pot-after-fee onto the custody hasher, then gated the remaining custodial path on `block.poolDest`. That field is not on `chain.bin`, `compactChainBlock`, or the P2P wire. After a restart, reindex, or IPC apply, custody detection was false.

With custody off, reconstruct still ran solo pot prop. The amount-only arm of `matchSealedCoinbaseVout` (same kind, verify the nanos, ignore noteCommit) then assigned the sealed pool pot — 0.99 SHE — to the sole hasher, because that hasher’s prop share was the whole pot-after-fee. Explorer rows kept the real `toDest20` (the pool) but set `to` to the hasher. `/api/wallet/balance` sums `to`. Each mature block added another 0.99. Notes stayed `kind:hash` and ~1e-4 SHE, because the pot noteCommit is the pool’s. Extra minted stayed 0. Same class as the old 8 × 0.99, now N × 0.99 as blocks accrued (live: 12, then 16, on hasher `ssa1q4ws2yd6…gmp5`).

What #37 did not change:

- Unbound amount match in `matchSealedCoinbaseVout`.
- `historyFor` treating a painted `to` as ownership even when sealed `toDest20` is someone else.
- Custody detection when `poolDest` was never stored.
- A later stored row whose `toDest20` was overwritten to the hasher, or whose `toDest20` is missing, while `noteCommit` is still the pool. `to` / `toDest20` still spent N × 0.99 onto the hasher. Chain.bin boot itself was already Σ hash notes.

This fix:

- Reads the pool dest from the sealed pot note when `poolDest` is missing. A pot whose noteCommit is a hasher leaf stays solo.
- Drops the amount-only match. A pay has to bind the vout noteCommit.
- `historyFor` does not spend a coinbase or hash row to an address whose sealed noteCommit is someone else. A painted `to`, a missing `toDest20`, or a `toDest20` overwritten to the hasher all lose to the note. The pool still receives that pot.
- Note-commit scan can raise a short explorer figure up to Σ sealed notes. It cannot invent N × 0.99.

Solo pot prop when the seal’s noteCommit is the miner is unchanged. HASH_BONUS, pot schedule, ASERT, and book-law fingerprint are unchanged.

After deploy, one pool bounce rebuilds spendable from this code. Already-indexed rows with a painted `to` and a pool `toDest20` stop counting for the hasher without a chain rewrite.
