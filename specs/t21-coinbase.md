# T21 hidden coinbase payouts

`AMOUNT=confidential` means every output amount is hidden except reserve-program rows (lock, vote, withdraw, and 0x23 vault) and the reserve half of the levy. Those rows are public by design.

A cb-v3 coinbase hides each payout. The block still shows the subsidy, the carry, the hash bonus unit, the fee, the share weights, and which row is the finder's. It does not show a miner's payout once there are at least four notes.

## What a row publishes

Each payout row is a Pedersen note `C = v·G + r·H` to a voucher `(B*, Y, λ)`. It carries the payout key `P = B* + δ·G`, the blind wrap `rEph, rCt`, `amtCt`, the weight commitment `cw`, three 16-bit limb commitments of `ρ` (`rhoK`) and three of `W − 1 − ρ` (`delK`), the public `fin` (0 except the finder row), 20 ElGamal chunks to `Y` with their binding proofs, one aggregate proof (five points and four responses, no limbs), the law Schnorr, and one aggregated range proof (tag 0x02, 864 bytes) over the 20 chunk commitments and the six ρ limbs.

The label is a function of the keys: `λ = H_s("shear-vch-lam-v2" ‖ B* ‖ Y)`. Consensus recomputes it from the row and refuses any other value with `split_label`. Without that binding a pool, which knows every share's opening, could publish the miner's `λ` with its own `B*` and `Y`; the tally would still balance and the payout would open to the pool.

A share is `(w, E)` only. `E = ℓ·G + β·H` hides the share's voucher label. A share's `E` can only open to the miner's `λ`, so the miner checks `E = λ·G + β·H` before mining a pool-issued note commit.

## Chain state

Consensus checks a cb-v3 coinbase against values it derives itself:

- the subsidy `S` at this height and the parent carry `c_in`;
- the live hash bonus unit `u`;
- height, network magic, and the parent id `SHA-256("shear-t21-parent-v1" ‖ parent header)`;
- the proven share batch: each share's PoW commits to `t21ShareNc(magic, E) = SHA-256("shear-share-bind-v1" ‖ magic ‖ E)` as its note commit, and the coinbase shares must match the block's retained units per note commit (its A leaves) one to one. Retained units are `2^bits` scaled into `MAX_HASH_UNITS_PER_BLOCK = 2^28`, so `W ≤ 2^28` (`hash_units`);
- a buried pruned block has no batch to prove. Its published A leaves must rebuild the header's continuity root with the block's B leaves (`continuity`), and they are the share units. No path skips the share binding;
- the hash budget `B_h = hashBudgetNanos(accepted series)`, and `u·W ≤ B_h` (`hash_budget`);
- the parent coinbase's `E` set, so a share label is not reused across the carry window;
- the pending pinned vault withdraws (none are wired yet, so a vault row is refused).

It then requires `paid = S + c_in − c_out + u·W + Φ` and checks that `Φ` equals the levy's finder half and that the finder row's `B*` is the block miner's admit base.

cb-v3 pays the hash bonus in the block as `u·W`, capped by `W ≤ 2^28` and `u·W ≤ B_h`. Shares past the cap are scaled, not escrowed. It does not settle the legacy hash-owed ledger, so the parent must leave an empty ledger and the coinbase carries none.

Once `V12_GENESIS_BLOCK_HASH` is set, cb-v3 is the only coinbase form (`CB_ONLY`). The legacy coinbase, and its last-payee re-split, is then refused with `cb_form`.

## Carry

The whole pot is carried only when the share batch is empty and the coinbase has no payout note. A non-empty batch carries only the law remainder `(Σ ρ_i) / W`, which is below the payout row count.

Each row proves `0 ≤ ρ < W` with a two-sided range: `ρ` and `W − 1 − ρ` are each three 16-bit limbs inside the row's range proof, and the limb commitments sum to `(W − 1)·G`.

## Fee

The pool fee is a hidden note to the pool's voucher. Its law row has `W_i = 0` and opens to the public `f = floor(S·bps/10⁴)`. There is exactly one fee row when `f > 0`.

## Vault rows

A 0x23 row pays the owner's key `B`, with `P = B + δ·G`, and must be an FS-1 leaf. Its blind is `H_s("shear-kt10-0x23-r-v1" ‖ mintId ‖ height ‖ parent id ‖ ctr)`, fixed before the block is built. The amount is public portal state.

## Template

A voucher that fails `voucherKeysOk` is deferred before proving. A payout row that is not an FS-1 leaf after eight blinds throws `admit_note_point`. That payee and its shares are deferred to the next round, not deleted, and the template rebuilds once.

## Residuals

- **Solo payout.** A solo block has one real payee and three zero dummies. The producer is also the finder, so that block shows the solo amount. `K_MIN=4` does not hide a one-person round.
- **Totals.** Subsidy, carry in, carry out, fee, and hash bonus stay public so the mint can be checked.
- **Row count.** The number of payout notes is public. Dummies make it an upper bound, not a list of miners.
- **Harvest now, decrypt later.** The chunked ElGamal wrap and the `amtCt` ECDH are both discrete-log. A later break of that problem decrypts notes saved today. That is the same class as a normal hidden transfer.

## Weight

A send's verify weight is `25 + 25n` weight units for `1 ≤ n ≤ 8`. A 9-input send has no weight and the block budget refuses it. The 16-send reserve is 2,336. The vault-withdraw reserve stays 528.

## Not in this cut

`V12_GENESIS_BLOCK_HASH` stays empty. No node or pool template calls the cb-v3 builder yet, and the ShearK v6 share preimage is not updated. Dart wallet recovery, the reference-box full-cap timing, and a faster prover are open. The dalek R1CS encoding of the LogUp relation is the mainnet review item; this verifier checks that same identity with inverse product Schnorrs.
