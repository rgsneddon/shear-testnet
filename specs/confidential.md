# Confidential amounts (shear-testnet-v3)

Fingerprint: `AMOUNT=confidential`. Do not land this on live v2.

## Notes
Each money output is a Pedersen commitment `C = v·G + r·H` plus a Bulletproofs+ range proof that `v` is in `[0, 2^64)`. Balance conservation is proven, not painted. Public `vout.nanos` is not a sealed field.

## Values that stay 1
- Hash-bonus unit = 1 nanos per proven floor unit (`HASH_BONUS_NANOS=1`).
- Block pot = `BLOCK_SUBSIDY_NANOS` (1 SHE) PROP of proven hasher notes; pool note gets 100 bps of the pot only.
- Reserve mint_amount: principal + `floor(staked * committedBps / 10000)`.

## Coinbase split
Lag-1 coinbase emits confidential notes whose committed values sum to (hash-bonus units + PROP pot − pool fee) for those `note_commit`s. Finder-only is illegal.

## Dummy outs
Every user Flow spend creates at least one dummy note. Change is a fresh note. Reserve lock/vote/withdraw keep typed kinds; the vault note is not dummy-deleted.

## Range proofs
Bulletproofs+ (transparent). No trusted setup.

## Explorer
Amounts hidden. Memo is a boolean. Reserve/Vortex rows still list kind + height.
