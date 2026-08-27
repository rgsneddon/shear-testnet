# Scale at 90 s after prune

Target interval is 90 s → **960 blocks/day**.

| What | Size | Growth |
|------|------|--------|
| Header | 128 B | ~42 MB/year |
| Tree A leaf (packed dest20+count) | ~41 B **per miner per unpruned block** | O(miners), never O(hashes) |
| Tree B | opt-in extras only | prune after 1000 confs |
| Sealed vouts + 1 SHE pot | stay forever | user-tx rate, not hash rate |

**Hash rate does not write hash-rate disk.** 10 MH/s is 9×10⁸ hashes per 90 s block. Collate is one A-leaf per hasher (`{dest20, count}`). A 10k-miner round is ~0.4 MB of A-leaves for that block, not 90 GB of per-hash JSON.

**Prune window (1000 confirmations ≈ 25 h):** sample/B bodies may drop. Sealed coinbase vouts, user txs, and header `continuity_root` stay. After prune, a year of headers + collated A in the window + sealed txs is **GB-class**, not one object per hash.

Opt-in B + prune is what keeps `chain.bin` in GB at 90 s. Turning B into one JSON row per hash would not.
