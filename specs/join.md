# The Join

Second Vortex dapp. Not a top-level wallet tab. Not The Reserve.

| Rule | Value |
|------|--------|
| Program | `shear-join-v1` |
| Name | The Join |
| Rate | One prior-ledger coin → one SHE (10 prior units → 11 Shear units) |
| Funding | One-shot genesis mint into the Join vault, equal to snapshot spendable |
| Window | 99 days from mainnet genesis timestamp |
| After window | Remaining vault SHE is burned. Later keys are refused. |
| Key | `join1.` migration key. Bearer cheque. One claim per snapshot leaf. |
| Payout | Holder’s Continuum dest (`ssa1`). Never rest-frame `shear1`. |
| Public view | Root, remaining, days left, burned. No prior-ledger addresses, no view keys. |

The live pool (`https://pool.shear.digital`) and explorer (`https://explorer.shear.digital`) are unchanged by this vortice. The Join does not print SHE after genesis. The Reserve remains the only programme that may mint interest.

Snapshot tool lives with the prior ledger. Only the Merkle root is committed on Shear.
