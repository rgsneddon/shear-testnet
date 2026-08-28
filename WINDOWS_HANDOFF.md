# Windows pointer — Shear

**Do not use this file as the pin list.** Status lives in:

**https://github.com/rgsneddon/handoff/blob/main/HANDOFF.md** (section **Shear**)

## [testnet] Shear 0.1 / Shear-Miner 1.0 — laptop leftover (a lot of work)

New repo: **https://github.com/rgsneddon/shear-testnet** (GitHub name `shear-testnet`, display **[testnet] Shear**). Do **not** attach these zips to `rgsneddon/shear` or to any `v0.1.0` / three-part tag.

**Versioning:** two integers only (`*.*`, never `*.*.*`). Start at **0.1**. After `0.9` comes `0.10`, `0.11`, `0.12`, … Wallet / node / pool stay **0.1** — do **not** roll those to `1.0`. Operator set the official miner to **Shear-Miner 1.0** (tag `1.0`, title **`[testnet] Shear-Miner 1.0`**). Never `1.0.0`. Every GitHub release title is **`[testnet] …`**.

**Book-law (incompatible with the old 7995-block DE chain):** 128-byte header, `ssa1` dests, 90s ASERT, 1 SHE pot, `HASH_TX_LIVE=1` baked, consensus spendable **1 conf** (in the fingerprint). Third-party `min_confirms` **12** (~18 min) is wallet/merchant policy only. Magic still `shear-testnet-v1`. Old `rgsneddon/shear` tags (`v0.0.9` wallet / `v0.1.7` miner) are frozen pre-recut. Do **not** recut miner **0.5**.

### Wallet 0.1 leftover (Windows / Linux / Arch)

Mac-cut is notarized DMG + signed APK on **`0.1`**. Laptop attach to **the same** `0.1` tag (no sibling):

1. Clone `rgsneddon/shear-testnet` (not `rgsneddon/shear`).
2. `kWalletVersion` / window title **0.1**. Flutter file version may be `0.1.0+N` — that is **not** the public pin.
3. Build `shear-wallet-0.1-windows.zip` / `-linux.zip` / `-archlinux.zip`. **No miner inside.** PKGBUILD `pkgver=0.1` (not `0.1.0`). Scripts: `wallet/pack/build_linux.sh`, `wallet/pack/zip_linux.sh` (paths under `shear-testnet`).
4. Title **`[testnet] Shear wallet 0.1`**. **No iOS / iPad zip.** Do not upload to the App Store.

### Shear-Miner 1.0 leftover (Windows PE)

Mac Darwin `Shear-Miner` **1.0** and Linux ELF already on tag **`1.0`**. Laptop attach to **the same** miner **`1.0`** tag (do **not** recut `0.5`):

1. `Shear-Miner-1.0-windows.zip` = `Shear-Miner.exe` + `example.bat` at zip root (not `shear-miner.exe`).
2. `--print-config` name **Shear-Miner**, version **1.0**, `feePct` **4**, `headerBytes` 128, pool `pool.shear.digital:1111`.
3. `--user she1…` or `ssa1…` (not `shear1`). Declared **4%** dual-login fee still `she1qlrll…fee` (`FEE_EVERY` 25, offset `0..24`).
4. Banner and pool login must paint **Shear-Miner** / **1.0** (not `shear-miner` / `0.5`).
5. Title **`[testnet] Shear-Miner 1.0`**.

There is **a lot of work** on Windows for this recut (PE **Shear-Miner 1.0**, Flutter windows/linux/arch wallet 0.1, `example.bat`, no miner-in-wallet). Do it from `shear-testnet`. Do **not** recut old `v0.1.7` / `v0.2.0` / miner `0.5`.
