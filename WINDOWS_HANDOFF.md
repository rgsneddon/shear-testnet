# Windows pointer — Shear

**Do not use this file as the pin list.** Status lives in:

**https://github.com/rgsneddon/handoff/blob/main/HANDOFF.md** (section **Shear**)

## [Testnet] ShearK-Miner 1.0 — Windows **on tag**; Linux leftover

New miner repo: **https://github.com/rgsneddon/ShearK** (display **[Testnet] ShearK**). Do **not** attach ShearK-Miner zips to `rgsneddon/shear` or recut Shear-Miner tags `1.1` / `1.0` on `shear-testnet`.

Mac-cut + Windows PE are on tag **`1.0`**. Title **`[Testnet] ShearK-Miner 1.0`**. https://github.com/rgsneddon/ShearK/releases/tag/1.0

- `ShearK-Miner-1.0-macos.zip` sha256 `0a55f3cd2dd5b9ef55e83cb138ef9e6d3a838cb4470147f11a296a6686d6d74b` zip root `ShearK-Miner` + `example.sh`
- `ShearK-Miner-1.0-windows.zip` sha256 `541333c65592b10ff8119b371bf6226a8225045bd2ba59b36af3eecbaa43c1cf` zip root `ShearK-Miner.exe` + `example.bat` (PE32+ x86-64, static)

1. **Still leftover:** `ShearK-Miner-1.0-linux.zip` (this Darwin host has no Linux toolchain for RandomX).
2. `--print-config`: `name=ShearK-Miner`, `algorithm=ShearHash`, `personalisation=ShearHash-v2`, `version=1.0`, `headerBytes=128`, `magic=shear-testnet-v2`, `rxMode=light`, `rxCacheMiB=128`, `feePct=0`
3. Do **not** write “feeless”. Do **not** recut Shear-Miner 1.1 / 1.0.

ShearHash-v2 book is `shear-testnet-v2`. Pool/node verify the same RandomX-lite digest. v1 shares mint 0. Operator cutover of live Germany v1 datadir is a separate explicit approval.

## [testnet] Shear wallet 0.3 leftover — Windows / Linux / Arch

Mac-cut (this Darwin host): APK + notarized DMG on tag **`0.3`**. Title **`[testnet] Shear wallet 0.3`**. Window / launcher **Shear 0.3**. https://github.com/rgsneddon/shear-testnet/releases/tag/0.3

- `shear-wallet-0.3-macos.dmg` sha256 `6488eb08f3f295cf103c6f85c42e2a48c6d649e7c834d1568570321b7af62b1b` Developer ID + notarized + stapled
- `shear-wallet-0.3-android.apk` sha256 `3be79dc6e4663207bae8907acd05261bc61a9d40b5e348c7a681129c9bf0932d` (INTERNET; launcher **Shear 0.3**)

1. Laptop pack `shear-wallet-0.3-windows.zip` onto **the same** `0.3`. Zip root Flutter `shear_wallet.exe` + DLLs/`data`. **No miner inside.** Window title **Shear 0.3**. Flutter file version `0.3.0+15` is **not** the public pin.
2. **Still leftover:** `shear-wallet-0.3-linux.zip` / `-archlinux.zip` (PKGBUILD `pkgver=0.3`).
3. **Last leftover (Windows):** after those zips, `#pack-advisory` on shear.digital already points at **0.3** in-repo; deploy `/var/www/shear.digital` if not done from Mac. Fill sha256 when Windows zip exists.
4. **No iOS / iPad zip.** Do not recut miner **1.1** / **1.0**. Node/pool stay **0.1**.

Flow send / Reserve lock use owned Continuum spendable (silent dest when that is where credits sit). The Join: one genesis mint of full prior-ledger circulation; users claim `join1.` keys for 99 days (1:1, no APR). Extra-mint: Reserve oracle APR only; any other vortice forbidden. Pool credits **shareBits** work only (padded `hashes` / extra leading zeros / duplicate submits do not inflate).

## [testnet] Shear wallet 0.2 / Shear-Miner 1.1 + 1.0

New repo: **https://github.com/rgsneddon/shear-testnet** (GitHub name `shear-testnet`, display **[testnet] Shear**). Do **not** attach leftover zips to `rgsneddon/shear` or to any `v0.1.0` / three-part tag.

**Versioning:** two integers only (`*.*`, never `*.*.*`). Wallet pin is **0.2**. Node / pool stay **0.1**. Official miner pin is **Shear-Miner 1.1** (free). **1.0** stays on tag `1.0` as the last fee build — do **not** recut it. Never `1.1.0`. Every GitHub release title is **`[testnet] …`**.

**Site (last leftover step):** every new GitHub pack, the **last** leftover (Windows) updates **https://shear.digital** WALLET / MINER / NODE download buttons **and** the discrete version+sha256 advisory above them (`#pack-advisory` in `site/index.html`), then deploys `/var/www/shear.digital`. Click = device pack; hover = all versions. Do not skip the advisory.

**Book-law:** 128-byte header, `ssa1` dests, 90s ASERT, 1 SHE pot, `HASH_TX_LIVE=1`, consensus spendable **6 confs** (in the fingerprint — do **not** change; flag the operator). Merchant `min_confirms` **12**. Magic `shear-testnet-v1`. Datadir `/var/lib/shear/testnet-0.1` (do **not** load `/var/lib/shear/testnet` ~7995 snapshot).

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

### Wallet 0.2 leftover — Windows / Linux / Arch **on tag**

Mac-cut (notarized DMG + APK) **and** laptop zips are on **`0.2`**. Title **`[testnet] Shear wallet 0.2`**. https://github.com/rgsneddon/shear-testnet/releases/tag/0.2

1. `shear-wallet-0.2-windows.zip` (~13.7 MB, sha256 `e896a824252044159e9865258a15ababea2e48676775878ce356fa624e010f57`). Zip root Flutter `shear_wallet.exe`. **No miner inside.** Window title **Shear 0.2**.
2. `shear-wallet-0.2-linux.zip` (sha256 `f785ebe3fd5810b3f1550ca05b7f08cc5a4d6715230baa939c247e1e7991d689`) / `-archlinux.zip` (sha256 `cb930fecc62221e7ddc31d35349cdd14e84169066769810032520564229db870`, PKGBUILD `pkgver=0.2`).
3. **Last part:** `site/index.html` WALLET/MINER/NODE buttons + `#pack-advisory` version/sha256, then deploy `/var/www/shear.digital`.
4. **No iOS / iPad zip.** Do not upload to the App Store. Do **not** recut miner **1.1** / **1.0**.

Mac-cut already on tag:

- `shear-wallet-0.2-macos.dmg` (~19 MB, sha256 `fd335b48846426900fe1ec27766c08dbecec0fc17d57b389260fcc96057b17a1`) Developer ID + notarized + stapled
- `shear-wallet-0.2-android.apk` (~49 MB, sha256 `356bbb25dbdf49b5fdf69bbfb1f5dea7a255a0e7b1a62d5bd9d0cba5f0b32e38`)

### Wallet 0.1 leftover — Windows **on tag**; Linux / Arch still leftover (historical)

Mac-cut (notarized DMG + signed APK) and **Windows zip** are on **`0.1`**. Title **`[testnet] Shear wallet 0.1`**. https://github.com/rgsneddon/shear-testnet/releases/tag/0.1

1. Asset **`shear-wallet-0.1-windows.zip`** (~13.7 MB, sha256 `e605be153627ebb63dfa970e4fdb1047b48059f265c6c07f4fa14d858ff740f5`). Zip root is Flutter `shear_wallet.exe` + DLLs/`data`. **No miner inside.**
2. `kWalletVersion` / window title **0.1**. Flutter file version `0.1.0+12` is **not** the public pin.
3. **Still leftover:** `shear-wallet-0.1-linux.zip` / `-archlinux.zip` (PKGBUILD `pkgver=0.1`, not `0.1.0`).
4. **No iOS / iPad zip.** Do not upload to the App Store. Do **not** recut miner **1.1** / **1.0**.
