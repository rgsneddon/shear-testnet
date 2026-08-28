# Windows pointer — Shear

**Do not use this file as the pin list.** Status lives in:

**https://github.com/rgsneddon/handoff/blob/main/HANDOFF.md** (section **Shear**)

## [testnet] Shear 0.1 / Shear-Miner 1.1 + 1.0

New repo: **https://github.com/rgsneddon/shear-testnet** (GitHub name `shear-testnet`, display **[testnet] Shear**). Do **not** attach leftover zips to `rgsneddon/shear` or to any `v0.1.0` / three-part tag.

**Versioning:** two integers only (`*.*`, never `*.*.*`). Wallet / node / pool stay **0.1**. Official miner pin is **Shear-Miner 1.1** (free). **1.0** stays on tag `1.0` as the last fee build — do **not** recut it. Never `1.1.0`. Every GitHub release title is **`[testnet] …`**.

**Book-law:** 128-byte header, `ssa1` dests, 90s ASERT, 1 SHE pot, `HASH_TX_LIVE=1`, consensus spendable **1 conf**. Merchant `min_confirms` **12**. Magic `shear-testnet-v1`. Datadir `/var/lib/shear/testnet-0.1` (do **not** load `/var/lib/shear/testnet` ~7995 snapshot).

Each miner Windows zip is **only** two files at zip root: `Shear-Miner.exe` + `example.bat`. No extra MinGW DLLs in the zip (UCRT/Win10+). **No miner inside the wallet zip.**

### Shear-Miner 1.1 Windows PE — **on tag** (free)

https://github.com/rgsneddon/shear-testnet/releases/tag/1.1  
Title **`[testnet] Shear-Miner 1.1`**. Asset **`Shear-Miner-1.1-windows.zip`**. Zip root: `Shear-Miner.exe` + `example.bat`.

- `--print-config` name **Shear-Miner**, version **1.1**, `feePct` **0**, `clientLogin` **direct**, `headerBytes` 128, pool `pool.shear.digital:1111`
- Banner `Shear-Miner 1.1 (free to use, no miner fee)`. No dual-login `.fee` socket
- `--selftest` `5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066`
- `example.bat` launches `Shear-Miner.exe --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --threads 8`
- Do **not** recut. Do **not** put this zip on tag `1.0`

### Shear-Miner 1.0 Windows PE — **on tag** (4% fee)

https://github.com/rgsneddon/shear-testnet/releases/tag/1.0  
Title **`[testnet] Shear-Miner 1.0`**. Asset **`Shear-Miner-1.0-windows.zip`**. Zip root: `Shear-Miner.exe` + `example.bat`. Built from tag **`1.0`** (`53b72c6`).

- `--print-config` name **Shear-Miner**, version **1.0**, `feePct` **4**, `clientLogin` **dual-fee**, `feeDest` `she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj`, `headerBytes` 128, pool `pool.shear.digital:1111`
- Banner `Shear-Miner 1.0 (declared 4% fee, dual connection)`. Dual-login `.fee`, `FEE_EVERY` 25
- `--selftest` same hash `5d00a242…`
- `example.bat` same launch line and mentions the 4% fee
- Do **not** recut. Do **not** clobber with 1.1 binaries

Laptop second-eye (optional): unzip each zip, run `Shear-Miner.exe --print-config` and `--selftest`.

### Wallet 0.1 leftover (Windows / Linux / Arch) — **still leftover**

Mac-cut is notarized DMG + signed APK on **`0.1`**. Laptop attach to **the same** `0.1` tag (no sibling):

1. Clone `rgsneddon/shear-testnet` (not `rgsneddon/shear`).
2. `kWalletVersion` / window title **0.1**. Flutter file version may be `0.1.0+N` — that is **not** the public pin.
3. Build `shear-wallet-0.1-windows.zip` / `-linux.zip` / `-archlinux.zip`. **No miner inside.** PKGBUILD `pkgver=0.1` (not `0.1.0`).
4. Title **`[testnet] Shear wallet 0.1`**. **No iOS / iPad zip.** Do not upload to the App Store.
