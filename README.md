# Shear

Private by default. Proof of work only. Continuity-settled.

- Ticker: **SHE**
- Algo: **ShearHash** (CPU)
- Miner pin: **Shear-Miner 1.0** (`[testnet]`). Wallet / node / pool pin: **0.1**. Declared **4%** dual-login miner fee at `she1qlrll…fee`.
- Stratum: `pool.shear.digital:1111`
- Site: https://shear.digital
- Pool: https://pool.shear.digital
- Chain: `shear-testnet-v1` (testnet first)

One hash is one transaction. The header commits a continuity root. Full nodes
validate every block. The public pool is an equal node with a stratum, not a
master book.

## Packages

| Path | What |
|------|------|
| `specs/` | Header, validation, pool jobs, emissions |
| `crypto/` | ShearHash, header codec, Merkle, addresses |
| `node/` | Validating daemon, P2P `:30303`, RPC |
| `miner/` | Official C miner |
| `pool/` | Stratum `:1111` + light dashboard |
| `site/` | shear.digital |

## Mine (testnet)

```
Shear-Miner --pool pool.shear.digital:1111 --user she1YOURID.worker --threads 4
```
Offer `she1` (silent ID). Miner login is `she1` or a revolving `ssa1` dest. Payouts are `ssa1` on chain — `she1` never appears there. Rest-frame `shear1` is never a login.

Wallet tabs: Continuum, Flow, Resistance, Vortex, Shear, Reserve, Closure.
Backup: encrypted `shewall.json`. Node and wallet are lean: hash samples collate per miner and prune after 1000 confirmations; sealed transfers stay forever for the explorer.
