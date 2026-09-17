# Mainnet (not live)

This tree is prepped for `shear-v1`. **It does not emit yet.**

- Magic today: `shear-testnet-v4` (ADMITv2).
- Mainnet magic: `shear-v1`.
- Genesis instant is already in `crypto/asert.js` (`GENESIS_MAINNET`). Do not invent another.
- `node node/src/node.js` with `SHEAR_NETWORK=shear-v1` prints `clock_wait` unless `SHEAR_MAINNET_EMIT=1` **and** the genesis instant has passed.
- Wallet CLI: `shear --network shear-v1` does the same.
- The operator is **not** cutting over. Do not set `SHEAR_MAINNET_EMIT=1`.

When the operator cuts over, follow [the node how-to](../README.md) with a **new** datadir. Testnet v4 stays at https://github.com/rgsneddon/shear-testnet.
