# Mainnet (not live)

This tree is prepped for `shear-v1`. **It does not emit yet.**

- Magic today: `shear-testnet-v4` (ADMITv2).
- Mainnet magic: `shear-v1`.
- Genesis instant is already in `crypto/asert.js` (`GENESIS_MAINNET` = `2026-09-18T21:00:00+01:00`). Do not invent another. Do not move it.
- `node node/src/node.js` with `SHEAR_NETWORK=shear-v1` prints `clock_wait` unless `SHEAR_MAINNET_EMIT=1` **and** `SHEAR_MAINNET_EMIT_CONFIRM=I_UNDERSTAND_SHEAR_MAINNET` **and** the genesis instant has passed.
- Fingerprint must include `POT_SCHED=lin-epoch:…:epochDays=400` and `EPOCH_DAYS=400`. Do not emit under a perpetual 1 SHE pot.
- Wallet CLI: `shear --network shear-v1` does the same.
- The operator is **not** cutting over. Do not set `SHEAR_MAINNET_EMIT=1`.
- The 1 October 2026 countdown is a display date. It is not genesis and it does not emit.

## User funds (Continuum 0.55.2)

Mainnet uses the same coinbase rule the pool builds:

- Pot after the 1% fee is sealed to the hasher dests that proved the share batch.
- Hash bonus is sealed to those same hasher dests. It is not custodial.
- The pool dest receives only the 1% fee.
- A spend of a miner note verifies only when the spend key commits to that dest. The pool operator key does not.
- Historical testnet blocks that sealed the pot to the pool still verify. New jobs do not build that shape.

`node/tests/test_pot_prop.js` is the check (`miner pot and hash notes are spendable only by the miner key`). Do not emit until that test passes. Passing it does not set `SHEAR_MAINNET_EMIT`.

When the operator cuts over, follow [the node how-to](../README.md) with a **new** datadir. Testnet stays at https://github.com/rgsneddon/shear-testnet.
