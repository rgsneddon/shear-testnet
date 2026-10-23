# 018e inbox seal

Branch cut from `feat/shear-testnet-v12`. This is not PR 68. PR 68's Timely rule is a parent clock. This seal follows `.cos-inbox/018e-P0-scr-hardened-law.md`.

`crypto/share_commit_018e.js` is the decision. `sealRound` rejects a seal at `h+W_a` that omits any Timely* id attested on the canonical blocks from `h+1` through `h+W_a`. `W_a` is `ATTEST_WINDOW` (2). The set only grows. A free-form `scMempoolRoot` that does not match that set is `liar_root`.

`Prod*` is the distinct producer ids left after equivocation nulls both conflicting commitments. `CapUnits_prod` is `max(FloorPerProd, CapUnits_block / Prod*)`. FloorPerProd is one floor share (`2^SHARE_FLOOR_BITS`). The cap is not taken from a thin pre-seal set. Global retention is the 013/014 pro-rata rule. Overflow is owed. Empty Timely* pays zero hash bonus, and `preferTip` lets a valid rival replace an invalid seal.

A commitment after the window does not redistribute a capped pie. It may take only unused headroom. A fraud opening claws that commitment's provisional escrow and pays the challenger `units * HASH_BONUS_NANOS`. Finalize waits for `OPEN_WINDOW` openings. `feeBps` does not change the bonus or the owed ledger.

`shareBatch` pay is unchanged. `crypto/admit.js` is unchanged. The live fingerprint is unchanged. This pull request is not a merge, and the seal is not on the admit path until Russell signs off.
