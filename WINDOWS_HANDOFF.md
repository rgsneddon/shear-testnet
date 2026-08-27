# Windows pointer — Shear

**Do not use this file as the pin list.** Status lives in:

**https://github.com/rgsneddon/handoff/blob/main/HANDOFF.md** (section **Shear**)

## [testnet] Shear 0.1 / miner 0.5 — laptop leftover (a lot of work)

New repo: **https://github.com/rgsneddon/shear-testnet** (GitHub name `shear-testnet`, display **[testnet] Shear**). Do **not** attach these zips to `rgsneddon/shear` or to any `v0.1.0` / three-part tag.

**Versioning:** two integers only. Wallet / node / pool **0.1**. Miner **0.5**. Never `0.1.0`. Never bump to `1.*` unless the operator says so. Every GitHub release title is **`[testnet] …`**.

**Book-law (incompatible with the old 7995-block DE chain):** 128-byte header, `ssa1` dests, 90s ASERT, 1 SHE pot, `HASH_TX_LIVE=1` baked, consensus spendable **6 confs** (~9 min, in the fingerprint). Third-party `min_confirms` **12** (~18 min) is wallet/merchant policy only. Magic still `shear-testnet-v1`. Old `rgsneddon/shear` tags (`v0.0.9` wallet / `v0.1.7` miner) are frozen pre-recut.

### Wallet 0.1 leftover (Windows / Linux / Arch)

Mac-cut is notarized DMG + signed APK on **`0.1`**. Laptop attach to **the same** `0.1` tag (no sibling):

1. Clone `rgsneddon/shear-testnet` (not `rgsneddon/shear`).
2. `kWalletVersion` / window title **0.1**. Flutter file version may be `0.1.0+N` — that is **not** the public pin.
3. Build `shear-wallet-0.1-windows.zip` / `-linux.zip` / `-archlinux.zip`. **No miner inside.** PKGBUILD `pkgver=0.1` (not `0.1.0`). Scripts: `wallet/pack/build_linux.sh`, `wallet/pack/zip_linux.sh` (paths under `shear-testnet`).
4. Title **`[testnet] Shear wallet 0.1`**. **No iOS / iPad zip.** Do not upload to the App Store.

### Miner 0.5 leftover (Windows PE)

Mac Darwin `shear-miner` 0.5 already built (128-byte header, HEX_CAP covers 256 hex, `--selftest` `5d00a242…`). Laptop attach to **the same** miner **`0.5`** tag:

1. `shear-miner-0.5-windows.zip` = `shear-miner.exe` + `example.bat` at zip root.
2. `--print-config` version **0.5**, `headerBytes` 128, pool `pool.shear.digital:1111`.
3. `--user she1…` or `ssa1…` (not `shear1`). Declared 5% dual-login fee still `she1qlrll…fee`.
4. Title **`[testnet] Shear miner 0.5`**.

There is **a lot of work** on Windows for this recut (PE miner 0.5, Flutter windows/linux/arch wallet 0.1, example.bat, no miner-in-wallet). Do it from `shear-testnet`. Do **not** recut old `v0.1.7` / `v0.2.0`.
