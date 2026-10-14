# T21 hidden coinbase payouts

`AMOUNT=confidential` means every output amount is hidden except reserve-program rows (lock, vote, withdraw, and 0x23 vault). Those rows are public by design.

A cb-v3 coinbase hides each payout. The block still shows the subsidy, the carry, the hash bonus, the fee, the share count, and which row is the finder's. It does not show a miner's payout once there are at least four notes.

## Residuals

- **Solo payout.** A solo block has one real payee and three zero dummies. The producer is also the finder, so that block shows the solo amount. `K_MIN=4` does not hide a one-person round.
- **Totals.** Subsidy, carry in, carry out, fee, and hash bonus stay public so the mint can be checked.
- **Row count.** The number of payout notes is public. Dummies make it an upper bound, not a list of miners.
- **Harvest now, decrypt later.** The chunked ElGamal wrap and the `amtCt` ECDH are both discrete-log. A later break of that problem decrypts notes saved today. That is the same class as a normal hidden transfer.

## Carry

The whole pot is carried only when the share batch is empty and the coinbase has no payout note. A non-empty batch carries only the law remainder `(sum ρ_i) / W`. The last-payee remainder used by `potPaysFromLeaves` is not the T21 split.

Each row proves `0 ≤ ρ < W` with a two-sided range: `ρ` and `W − 1 − ρ` are both opened as `k`-bit values, where `k` is the bit length of `W − 1` (at most 48), and those openings sum to `W − 1`.

A payout row that is not an FS-1 leaf is thrown out of the template. Its voucher and shares are deferred to the next round. They are not deleted. The template rebuilds once.

## Weight

A send's verify weight is `25 + 25n` weight units. The 16-send reserve is 2,336. The vault-withdraw reserve stays 528.

## Not in this cut

`V12_GENESIS_BLOCK_HASH` stays empty. Legacy coinbases are still accepted until the cut sets cb-v3 as the only form. Dart wallet recovery and the reference-box full-cap timing are open. The dalek R1CS encoding of the LogUp relation is the mainnet review item; this verifier checks that same identity with inverse product Schnorrs.
