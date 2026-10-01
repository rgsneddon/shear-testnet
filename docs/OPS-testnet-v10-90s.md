# shear-testnet-v10 — 90s tempo, no silent floor freeze

Live book magic is `shear-testnet-v10`. A v8 or v9 datadir does not load. There is no soft-merge. Quarantine v8/v9-wrong packs and git head `6054186` (`6054186b9b5689656b2fa1000e01b08ee67a01f5`). Advertised gitHead is this tree's `git rev-parse HEAD`. `SHEAR_GIT_HEAD` does not label the book. `SHEAR_BITS` is not consensus next-work.

## Tempo

Difficulty is network-wide. Block bits come from the sealed chain every node already has. Pool hashrate, shareBits, and `SHEAR_BITS` are not that target.

Hashrate fluctuates. It is not constant and it is not linear. Do not bake a hashrate, `log2(H·90)`, or 288 blocks into law or into a Ready flag.

- Step: `median11(log2(T/seen))*(T/tau)` on sealed header gaps only. `T=90000`.
- `τ=32T` (`ASERT_TAU_MS=2880000`). That choice is the fingerprint. The pool cannot edit τ mid-chain.
- `GENESIS_BITS=15` is a day-0 seed only. After genesis, bits follow real sealed gaps toward ~90s.
- Testnet lid is ±1 (`ASERT_HARDEN=1`, `ASERT_EASE=1`). Mainnet harden stays 6 and mainnet ease stays 1.
- Floor policy `ASERT_FLOOR=above-min-until-8tau`: a gap under 8τ cannot pack onto `LIVE_MIN_BITS`. An 8τ stall may sit on the floor.
- Template voids caller bits. Verify requires exact median11 next-work. `bitsForBlock` is not that path.
- Share vardiff (`shareBits`) is not a retarget. Consensus `blockBits` is the header next-work.
- The pool card "Average block time (sealed, all blocks)" is genesis→tip `networkAvgBlockTimeMs`. The explorer card "Avg block time" (`#ex-avg-block`) is that same sealed mean. The find-time EWMA is not a Ready lead. 288 is not a Ready bar.
- invent-must-not-return stands. This cut does not relax it.

## Seal path

If height is flat for more than about 15 minutes, or bits are at `liveMinBits` while finds are stalled, and hashrate, miners, or shares are above zero: page `tip_stall_restamp` and reissue the job from the sealed tip. That path does not restart the pool or the node.

Manual bounce of a pool or node process is a human last resort only. It is not the freeze fix. Do not auto-bounce.

## Operator empty-cut order

Do this by hand on the fleet. This note is not a wipe command.

1. Land the v10 law, magic, and fail-closed datadir check on every host before any process opens a book.
2. Stop v9 miners. Do not point them at the new book.
3. Start Shear Sentinel v15 on an empty `testnet-v10` datadir. Do not open a v9 or v8 chaindir.
4. Start the pool on that empty book.
5. Point ShearK-Miner 2.6 at the new pool. The miner pin stays 2.6.
6. Continuum 0.65: reset the shewall onto `shear-testnet-v10`. A v9 shewall does not join this book.

Product versions are not part of `consensusFingerprint()`.
