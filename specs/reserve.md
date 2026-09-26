# The Reserve

First Vortex dapp. Not the general contract surface (that is Vortex).

| Rule | Value |
|------|--------|
| Lock | Full current Vortex epoch (`EPOCH_DAYS`: 4 testnet / 400 mainnet) |
| Vote unlock | Portal holds ≥ π SHE (staked + idle). First deposit in the last 99 days still unlocks a vote. |
| Interest | `floor(stakedNanos * epochBps / 10000)` on **staked** principal only. Idle earns none. `annualBps` is the collector proposal and never mints. |
| Release | After epoch end (and bonus enact): principal (staked + idle) + minted interest on staked SHE to Continuum |
| Vote | raise / lower / leave hash bonus (±1 unit). Pot schedule unchanged. One vote per portal per epoch (`vote_locked` on a second cast). |
| Epoch-end enact | Unique plurality of the three piles moves **live** hash bonus ±1 (ties: no change). |
| Epoch start | First qualifying π deposit — not genesis, not an operator clock |
| Late deposits | Accepted any time. Last 99 days: idle (no stake interest) but **can vote**. |
| Portals | One per user dest (`ssa1`). Public rows do not list portals, rest-frame, or view keys |
| Language | Example Solidity at `contracts/Reserve.sol`. Nodes honour the same rules. Shear only. |

Oracle: The Reserve oracle (`shear-reserve-oracle-v1`) is coded into every node. It **may** propose observed annual bps into an epoch freeze. It **must not** move the pot schedule, mint mid-epoch at a live knob, or accept unbounded/stale/equivocating rates. Freeze is consensus-checked (max 10000 bps, max step 100 bps, max age 14d, no second freeze for the same epoch). A bad feed cannot reorg blocks or steal the pot. Mainnet has no operator override switch.

Hardcoded program id: `shear-reserve-v1`. This is the **only** Vortex dapp whose `mint` is consensus-legal. Third-party staking products must pre-fund (top up) staker rewards from SHE already in circulation.

## Checkpoint-bound vault

The Reserve is bound to the same reorg freeze as bootstrap (height **1000**, then every **400**). `vaultSeal` is a minimal commitment of locked portals plus that checkpoint hash (and the genesis hash). `verifyReservePayout` / withdraw / mint on a fork that does not include the seal fail (`no_vault`). Fork verify replays a trial from the LCA only when that fork still has the seal, and never writes the tip `reserveVault`. A fork that broke seal ancestry is not given a vault.

Adopt of a heavier history that lacks seal ancestry is refused (`reorg_vault_seal` / `reorg_checkpoint`) and does **not** replay or wipe the tip vault. A shallow reorg *above* the seal keeps the portals. Continuum shows a banner when the tip lacks seal ancestry and does not paint a pot on that fork. The vault stays on the master chain, rebuilt from genesis. Tip height below 1000: no seal yet, no banner.
