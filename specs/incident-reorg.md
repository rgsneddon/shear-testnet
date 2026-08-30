# Incident — reorg / hash attack

Network: `shear-testnet-v2`. Policy, not a second fork-choice. No operator `setTip(height)`.

## Steps

1. **Freeze credits and Join marks.** `credits_frozen` from node policy / `shear-watch`. Pool “confirmed”, Join mark-paid, wallet Continuum spendable stay pending even past 6. Consensus 6-conf floor does not move.
2. **Measure** depth / work / valid vs invalid. Invalid branches are ignored (`verifyBlock` fail). Valid heavier wins (`shouldAdopt`).
3. **No “roll back to height H” binary.** There is no `setTip`. `reorg_halt_depth` (default 0 / off) may refuse to *apply* a deeper reorg and stay on the current public tip; it is not a rewind tool.
4. **Keep mining the valid public branch.** Pool rebuilds the open round from the new parent. Orphaned pot is not paid twice.
5. **If the attacker’s *valid* heavier branch is adopted, that history won.** Accept it or cut new magic. Mixed tips are two coins.
6. **After:** raise policy N, publish heights + orphaned txids (`getreorgs`), rotate hot withdraw keys, check prune (1000) vs attack depth.

## Watcher

`shear-watch` reads validating RPC. It is not a consensus peer and must not be the only full node. Writes `watch.jsonl`. Pushes `credits_frozen` + reason.

Alerts (ops channel, not a user panic banner unless frozen): depth >= 3; depth >= 10 → freeze; side branch leading > 2 block times → freeze; `h_ratio < 0.5`.

Two nodes, one killed: no freeze (that is not a reorg).

## Testnet drill

Planned 8-block private branch before Join opens. Honest nodes reorg iff it is heavier and valid; loser is `valid-fork`; Continuum bounces; pool does not double-pay.

## Second seed

Stand a second validating node **off** `178.105.187.178`. Stratum may stay on DE. `SHEAR_SEEDS` / RPC `addnode`.
