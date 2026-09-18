# Shear emissions and rewards

Three separate paths. They do not substitute for each other.

## 1. Block pot — epoch-indexed schedule

Every valid block mints the **scheduled pot** in the coinbase (`kind: pot`).
Solo: the finder. Pool: split by proven work in that round. Public pool may take 1% of this pot only.

```
subsidy(epoch) = max(POT_FLOOR_NANOS, POT_START_NANOS - epoch * POT_STEP_NANOS)
```

| Constant | Value |
|----------|--------|
| `POT_START_NANOS` | `100_000_000_000` (1.00 SHE) |
| `POT_STEP_NANOS` | `1_000_000_000` (0.01 SHE) |
| `POT_FLOOR_NANOS` | `20_000_000_000` (0.20 SHE) |
| `EPOCH_DAYS` | **4 testnet** / **400 mainnet** (fingerprinted) |

Epoch index = `floor((block_time - genesis_time) / EPOCH_DAYS)`. **Not** every N blocks.
The first reduction is after epoch **0** completes (no genesis pot cut). Epochs 80+ stay at 0.20 SHE forever.

**Mainnet (400d):** ~400 days at 1.00, then ~87.7 years of taper, then a permanent 0.20 security tail (~88.7 years from genesis to floor).
**Testnet (4d):** same table, faster clock — floor after ~324 days so the curve is observable in <1 year.

The pot is **not votable**. The Reserve oracle cannot move it. Validation is `vout_pot == subsidy(epoch)` (`pot` / `pot_sched` on mismatch).
dt is not a mint input. The Continuum tab observes Q(t) and E from sealed pots. It does not mint.

Boundary: the first millisecond of epoch N+1 uses `subsidy(N+1)`. The last millisecond of epoch N uses `subsidy(N)`.

This is **not** a hard-capped total supply: Reserve interest remains a third mint path.

## 2. Per-hash bonus — 10⁻¹¹ SHE × proven units, per miner

Each valid ShearHash-v3 share on the **parent job header** mints **0.00000000001 SHE** (1 protocol unit of 10⁻¹¹ SHE) times `2^SHARE_FLOOR_BITS`. The per-hash unit is never 0 (`HASH_UNIT_FLOOR=1`). On the public pool, hash-bonus nanos **accumulate** with the miner’s pot share and are **not** paid the same block. Auto-payout to the miner `ssa1` fires at **π SHE** (`PI_SHE_NANOS`). The 1% pool fee is taken from the **block pot only**; hash bonus is fee-free. The pool pays the Flow levy on that send. Wallet “Pull from pool” is deprecated.

Alice 4 000 units + Bob 1 000 units in the same round → Alice 4 000 units, Bob 1 000 units, in the same coinbase as `kind: hash`. The finder does not take anyone else’s hash bonus.

Votes may raise, lower, or leave that unit at epoch end. **Votes cannot move the pot.**
**The unit is never 0.** `HASH_BONUS_NANOS_FLOOR = 1` is consensus (`HASH_UNIT_FLOOR=1`). A decrease vote at the floor is invalid (`unit_floor`). Enact cannot write 0; load and verify clamp any corrupted 0 back to 1.

## 3. The Reserve — stake, not a block mint

The Reserve is a Vortex dapp, not a third coinbase line.

- Deposit **π SHE** as **staked** SHE to unlock a vote for the current Vortex epoch (`EPOCH_DAYS`).
- Staked principal accrues interest at the **frozen `epochBps`** for that epoch only.
- After the epoch ends, withdraw principal + interest on staked SHE into Continuum.
- Vote: raise hash bonus +1 unit, lower −1 unit, or leave it. The pot schedule does not change.

Interest: `floor(stakedNanos * epochBps / 10000)` using the freeze for that epoch. Mid-epoch `annualBps` observations are display-only.

## Who may draw on emissions

| Path | Mints SHE? |
|------|------------|
| Block pot (schedule) | yes, coinbase |
| Per-hash bonus (10⁻¹¹ SHE × proven units) | yes, coinbase, to each hasher |
| **The Reserve** (oracle interest on staked SHE) | **yes — the only dapp allowed to** |
| Any other Vortex dapp | **no.** |

## Oracle trust boundary

| Oracle MAY | Oracle MUST NOT |
|------------|-----------------|
| Propose observed annual bps within policy | Move block pot or pot schedule |
| Supply inputs to **epoch freeze** of `epochBps` | Mint mid-epoch at an unfrozen live knob |
| Fail closed to previous freeze / default on stale data | Silently invent rates with no attestation |
| Be replaced only via fingerprint/program rules | Accept unbounded jump, negative, or > max bps |

Freeze is consensus-checked: bounds `[0, 10000]` bps, max step 100 bps/epoch, max observation age 14d, no equivocating freeze for the same epoch index. A bad feed cannot reorg blocks or steal the pot.

## What wallets show (Continuum)

```
Epoch N · pot P SHE (next P−0.01, floor 0.20)
Round: 0.00000000001 SHE × your hashes
Reserve: lock π SHE → vote + frozen epoch interest
```
