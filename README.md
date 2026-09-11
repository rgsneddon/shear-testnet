# Shear

Private dests, public amounts. PoW elects the tip. Continuity-settled.

- Ticker: **SHE**
- Algo: **ShearHash** (CPU)
- Miner pin: **ShearK-Miner 1.6** (`[Testnet] ShearK`, ShearHash-v3). Wallet **0.30**. Product **0.4**. Official miner: https://github.com/rgsneddon/ShearK/releases/tag/1.6
- Stratum: `pool.shear.digital:1111`
- Site: https://shear.digital
- Pool: https://pool.shear.digital
- Chain: `shear-testnet-v2` (testnet first)

One proven share-hash mints units; user txs are signed Flow. The header commits a
continuity root. Full nodes validate shareBatch until prune-1000; money vouts forever.
The public pool is an equal node with a stratum, not a master book.

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
ShearK-Miner --pool pool.shear.digital:1111 --user ssa1YOURDEST.worker --threads 4
```
Default miner login is `ssa1.worker` (a dest the wallet exported for this worker). `she1` login is an in-memory alias only — it must resolve to an owned rotating dest and is never written to pool disk. Payouts are one-time `ssa1` on chain. Rest-frame `shear1` is never a login. Amounts stay public; dests are stealth. The public pool learns whatever you type into stratum; a solo node is the anonymity path for miners.

Wallet tabs: Continuum, Flow, Resistance, Vortex, Shear, Reserve, Closure.
Backup: encrypted `shewall.bin`. Node and wallet are lean: hash samples collate per miner and prune after 1000 confirmations; sealed transfers stay forever for the explorer.
