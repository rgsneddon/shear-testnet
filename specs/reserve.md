# The Reserve

First Vortex dapp. Not the general contract surface (that is Vortex).

| Rule | Value |
|------|--------|
| Lock | Full current Vortex (400 days) |
| Vote unlock | Deposit π SHE into **your** key-portal as **staked** SHE |
| Interest | Variable annual rate observed by **The Reserve oracle** on every node, paid on **staked** principal only. Accrues while the epoch runs; idle SHE earns none. |
| Release | After Vortex end: principal (staked + idle) + interest on staked SHE to Continuum |
| Vote | increase bonus / decrease bonus / leave bonus as-is (±1 unit = ±10⁻¹¹ SHE; 1 SHE pot unchanged). Idle SHE cannot vote. |
| Epoch start | First qualifying π deposit — not genesis, not an operator clock |
| Late deposits | Still accepted if fewer than **99 days** remain, but they sit **idle**: no interest, no vote. Wallets show that disclaimer only once remaining time is already under 99 days. |
| Portals | One per user dest (`ssa1`). Public rows do not list portals, rest-frame, or view keys |
| Language | Example Solidity at `contracts/Reserve.sol`. Nodes honour the same rules. Shear only. |

Oracle: The Reserve oracle (`shear-reserve-oracle-v1`) is coded into every node. Consensus of the chain does **not** depend on this oracle. A bad rate feed cannot reorg blocks or steal the 1 SHE pot.

Hardcoded program id: `shear-reserve-v1`. This is the **only** Vortex dapp whose `mint` is consensus-legal. Third-party staking products must pre-fund (top up) staker rewards from SHE already in circulation.
