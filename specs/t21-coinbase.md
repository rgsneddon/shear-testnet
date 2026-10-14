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
- the proven share batch: each share's PoW commits to `t21ShareNc(magic, E) = SHA-256("shear-share-bind-v1" ‖ magic ‖ E)` as its note commit. Every A leaf (full units per note commit) is either paid by one coinbase share or deferred by one `t21.defer` row, at the same weight (`share_bind`). Units are the full `2^bits`, never scaled: a batch over `W_HASH_MAX = 2^48` is `hash_units`, and a share may claim up to 47 bits so one share stays below `W_MAX`;
- the share floor (G5): a share proved on header `h` must claim at least `ceil(log2(blockWork(h.bits) / 85))` bits, and never fewer than `SHARE_FLOOR_BITS` (`share_target`);
- the parent coinbase's owed list `t21.owed` (deferred rows, below);
- a buried pruned block has no batch to prove. Its published A leaves must rebuild the header's continuity root with the block's B leaves (`continuity`), and they are the share units. No path skips the share binding;
- the hash budget `B_h = hashBudgetNanos(accepted series)`, and `u·W ≤ B_h` (`hash_budget`);
- the parent coinbase's `E` set, so a share label is not reused across the carry window;
- the parent vault's pending pinned withdraws (`t21PendingVaults`), which fix the 0x23 rows exactly.

It then requires `paid = S + c_in − c_out + u·W + Φ` and checks that `Φ` equals the levy's finder half and that the finder row's `B*` is the block miner's admit base.

cb-v3 pays the hash bonus in the block as `u·W`, with `W < W_MAX = 2^48` and `u·W ≤ B_h`, where `W` sums every paid share, owed rows included. Nothing is scaled pro rata and there is no noteCommit round-robin (ME G6): those stay on the legacy path only. It does not settle the legacy hash-owed ledger, so the parent must leave an empty ledger and the coinbase carries none.

Once `V12_GENESIS_BLOCK_HASH` is set, cb-v3 is the only coinbase form (`CB_ONLY`). The legacy coinbase, and its last-payee re-split, is then refused with `cb_form`.

## Share floor

Russell's ruling (2026-10-14): the floor targets 85 shares per block on every network, keyed to the block target. The floor is in whole difficulty bits, so the expected count is `blockWork / 2^floor`, which lands in `(42.5, 85]`: between about 43 and 85 floor shares per block, not exactly 85. The target is the bits of the header the share proves on, which the miner knows while mining and which a one-block carry does not change. `T21_SHARES_PER_BLOCK = 85` is a parameter and a fingerprint token.

## Deferred rows and carry

A proven label is paid in full or not paid in this block; it is never cut. At 85 shares per block the payee cap (171) binds in about 13% of blocks (ME), so labels must wait without losing their hash bonus:

- **Deferred rows.** A label in the batch that this block does not pay (payee cap, `u·W ≤ B_h`, `W < W_MAX`, or a voucher the builder cannot use) is published as `t21.defer: {w, E}`, bound to its A leaf. Each cb-v3 coinbase restates the whole owed list `t21.owed: [{E, w, since}]`. Consensus requires `owed = (parent owed − rows paid here − rows older than T21_OWED_TTL)`, oldest first, followed by this block's defer rows at `since = height` (`owed_list`), and at most `T21_OWED_MAX` rows (`owed_cap`). A later block pays a row with a coinbase share of the same `E` and `w` (`share_bind` otherwise), and `u·w` is minted then. An owed `E` cannot be deferred again or reused by a new A leaf (`share_label`), and a row past the TTL cannot be paid (`owed_ttl`). State is the parent coinbase only, so reorg and load need nothing else. Shares plus defer rows count against `CB_SHARE_MAX`.
- **Who pays.** Only the pool that issued a label knows its `β`, so only that pool can pay its owed rows. Its template pays its own rows first, oldest first, then the labels in the batch. Other producers must restate those rows, but consensus cannot make them pay. ME measured that at 85 shares a deferred row waits at most two of the issuing pool's blocks.
- **One-block carry.** A share's PoW binds the parent header (proof slot 0) or the header before it (slot 1), so a share the batch cannot hold (raw count past `CB_SHARE_MAX`, units past `W_HASH_MAX`, or the owed list full) can wait one block. The node keeps a carry book keyed by block hash: the carry for tip `T` is the shares offered on `T`'s parent that `T` did not pay, recomputed after a reorg and reloaded from `t21-carry.json` after a restart. The next template puts that carry first.
- **What cannot carry.** A slot-1 share that the next block also leaves out has expired. So has a share mined on an orphaned header, and a share on a label that is already paid or owed (the pool must issue one label per job header). The node counts expired carry and logs `t21_share_expired`. Holding work longer than that is escrow, which is not built. `T21_OWED_TTL = 960` and `T21_OWED_MAX = 1,024` are final (Russell, 2026-10-14) and are in the params fingerprint.
- **Empty batch.** A template that holds payable shares never publishes an empty batch: it throws `t21_empty_batch`. When every held label is individually unpayable (no payee slot, or `u·w > B_h`), the batch is empty and the template flags `empty_batch_held`. The carry book counts such tips and logs `t21_empty_batch_held`. An empty coinbase cannot defer, because it has no A leaves.

## Pot carry

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

A voucher that fails `voucherKeysOk` is deferred before proving. A payout row that is not an FS-1 leaf after eight blinds throws `admit_note_point`. That payee and its shares are deferred, not deleted, and the template rebuilds. In the node template those labels become defer rows.

There is one payee cap, `payeeCapLive()` in `block_budget.js`, and both `blockBudget` and the cb-v3 verifier apply it. It counts pot rows, dummies included, and not the fee, reserve-fee, or 0x23 rows. On today's 8 MiB hex frame it is 171 (the byte fallback with the 17,400-byte row estimate). The 470 normal cap applies only once frames reach `FRAME_MIN`. Payee slots are filled by units, largest first, with the finder's slot held first (MF-3), so many small vouchers cannot take them from the hashers. Payees past the cap are deferred.

`buildTemplate({ t21 })` builds the node's cb-v3 coinbase. The pool supplies `labelOf` (note commit to `{voucher, E, ℓ, β}`), the finder voucher and the fee voucher. A label is `E = λG + βH` from the payee's public voucher, and the job's note commit is `t21ShareNc(magic, E)`. A share is mined against that note commit and carries no dest. Only labelled shares at or above the floor stay in the batch. The A leaves are the structural share verdict's, the same leaves consensus recomputes. `planT21Round` admits labels to the batch whole (carry first, then payees by units), pays owed rows and then batch labels, and defers the rest in-block. Rounding is not ordered by the template: the law floors every row and carries `Σρ_i/W` in `c_out`, so there is no remainder to hand out largest-first. A round with no shares has no payout row to hide the finder half in, so it pays it as one opened `finder-fee` note to the block miner's dest (Russell, 2026-10-14; token `T21_EMPTY_FEE`). Consensus allows that row only when `t21.shares` is empty (`levy_split` otherwise), requires exactly one, worth the levy's finder half, paying the block miner (`finder_row`), and requires `Φ = 0`. The block shows who found it and the fee; rounds with shares are unchanged. A template with no miner dest still leaves fee-paying transactions for a round with shares. The parent vault's pending withdraws become the 0x23 rows. The template prices the coinbase at the cb-v3 weights.

## Stratum labels

With `SHEAR_POOL_T21_LABELS=1` the pool holds a label book (`pool/src/t21_labels.js`, kept in `t21-labels.jsonl`). A miner logs in with its public voucher `{B, Y, λ}`; a voucher that fails `voucherKeysOk` is refused with `voucher_key`. Each job header sent to that connection gets its own label, and the wire job carries `shareBind: "note"` with the label's `noteCommit`, `labelE` and `labelBeta`. A connection keeps the labels of its last 64 headers. ShearK (with `--voucher`) mines such a job only when `E = λG + βH` for its own `λ` and `noteCommit = t21ShareNc(magic, E)` (`--magic`, default `shear-testnet-v12`), then binds every share to `destBoundShareHash(rx, noteCommit)`. It ignores a `note` job without a 32-byte note commit, without `--voucher`, or whose label does not open to its voucher. The pool judges the share against the note commit it issued for that header, so a share bound to the dest is refused. The share record keeps the note commit, nonce, hash and bits, and no dest. Without a voucher, or with the flag off, jobs stay `shareBind: "dest"`. With `SHEAR_POOL_T21_FINDER_VOUCHER` (and `SHEAR_POOL_T21_FEE_VOUCHER` and `SHEAR_POOL_T21_FEE_BPS` for a fee), every template past genesis is cb-v3: the pool passes its label book and vouchers to `buildTemplate({ t21 })`. The pool is the finder of record: the block miner is the payout's spend hash with the finder voucher's `B` as admit base, and the pool submits cb-v3 blocks under that miner rather than the hasher's. A cb-v3 header is not re-aimed per finder.

## Native prover

`buildT21Coinbase` proves on `shear-fs1`'s `t21_prove` tool (cargo feature `t21-prove`) when `SHEAR_T21_PROVE_SHA256` pins the binary at `SHEAR_T21_PROVE_BIN` (default: the crate's release path), and on the JS prover otherwise. A binary that does not match the pin is not run. Every secret comes from the round seed, so the tool is stateless and its replies are byte-identical to the JS prover (`crypto/vectors/t21_prove_rows.txt`, checked by `cargo test --test t21_vectors`). A refusal by the tool (`admit_note_point`, `split_tally`) is the same refusal as in JS. A missing or broken tool falls back to JS unless `prover: 'native'` is set. Verify stays in JS.

The pot split of the legacy coinbase, the pool, and `coinbase_notes.js` takes `floor(rest · count / total)` in bigint, since `rest · count` passes 2^53 once units are `2^bits`.

The supply step accounts a cb-v3 block without opening a note. The payout rows' commitments must sum to `(S + c_in − c_out + u·W + Φ)·G + excess·H`. `Φ` is the public `fin`; with the opened `finder-fee` note of an empty round it must sum to the levy's finder half. That note is levy, not mint. `W` joins the accepted hash series, and the owed ledger must be empty. 0x23 rows are not counted again: the withdraw that queued them already counted its interest.

## Residuals

- **Solo payout.** A solo block has one real payee and three zero dummies. The producer is also the finder, so that block shows the solo amount. `K_MIN=4` does not hide a one-person round.
- **Totals.** Subsidy, carry in, carry out, fee, and hash bonus stay public so the mint can be checked.
- **Row count.** The number of payout notes is public. Dummies make it an upper bound, not a list of miners.
- **Harvest now, decrypt later.** The chunked ElGamal wrap and the `amtCt` ECDH are both discrete-log. A later break of that problem decrypts notes saved today. That is the same class as a normal hidden transfer.

## Weight

A cb-v3 coinbase weighs `300 + 60` per row (0x23 rows stay 1) `+ 3` per share, from measured JS verify (about 31–40 ms per row, 1.05 ms per share, 150 ms fixed on the build box; 1 wu ≈ 1 ms). A full payout of 171 pot rows plus the fee and reserve-fee rows is 10,680 wu. The shares that still fit beside both reserves set `CB_SHARE_MAX = (36,000 − 10,680 − 2,336 − 528) / 3 = 7,485`. Consensus refuses more coinbase shares, or more batch shares in a cb-v3 block, with `share_cap`. The template defers the excess to the next round. The legacy coinbase keeps 35 wu per row.

A send's verify weight is `25 + 25n` weight units for `1 ≤ n ≤ 8`. A 9-input send has no weight and the block budget refuses it. The 16-send reserve is 2,336. The vault-withdraw reserve stays 528.

## Not in this cut

`V12_GENESIS_BLOCK_HASH` stays empty. Share labelling is genesis gate item 12. The node template builds cb-v3 when given a label source. Share labelling (gate item 12) is closed: the stratum, ShearK, the share records and the pool template are labelled behind `SHEAR_POOL_T21_LABELS=1` and `SHEAR_POOL_T21_FINDER_VOUCHER`. Dart wallet recovery and the reference-box full-cap timing are open. The dalek R1CS encoding of the LogUp relation is the mainnet review item; this verifier checks that same identity with inverse product Schnorrs.
