# Confirm policy

Network: `shear-testnet-v2`. **Not** in `consensusFingerprint()`.

Policy and book-keeping. Does not change which chain is canonical. Does not turn levy on. Consensus spendable floor stays **6** (`SPENDABLE_CONFIRMATIONS`, already in the fingerprint). Freeze is policy.

Surfaces that share one table: wallet Continuum / Shearview, pool pending / confirmed, explorer.shear.digital, node RPC `getpolicy`. Pool dashboard is not the source of `d_max` / `h_ratio` — those are measured from headers and `getchaintips`.

## Static bands (thin-hash defaults)

| Class | Depth N | ~time at 90 s | Who |
|-------|---------|---------------|-----|
| UI “seen” | 1 | 90 s | Wallet badge only |
| Consensus spendable | **6** | ~9 min | Already locked. Coinbase, B-spends. Matches `CONFIRMS_SPEND` |
| Peer / small Flow | 12 | ~18 min | Existing `min_confirms` |
| Pool / merchant | 30 | ~45 min | Pool “confirmed”; no shop 0-conf |
| OTC / large Continuum | 120 | ~3 h | Human desks |

Coinbase / hash-bonus maturity = max(6, desk policy). Never spend a pot shallower than 6.

The 6-conf floor does not move. `ui_seen` stays 1.

## Dynamic raise

Inputs (node, from headers — not pool H/s):

- `d_max` — deepest reorg, last 6 h
- `h_ratio` — work in last 1 h / median hourly work over last 24 h
- `side_lead` — best other tip work minus active tip work (`getchaintips`)

Rules:

- `d_max >= 3` → operational N ← max(N, 30); paint “reorg risk”
- `d_max >= 10` **or** `side_lead > 0` for more than 2 block times (180 s) → **freeze credits** (pool confirmed, wallet spendable stays pending even past 6)
- `h_ratio < 0.5` → multiply policy N by 2 until H/s recovers for 20 blocks; also freeze (ops)
- Freeze clears after 20 consecutive blocks with `d_max == 0` and `side_lead <= 0`

Thin data (chain younger than 1 h): `h_ratio = 1` (do not freeze on an empty window).

## `getpolicy`

```
{
  consensus_min: 6,
  merchant_default: 12,
  bands: { ui_seen, consensus_spendable, peer_small_flow, pool_merchant, otc_large },
  frozen, d_max, h_ratio, side_lead, reorg_risk,
  operational: { pool_merchant, ... }
}
```

Node RPC `getpolicy`. Pool `GET /api/policy` is a consumer of the same object. `/api/stats.spendableConfirmations` stays **6**.

Dashboard / explorer “confirmed” uses operational `pool_merchant` (default 30), not 1-block seal and not consensus 6.

## Second seed

Stratum may stay on Germany (`178.105.187.178`). A second **validating** node belongs off that box. `SHEAR_SEEDS` / RPC `addnode` (alias of `p2p.connect`). `shear-watch` is not that node and is not a consensus peer.

## Halt (optional)

`reorg_halt_depth` default **0** (off). If set (suggest 200): stop *applying* a deeper reorg, log `REORG_HALT`, do not broadcast a different tip. Default remains follow-heaviest-valid. No `setTip`.
