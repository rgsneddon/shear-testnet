# Phase B GATE

Network: `shear-testnet-v2`. Date: 2026-08-30.

Phase B (Flow levy product, Reserve Book B, pool pull-withdraw, Closure, vort1) **does not start** until this GATE is true **and** Phase A accept boxes A1–A5 are green.

## Conditions

Start Phase B when `verifyBlock` accepts EVM **and** a native Flow send plus an EVM SHE value transfer can land in the same block model.

| Condition | Status (this Build) |
|-----------|---------------------|
| `verifyBlock` accepts / executes EVM | **FALSE.** `node/src/chain.js` does not import `crypto/reserve_evm.js`. Extra mint is `extraMintAllowed` only. |
| Native Flow send can land in a block | **TRUE.** `store.queueTx` → mempool → `buildTemplate` → `verifyBlock`. |
| EVM SHE value transfer in the same block | **FALSE.** `callReserve` never passes `value`. Live `applyReserveBlock` is the JS vault. |

**GATE = FALSE.** Do not wire EVM into `verifyBlock` in Phase A. Do not start Phase B in the same Build.

Live Reserve path: `crypto/reserve_vault.js`. `crypto/reserve_evm.js` is a sidecar test harness (chainId 2701). Header `base_fee` and levy checks already live in `verifyBlock` are not Phase B.

## What Phase A still does

A5 tightens the native mint allow-list in `verifyBlock` (Reserve + Join genesis only; no wrap printer). That does **not** green this GATE.
