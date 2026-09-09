# Deploy shear-testnet-v2 (worthy-coin book)

Stay on **shear-testnet-v2**. Do not cut **shear-v1**. Do not invent a genesis time. Do not publish “run this now” clients. Mainnet is not scheduled until P0 1–14 on a public testnet book are green.

## Do not touch live Germany withdraw

Never edit withdraw on `178.105.187.178` / `/opt/shear-pool`. Snapshot the working pool tag before any pool-process update. Never combine withdraw edits with the live DE datadir.

## Push

```
git push -u origin fix/proven-hash
```

Remote: `github.com/rgsneddon/shear-testnet.git`. Do not force-push `main`.

## Deploy oracle

Named host **46.224.132.83** (`p2p.shear.digital:30303`). If that host has no Shear process, it is `blocking: unverifiable` until a real deploy. Local `npm test` is not that host’s verdict. Do not SSH the live Germany pool.

After a second real node is up, it must reject:

- unproven hash units
- opening-only spend (`unsigned`)
- wrong-amount Reserve withdraw (`mint_amount`)
- whole pot to the pool dest (`pot_prop`)
- foreign-key pool pull (`not_owner`)

The 1 SHE pot is still `100000000000`.
