# Shear

ADMITv2 membership over this book's notes, with confidential amounts. Proof of work elects the tip. Continuity-settled.

Offer a silent ID (`she1`) when someone pays you. Incoming coin lands on a revolving dest (`ssa1`) that the book writes. Rest-frame (`shear1`) stays in Closure. While this book has fewer than 10,000 notes the membership set is thin.

Each found block mints **1 SHE**, split among hasher dests that produced proven work that round. Each of those dests receives its own hash bonus on the next sealed block.

- Ticker: **SHE**
- Algo: **ShearHash-v3** (CPU, RandomX light)
- Miner pin: **ShearK-Miner 1.7** ([Testnet] ShearK). Wallet **0.33**. Product **0.4**. Official miner: https://github.com/rgsneddon/ShearK/releases/tag/1.7
- Stratum: `pool.shear.digital:1111`
- P2P: `p2p.shear.digital:30303` (`shear-testnet-v4`)
- Site: https://shear.digital
- Pool: https://pool.shear.digital
- Chain: `shear-testnet-v4`

One proven floor share mints hash-bonus units onto the dest that hashed. User transfers are signed Flow. The header commits a continuity root. Full nodes validate shareBatch until prune-1000; money vouts remain. The public pool is an equal node with a stratum.

## Packages

| Path | What |
|------|------|
| `specs/` | Header, validation, pool jobs, emissions |
| `crypto/` | ShearHash, header codec, Merkle, addresses |
| `node/` | Validating daemon, P2P `:30303`, RPC |
| `sheark-miner/` | Official C miner (ShearK-Miner) |
| `pool/` | Stratum `:1111` + light dashboard |
| `site/` | shear.digital |

## Mine

Log in with wallet **Copy dest**:

```
ShearK-Miner --pool pool.shear.digital:1111 --user ssa1YOURDEST.worker --threads 4
```

`ssa1.worker` is the dest the wallet exported for this worker. Amounts are confidential; dests are stealth. Reuse links your blocks; rotate dests.

Wallet **0.33** syncs a local node at `127.0.0.1:18332` (headers + compact blocks). It does not use the old height sampler. Public pool HTTP submit is an advanced toggle.

Wallet tabs: Continuum, Flow, Resistance, Vortex, Shearview, Closure.
Backup: encrypted `shewall.bin`. Hash samples collate per hasher dest and prune after 1000 confirmations; sealed transfers stay for the explorer. Optional bootstrap: [boot.shear.digital](https://boot.shear.digital) at height 1000, then every 400 blocks.
