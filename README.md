# Shear

Private by default. Proof of work only. Continuity-settled.

- Ticker: **SHE**
- Algo: **ShearHash** (CPU)
- Miner pin: **ShearK-Miner 1.2** (`[Testnet] ShearK`, ShearHash-v2). Wallet **0.7**. Node / pool **0.3** (EVM Reserve).
- Stratum: `pool.shear.digital:1111`
- Site: https://shear.digital
- Pool: https://pool.shear.digital
- Chain: `shear-testnet-v2` (testnet first)

One hash is one transaction. The header commits a continuity root. Full nodes
validate every block. The public pool is an equal node with a stratum, not a
master book.

## Packages

| Path | What |
|------|------|
| `specs/` | Header, validation, pool jobs, emissions |
| `crypto/` | ShearHash, header codec, Merkle, addresses |
| `node/` | Validating daemon, P2P `:30303`, RPC |
| `sheark-miner/` | Official C miner (ShearK-Miner) |
| `pool/` | Stratum `:1111` + light dashboard |
| `site/` | shear.digital |

## Mine (testnet)

```
ShearK-Miner --pool pool.shear.digital:1111 --user she1YOURID.worker --threads 4
```
Offer `she1` (silent ID). Miner login is `she1` or a revolving `ssa1` dest. Payouts are `ssa1` on chain — `she1` never appears there. Rest-frame `shear1` is never a login.

Wallet tabs: Continuum, Flow, Resistance, Vortex, Shear, Reserve, Closure.
Backup: encrypted `shewall.json`. Node and wallet are lean: hash samples collate per miner and prune after 1000 confirmations; sealed transfers stay forever for the explorer.
