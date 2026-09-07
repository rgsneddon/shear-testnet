# Unpublished pool copy — identifiers only

Snapshot of known-good pool: `rgsneddon/shear-pool` tag **`snapshot/mainnet-prep-20260907`** commit **`e018d6d93d049b3f63ce825f532e3f11308676d7`**.

Do **not** deploy. Do **not** open 1111 on 46.224.132.83. Do **not** edit withdraw.

At cutover, copy that snapshot and set:

```
SHEAR_NETWORK=mainnet
magic: shear-v1
```

Keep header-template jobs, 1% pot fee, hash bonuses full to hasher, levy-from-pool-dest, first-try withdraw.
