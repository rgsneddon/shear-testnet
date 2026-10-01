# Reserve deploy fix — shear-testnet-v10

## Root cause

Live book magic is `shear-testnet-v10` (`crypto/asert.js`, `MAGIC_TESTNET_V10` / `MAGIC_TESTNET`). A block body that includes a Shear Reserve tx boots pinned Reserve bytecode with that magic.

`bootReserveEvm` (`crypto/reserve_evm.js:179`) CREATE-deploys `contracts/Reserve.json` and, on a constructor exception, throws `reserve_deploy: ${error}` (`crypto/reserve_evm.js:191-192`). The constructor (`contracts/Reserve.sol` constructor) calls `_assertShear()`. Before this patch that allowlist ended at `SHEAR_TESTNET_V9` and `SHEAR_MAINNET` (`contracts/Reserve.sol:118` on main). `keccak256("shear-testnet-v10")` missed every arm, so the constructor reverted `NotShear()`. The EVM reports that as `revert`, and the seal surfaces `reserve_deploy: revert`.

Coinbase-only bodies skip this CREATE, so they still seal.

Git: `2799386` (v9 cut) added `SHEAR_TESTNET_V9` to `_assertShear` and recompiled `contracts/Reserve.json`. `40c917b` (v10 cut) changed `MAGIC_TESTNET` and did not touch `contracts/Reserve.sol` or `contracts/Reserve.json`.

Pre-patch local CREATE (pinned bytecode, chain id 2701):

- `bootReserveEvm({ network: 'shear-testnet-v10' })` → `reserve_deploy: revert`
- `bootReserveEvm({ network: 'shear-testnet-v9' })` → deployed
- `bootReserveEvm({ network: 'not-a-shear-book' })` → `reserve_deploy: revert`

## Files touched

- `contracts/Reserve.sol` — `SHEAR_TESTNET_V10 = keccak256("shear-testnet-v10")` on the same allowlist as prior books (`contracts/Reserve.sol:43`, check at `:119`).
- `contracts/Reserve.json` — recompiled with `node contracts/compile_reserve.js` (solc 0.8.36, optimizer runs 200).
- `crypto/reserve_evm.test.js` — v10 CREATE succeeds (stored magic matches); v9 still deploys; `shear-testnet-unknown` still throws `reserve_deploy: revert`.

ASERT / retarget were not changed. No suite redesign.

## How to run tests

```
node --test --test-timeout=120000 crypto/reserve_evm.test.js
```

Local result after the patch: 5 tests, 0 failed, including `CREATE with shear-testnet-v10 succeeds and an unknown magic reverts`.

## Live deploy

Live deploy and pool bounce are not included. No `/opt/shear-v4` touch. No soft-merge.
