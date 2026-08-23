# The Reserve

First Vortex dapp. Not the general contract surface (that is Vortex).

| Rule | Value |
|------|--------|
| Lock | Full current Vortex (400 days) |
| Vote unlock | Deposit π SHE |
| Interest | Bank of England Base Rate on locked principal |
| Release | After Vortex end: principal + interest to Continuum |
| Vote | Hash bonus +10⁻¹⁰ / −10⁻¹⁰ / unchanged |

Oracle: official BoE Base Rate. Consensus of the chain does **not** depend on this oracle. A bad rate feed cannot reorg blocks or steal the 1 SHE pot.

Hardcoded program id: `shear-reserve-v1`. This is the **only** Vortex dapp whose `mint` is consensus-legal. Third-party staking products must pre-fund (top up) staker rewards from SHE already in circulation.
