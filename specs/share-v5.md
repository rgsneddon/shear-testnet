# ENC_SHARE v5 (shear-testnet-v3)

Fingerprint: `ENC_SHARE=v5`. Share codec is the body, not the PoW preimage. Job header stays the frozen 128-byte ShearHash-v3 template.

```
ENC_SHARE_V5 = note_commit || nonce_u64le || lz_u8 || view_tag?
```

- `note_commit` binds the hasher’s one-time receive note for this share batch. Not `she1`. Not destCommit(spendPub). Not a dashboard `m……` tag. Not the Reserve vault unless the user chose to mine to the vault.
- Sort key is `(note_commit, nonce)`. Duplicate nonce = `dup_share`.
- Tree-A key is `note_commit + u64count`. Count law: `units = 2^SHARE_FLOOR_BITS` per floor share; each proven unit mints 1 hash-bonus nanos.
- Max shares per block: `MAX_SHARES_PER_BLOCK = 8192`.
- Miner still submits header + digest + nonce. Wallet/node maps accepted shares onto the worker’s current `note_commit`.
- Lag-1: block N mints for proven floor shares of the parent open-round job.
