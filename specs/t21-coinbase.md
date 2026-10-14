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
- the parent vault's pending pinned withdraws (`t21PendingVaults`), which fix the 0x23 rows exactly.

It then requires `paid = S + c_in − c_out + u·W + Φ` and checks that `Φ` equals the levy's finder half and that the finder row's `B*` is the block miner's admit base.

cb-v3 pays the hash bonus in the block as `u·W`, capped by `W ≤ 2^28` and `u·W ≤ B_h`. Shares past the cap are scaled, not escrowed. It does not settle the legacy hash-owed ledger, so the parent must leave an empty ledger and the coinbase carries none.

Once `V12_GENESIS_BLOCK_HASH` is set, cb-v3 is the only coinbase form (`CB_ONLY`). The legacy coinbase, and its last-payee re-split, is then refused with `cb_form`.

## Carry

The whole pot is carried only when the share batch is empty and the coinbase has no payout note. A non-empty batch carries only the law remainder `(Σ ρ_i) / W`, which is below the payout row count.

Each row proves `0 ≤ ρ < W` with a two-sided range: `ρ` and `W − 1 − ρ` are each three 16-bit limbs inside the row's range proof, and the limb commitments sum to `(W − 1)·G`.

## Fee

The pool fee is a hidden note to the pool's voucher. Its law row has `W_i = 0` and opens to the public `f = floor(S·bps/10⁴)`. There is exactly one fee row when `f > 0`.

## Vault rows

A 0x23 row pays the owner's key `B`, with `P = B + δ·G`, and must be an FS-1 leaf. The amount is public portal state.

Its blind is `r = H_s("shear-kt10-0x23-r-v1" ‖ mintId ‖ u64le(height) ‖ parentId ‖ u8 ctr)`, with `ctr` the first value from 0 that gives a non-zero `r`. `parentId = SHA-256("shear-t21-parent-v1" ‖ parent header)` is the same parent id the payout key `δ` uses. This deviates from design 087q T6, which names this block's own hash `blockHash_h`. That hash covers the coinbase, and the coinbase contains `C = v·G + r·H`, so `r` cannot depend on it. The parent id is fixed before the block is built and still makes `r` unique per (mintId, height, branch).

A withdraw opts into this by carrying one pinned receipt `{kind: withdraw, kindCode: 0x23, nanos, B}` with no commitment. Its `nanos` must equal the vault's payout (principal plus interest) and, when the portal names a payout address, `B` must be that address's admit base. The body then balances with `W = 0`: the spent note opens to the fee plus hidden change. Applying the block appends `{mintId, vaultNanos, B}` to the vault's pending list, and the reserve digest covers `B`.

The next coinbases pay that list. The rows follow the pot, fee and reserve-fee rows. Consensus walks the oldest `K_VW = 8` entries in order: an entry whose row at the next index is an FS-1 leaf must be paid there, and an entry whose row is not a leaf is skipped and stays queued. A non-leaf row needs `P` or `Hp(P)` to be the identity, so the skip only stops a fixed blind from stalling the chain. Any other set, order or field is `vault_pin`. Applying the block removes the paid entries as an ordered subsequence of that window.

## Template

A voucher that fails `voucherKeysOk` is deferred before proving. A payout row that is not an FS-1 leaf after eight blinds throws `admit_note_point`. That payee and its shares are deferred to the next round, not deleted, and the template rebuilds once.

There is one payee cap, `payeeCapLive()` in `block_budget.js`, and both `blockBudget` and the cb-v3 verifier apply it. It counts pot rows, dummies included, and not the fee, reserve-fee, or 0x23 rows. On today's 8 MiB hex frame it is 171 (the byte fallback with the 17,400-byte row estimate). The 470 normal cap applies only once frames reach `FRAME_MIN`. Payees past the cap are deferred.

`buildTemplate({ t21 })` builds the node's cb-v3 coinbase. The pool supplies `labelOf` (note commit to `{voucher, E, ℓ, β}`), the finder voucher and the fee voucher. A label is `E = λG + βH` from the payee's public voucher, and the job's note commit is `t21ShareNc(magic, E)`. A share is mined against that note commit and carries no dest. Only labelled shares stay in the batch. The A leaves are the structural share verdict's, the same leaves consensus recomputes. Shares past `min(CB_SHARE_MAX, shareMax)`, past `u·W ≤ B_h`, or of a deferred payee leave the batch for the next round, so coinbase shares and A leaves stay one to one. An empty batch cannot carry the finder half, so fee-paying transactions wait for a round with shares. The parent vault's pending withdraws become the 0x23 rows. The template prices the coinbase at the cb-v3 weights.

The supply step accounts a cb-v3 block without opening a note. The payout rows' commitments must sum to `(S + c_in − c_out + u·W + Φ)·G + excess·H`. `Φ` is the public `fin` and must be the levy's finder half. `W` joins the accepted hash series, and the owed ledger must be empty. 0x23 rows are not counted again: the withdraw that queued them already counted its interest.

## Residuals

- **Solo payout.** A solo block has one real payee and three zero dummies. The producer is also the finder, so that block shows the solo amount. `K_MIN=4` does not hide a one-person round.
- **Totals.** Subsidy, carry in, carry out, fee, and hash bonus stay public so the mint can be checked.
- **Row count.** The number of payout notes is public. Dummies make it an upper bound, not a list of miners.
- **Harvest now, decrypt later.** The chunked ElGamal wrap and the `amtCt` ECDH are both discrete-log. A later break of that problem decrypts notes saved today. That is the same class as a normal hidden transfer.

## Weight

A cb-v3 coinbase weighs `300 + 60` per row (0x23 rows stay 1) `+ 3` per share, from measured JS verify (about 31–40 ms per row, 1.05 ms per share, 150 ms fixed on the build box; 1 wu ≈ 1 ms). A full payout of 171 pot rows plus the fee and reserve-fee rows is 10,680 wu. The shares that still fit beside both reserves set `CB_SHARE_MAX = (36,000 − 10,680 − 2,336 − 528) / 3 = 7,485`. Consensus refuses more coinbase shares, or more batch shares in a cb-v3 block, with `share_cap`. The template defers the excess to the next round. The legacy coinbase keeps 35 wu per row.

A send's verify weight is `25 + 25n` weight units for `1 ≤ n ≤ 8`. A 9-input send has no weight and the block budget refuses it. The 16-send reserve is 2,336. The vault-withdraw reserve stays 528.

## Not in this cut

`V12_GENESIS_BLOCK_HASH` stays empty. The node template builds cb-v3 when given a label source, but the pool does not issue labels to sessions yet: the stratum job still binds shares to the miner's dest, and ShearK does not take a job note commit. Dart wallet recovery, the reference-box full-cap timing, and a faster prover are open. The dalek R1CS encoding of the LogUp relation is the mainnet review item; this verifier checks that same identity with inverse product Schnorrs.
