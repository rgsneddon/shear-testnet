# Shear

Private by default. Proof of work only. Continuity-settled.

- Ticker: **SHE**
- Algo: **ShearHash** (CPU)
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
shear-miner --pool pool.shear.digital:1111 --user shear1YOURADDRESS.worker --threads 4
```

Wallet tabs: Continuum, Flow, Resistance, Vortex, Shear, Reserve, Closure.
Backup: encrypted `shewall.json`. Node and wallet are lean: hash samples collate per miner and prune after 100 confirmations; sealed transfers stay forever for the explorer.
