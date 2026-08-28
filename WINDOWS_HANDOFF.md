# Windows pointer — Shear

**Do not use this file as the pin list.** Status lives in:

**https://github.com/rgsneddon/handoff/blob/main/HANDOFF.md** (section **Shear**)

## [testnet] Shear 0.1 / Shear-Miner 1.1 — laptop leftover (a lot of work)

New repo: **https://github.com/rgsneddon/shear-testnet** (GitHub name `shear-testnet`, display **[testnet] Shear**). Do **not** attach these zips to `rgsneddon/shear` or to any `v0.1.0` / three-part tag.

**Versioning:** two integers only (`*.*`, never `*.*.*`). Wallet / node / pool stay **0.1** — do **not** roll those to `1.*`. Official miner is **Shear-Miner 1.1** (tag `1.1`, title **`[testnet] Shear-Miner 1.1`**). **1.0** stays on tag `1.0` with the built-in dual-login fee — do **not** recut it. Never `1.1.0`. Every GitHub release title is **`[testnet] …`**.

**Book-law (incompatible with the old 7995-block DE chain):** 128-byte header, `ssa1` dests, 90s ASERT, 1 SHE pot, `HASH_TX_LIVE=1` baked, consensus spendable **1 conf** (in the fingerprint). Third-party `min_confirms` **12** (~18 min) is wallet/merchant policy only. Magic still `shear-testnet-v1`. Do **not** recut miner **1.0** or **0.5**.

### Wallet 0.1 leftover (Windows / Linux / Arch)

Mac-cut is notarized DMG + signed APK on **`0.1`**. Laptop attach to **the same** `0.1` tag (no sibling):

1. Clone `rgsneddon/shear-testnet` (not `rgsneddon/shear`).
2. `kWalletVersion` / window title **0.1**. Flutter file version may be `0.1.0+N` — that is **not** the public pin.
3. Build `shear-wallet-0.1-windows.zip` / `-linux.zip` / `-archlinux.zip`. **No miner inside.** PKGBUILD `pkgver=0.1` (not `0.1.0`). Scripts: `wallet/pack/build_linux.sh`, `wallet/pack/zip_linux.sh` (paths under `shear-testnet`).
4. Title **`[testnet] Shear wallet 0.1`**. **No iOS / iPad zip.** Do not upload to the App Store.

### Shear-Miner 1.1 leftover (Windows PE) — **do this**

Mac Darwin `Shear-Miner` **1.1** and Linux ELF already on tag **`1.1`**. Laptop attach to **the same** miner **`1.1`** tag (do **not** recut `1.0`):

1. `Shear-Miner-1.1-windows.zip` = `Shear-Miner.exe` + `example.bat` at zip root (not `shear-miner.exe`).
2. `--print-config` name **Shear-Miner**, version **1.1**, `feePct` **0**, `clientLogin` **direct**, `headerBytes` 128, pool `pool.shear.digital:1111`.
3. **No miner fee.** No dual-login `.fee` socket. Banner `Shear-Miner 1.1 (free to use, no miner fee)`.
4. `--user she1…` or `ssa1…` (not `shear1`). Pool login paints **Shear-Miner** / **1.1**.
5. Title **`[testnet] Shear-Miner 1.1`**.

### Shear-Miner 1.0 leftover — **do not recut**

Tag **`1.0`** already ships the last fee build (`feePct` 4, dual-login). Leave it. Do **not** clobber `1.0` with 1.1 binaries.

There is **a lot of work** on Windows for this recut (PE **Shear-Miner 1.1**, Flutter windows/linux/arch wallet 0.1, `example.bat`, no miner-in-wallet). Do it from `shear-testnet`.
