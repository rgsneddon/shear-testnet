# Continuum-Tensor-Flow (CTF)

Product name: **Continuum-Tensor-Flow**. Short: **CTF**. Chronoflux: Continuum ∇·J = 0, tensor dest, Flow J^μ.

Not an extra coin. Incoming Continuum payments and mining land on a **round dest**. The user still has a **view key**.

## What the chain shows

Public explorer rows are dest `shear1` addresses and **amounts**. Identities are not on those rows.

A **view key** pasted into the explorer reveals **only that user’s** dest rows (the same public amounts, grouped). A wrong view key reveals nothing.

A published Flow sheet is watchable: anyone who has the sheet can also group that user’s dests. They still only see **amounts** (and dest/height already on the row). They cannot spend. They cannot open anyone else.

## Formula

`t = SHA256(chronoflux-J-v1 || C || continuity_root_{h-1} || height)`  
`destHash20 = SHA256(chronoflux-J-v1 || S || t)[0:20]`  
`dest = shear1(destHash20)`

`S` = rest-frame spend hash (20 bytes).  
`C` = Closure commit = SHA256(chronoflux-G-v1 || viewKey).  
Lag-1: use the previous block’s `continuity_root` (same clock as hash-bonus payout). Height 1 uses the empty continuity root.

Spend: rest-frame key signs; node recomputes dest from `(S, C, continuity_{h-1}, height)` and checks it matches the vout being spent.

## Mining

`--user` is the sheet (or rest-frame `shear1`). Header PoW unchanged. Coinbase `vout.address` is **dest**, not the login. Pool binds dest with lag-1 continuity.

## Vortex / Reserve

Lock, vote, and withdraw use rest-frame `S` only. Dest rotates every block; π lock lasts 400 days.

## Do not

Ephemeral EC points in the tx, notification txs, sender-input key exchange, CTF math inside ShearHash, mainnet before the spend path is proven.

## What to rebuild to enable CTF

| Part | Rebuild / redeploy? | Why |
|------|---------------------|-----|
| **C miner** | **No** | Header is still 120 bytes. `--user shear1…worker` unchanged. PoW does not see dests. |
| **Node** | **Yes** | `buildTemplate` / coinbase pay dest(lag-1), not the login. |
| **Pool** | **Yes** | Jobs come from the node store. Same dest mapping. Redeploy JS with the node. |
| **Wallet** | **For UI, yes** | Mining already works (pool derives dest from login). Rebuild so Continuum/Flow/Closure show dests and the view-key explorer. |
| **Explorer HTML** | **If you want paste-view-key on the site** | API already: `/api/explorer/history?address=&viewKey=`. |
| ShearHash / header | **No** | |

Germany must get the new `node/` + `pool/` tree (`/opt/shear`) for live coinbase dests. Do not restart live book units. Wire personalization stays `chronoflux-J-v1` so dests already computed do not move.
