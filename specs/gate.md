# Phase B GATE

Network: `shear-testnet-v2`. Date: 2026-08-30.

Phase B (Flow levy product, Reserve Book B, pool pull-withdraw, Closure, vort1) **does not start** until this GATE is true **and** Phase A accept boxes A1–A5 are green.

## Conditions

Start Phase B when `verifyBlock` accepts EVM **and** a native Flow send plus an EVM SHE value transfer can land in the same block model.

| Condition | Status |
|-----------|--------|
| `verifyBlock` accepts / executes EVM | **TRUE.** Reserve lock/vote/withdraw run pinned `Reserve.json` bytecode via `executeBlockEvm`. Fail closed (`reason: evm`). |
| Native Flow send can land in a block | **TRUE.** Funded vin/vout + levy. |
| EVM SHE value transfer in the same block | **TRUE.** `kind: evm-value` moves protocol nanos as EVM `value` between `ssa1` 20-byte accounts. |

**GATE = TRUE** (`PHASE_B_GATE` / `printConfig().phaseBGate`). Extra mint remains `extraMintAllowed` only (`shear-reserve-v1` + Join genesis). A random vortice still cannot print SHE.

Phase B product (Book B, pool pull-withdraw, Closure, vort1 CREATE) is **not** started by this GATE.
