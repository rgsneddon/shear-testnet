# The Reserve

First Vortex dapp. Not the general contract surface (that is Vortex).

| Rule | Value |
|------|--------|
| Lock | Full current Vortex (400 days) |
| Vote unlock | Portal holds ≥ π SHE (staked + idle). First deposit in the last 99 days still unlocks a vote. |
| Interest | Variable annual rate (Reserve oracle), **staked** principal only, full 400 days. Idle earns none. |
| Release | After epoch end (and bonus enact): principal (staked + idle) + minted interest on staked SHE to Continuum |
| Vote | raise / lower / leave hash bonus (±1 unit). 1 SHE pot unchanged. Change only in the first 301 days. |
| Epoch-end enact | Unique plurality of the three piles moves **live** hash bonus ±1 (ties: no change). |
| Epoch start | First qualifying π deposit — not genesis, not an operator clock |
| Late deposits | Accepted any time. Last 99 days: idle (no stake interest) but **can vote**. |
| Portals | One per user dest (`ssa1`). Public rows do not list portals, rest-frame, or view keys |
| Language | Example Solidity at `contracts/Reserve.sol`. Nodes honour the same rules. Shear only. |

Oracle: The Reserve oracle (`shear-reserve-oracle-v1`) is coded into every node. Consensus of the chain does **not** depend on this oracle. A bad rate feed cannot reorg blocks or steal the 1 SHE pot.

Hardcoded program id: `shear-reserve-v1`. This is the **only** Vortex dapp whose `mint` is consensus-legal. Third-party staking products must pre-fund (top up) staker rewards from SHE already in circulation.
