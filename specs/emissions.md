# Shear emissions and rewards

Three separate paths. They do not substitute for each other.

## 1. Block pot — 1 SHE per block continuity

Every valid block mints exactly the fingerprint pot in the coinbase (`kind: pot`).
Solo: the finder. Pool: split by proven work in that round. Public pool may take 1% of this pot only.
This is **1 SHE per block continuity**, not an infinite tick schedule.
The pot is the closure quantum of a target flux S_pot/T.
The series of pots is the recoverable integral of that flux, snapped to the fingerprint quantum at block-found.
Validation remains `vout_pot == BLOCK_SUBSIDY_NANOS`.
dt is not a mint input.
The Continuum tab observes Q(t) and E from sealed pots. It does not mint.
Votes do not move the pot. The Reserve Oracle does not move the pot.

## 2. Per-hash bonus — 0.0000000001 SHE × hashes, per miner

Each valid hash in the **current block round** mints **0.00000000001 SHE** (1 protocol unit of 10⁻¹¹ SHE) to the **miner who produced that hash**. Public amounts show eight fractional digits; the extra unit is still sealed on the payout.

Alice 4 000 hashes + Bob 1 000 hashes in the same round → Alice 40 000 units, Bob 10 000 units, in the same coinbase as `kind: hash`. The finder does not take anyone else’s hash bonus.

The continuity root commits these samples. After 100 confirmations the **sample list** may be pruned; **coinbase outputs and every user transfer stay sealed forever**. Explorer reports those sealed rows for eternity. It never needs the pruned per-hash JSON.

## 3. The Reserve — stake, not a block mint

The Reserve is a Vortex dapp, not a third coinbase line.

- Deposit **π SHE** (3.141592653589793…) as **staked** SHE to unlock a vote for the current 400-day Vortex.
- Deposited SHE is **locked for that Vortex**.
- Staked principal accrues interest at the variable rate observed by **The Reserve oracle** on every node.
- After the Vortex ends, withdraw **principal + interest on staked SHE** into Continuum (spendable). Idle SHE returns with no interest.
- Vote: raise hash bonus +1 unit (10⁻¹¹ SHE), lower −1 unit, or leave it. The **1 SHE pot does not change**.
- If fewer than 99 days remain, new deposits still lock, but they sit idle: no interest, no vote.

Interest is protocol-minted by **The Reserve only** at withdraw (oracle rate × staked principal × 400/365). It is not taken from miners’ pot or hash bonuses.

## Who may draw on emissions

| Path | Mints SHE? |
|------|------------|
| Block pot (1 SHE) | yes, coinbase |
| Per-hash bonus (10⁻¹⁰ SHE × hashes) | yes, coinbase, to each hasher |
| **The Reserve** (oracle interest on staked SHE) | **yes — the only dapp allowed to** |
| Any other Vortex dapp (third-party “staked coins”, vaults, etc.) | **no.** Operators must **top up** a reward pool with existing SHE. Consensus must reject a mint from any program id other than the hardcoded Reserve. |

## What wallets show (Shear tab)

```
Block: 1 SHE pot
Round: 0.00000000001 SHE × your hashes
Reserve: lock π SHE → vote + oracle interest on staked SHE over 400 days
```
