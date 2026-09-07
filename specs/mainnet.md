# Shear mainnet (`shear-v1`) — prep

Private prep. Do not publish genesis hash. Do not start the book.

Levy, vote, withdraw, pot, ASERT tau, hash bonus: **same as testnet 0.27**. Do not retune.

| | Mainnet |
|---|---|
| Magic | `shear-v1` |
| HRP | shear / she1 / ssa1 (same as testnet; books isolated by magic) |
| Algo | ShearHash-v2 light |
| Pot | exactly 1 SHE |
| Hash bonus | 1 unit = 10⁻¹¹ SHE per accepted hash to that hasher |
| Levy cap | never exceeds 0.001 SHE |
| Levy split | 50/50 finder / Reserve vault |
| Extra mint | only `shear-reserve-v1` |
| Spendable | 6 confirmations |
| P2P | `p2p.shear.digital:30303` |
| IP fallback | `46.224.132.83:30303` |
| Future peer | `178.105.187.178:30303` (equal node, not a master book; do not restart) |
| Datadir | `~/.shear/mainnet` or `/var/lib/shear/mainnet` |
| Stratum | not on the seed VPS |
| Wallet pin | **0.27** |
| Miner pin | ShearK **1.5** with `"magic":"shear-v1"` |
| Genesis time | **Friday** 11 September 2026, 20:00:00 UTC (21:00 BST) |
| Premine | none |

`Reserve.sol` `SHEAR_MAINNET = keccak256("shear-v1")` stays.

Testnet clients reject a `shear-v1` envelope. Mainnet clients reject a foreign testnet book.
