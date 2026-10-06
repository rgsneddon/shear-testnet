# ENC_SHARE v5 (shear-testnet-v3)

Fingerprint: `ENC_SHARE=v5+work7`. `SHARE_UNITS=2^bits`. `SHARE_CREDIT=nonce-hi-le`. The work frame carries credited bits, and those bits must equal the little-endian high byte of the nonce inside the ShearHash preimage. A v5 body with no bit field is the floor unit only when that byte is the floor. Job header stays the frozen 128-byte ShearHash-v3 template. A cache hit binds noteCommit and that byte. A full `2^b` credit that this block does not pay is an owed `noteCommit` row (`HASH_OWED`), paid once by any later producer.

```
ENC_SHARE_V5 = note_commit || nonce_u64le || lz_u8 || view_tag?
```

- `note_commit` binds the hasher’s one-time receive note for this share batch. Not `she1`. Not destCommit(spendPub). Not a dashboard `m……` tag. Not the Reserve vault unless the user chose to mine to the vault.
- Sort key is `(note_commit, nonce)`. Duplicate nonce = `dup_share`.
- Tree-A key is `note_commit + u64count` (32-byte commit, not dest20). `note_commit = SHA256("shear-note-commit-v1" || dest20)` of the hasher’s one-time dest, or an explicit 32-byte field on the share. Count law: `units = 2^SHARE_FLOOR_BITS` per floor share; each proven unit mints 1 hash-bonus nanos.
- Max shares per block: `MAX_SHARES_PER_BLOCK = 65536` on shear-testnet-v11, direct from the closed v10 cap of 8192. The 32768 rung is cancelled. Floor bits stay 8. `MAX_HASH_UNITS_PER_BLOCK` is `2^28` (268435456), not 16777216. `HASH_BONUS_NANOS` stays 1. Wire and disk use packed v5 frames. The default P2P frame is 16 MiB so a full cap block fits.
- Miner still submits header + digest + nonce. Wallet/node maps accepted shares onto the worker’s current `note_commit`.
- Lag-1: block N mints for proven floor shares of the parent open-round job.
