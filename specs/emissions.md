# Shear emissions and rewards

Three separate paths. They do not substitute for each other.

## 1. Block pot — 1 SHE

Every valid block mints **exactly 1 SHE** in the coinbase (`kind: pot`).

- Solo: the finder.
- Pool: split among that round’s proven work. The public pool may take **1% of this pot only** for development. Hash bonuses are not fee’d.

## 2. Per-hash bonus — 0.000000001 SHE × hashes, per miner

Each valid hash in the **current block round** mints **1 nano (0.000000001 SHE)** to the **miner who produced that hash**.

Alice 4 000 hashes + Bob 1 000 hashes in the same round → Alice 4 000 nanos, Bob 1 000 nanos, in the same coinbase as `kind: hash`. The finder does not take anyone else’s hash bonus.

The continuity root commits these samples. After 100 confirmations the sample list may be pruned; the coinbase outputs stay.

## 3. The Reserve — stake, not a block mint

The Reserve is a Vortex dapp, not a third coinbase line.

- Deposit **π SHE** (3.141592653589793…) to unlock a vote for the current 400-day Vortex.
- Deposited SHE is **locked for that Vortex**.
- Locked principal accrues **Bank of England Base Rate** interest for the 400 days.
- After the Vortex ends, withdraw **principal + interest** into Continuum (spendable).
- Vote: raise hash bonus +10⁻¹⁰, lower −10⁻¹⁰, or leave it. The **1 SHE pot does not change**.

Interest is protocol-minted by **The Reserve only** at withdraw (BoE oracle × principal × 400/365). It is not taken from miners’ pot or hash bonuses.

## Who may draw on emissions

| Path | Mints SHE? |
|------|------------|
| Block pot (1 SHE) | yes, coinbase |
| Per-hash bonus (10⁻⁹ SHE × hashes) | yes, coinbase, to each hasher |
| **The Reserve** (BoE interest on locked stake) | **yes — the only dapp allowed to** |
| Any other Vortex dapp (third-party “staked coins”, vaults, etc.) | **no.** Operators must **top up** a reward pool with existing SHE. Consensus must reject a mint from any program id other than the hardcoded Reserve. |

## What wallets show (Shear tab)

```
Block: 1 SHE pot
Round: 0.000000001 SHE × your hashes
Reserve: lock π SHE → vote + BoE interest over 400 days
```
