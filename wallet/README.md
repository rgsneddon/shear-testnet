# Shear wallet 0.39

GUI (Flutter) and CLI. Same identity, same encrypted `shewall.bin`, same book magic `shear-testnet-v4`.

Tabs: Continuum, Flow, Resistance, Vortex, Shearview, Closure. The Reserve lives under Vortex.

Backup file: encrypted `shewall.bin`. Offer `she1` when someone pays you. Incoming coin lands on a revolving `ssa1` dest. Rest-frame `shear1` stays in Closure.

Mine with **Copy dest**: the Continuum `ssa1` shown on screen (Copy dest copies that mailbox; it does not mint a new one). Log ShearK in as `ssa1.worker`. Hash bonus (no 1% fee) and your pot share accumulate; the public pool auto-pays that `ssa1` at π SHE.

Pool: `pool.shear.digital:1111` (cleartext TCP unless TLS is in front). Magic: `shear-testnet-v4`.

Continuum is spendable, pending transfers until six confirmations, and Copy ID. Already-confirmed SHE loads from a local node (`127.0.0.1:18332`) on unlock. Open-round hashes stay pending until the next sealed block. Shearview lists your landings (height, from/to, date, amount, snippet); tap a row for full Resistance detail. Hashbonus sits inside the block row. The pot is pool-custodial until 30 confirms, then auto-pays at π. This wallet does not mine. Public pool HTTP submit is an advanced toggle.

Releases: https://github.com/rgsneddon/shear-testnet/releases/tag/0.39

| Platform | Install |
|----------|---------|
| Windows | Unzip `shear-wallet-0.38-windows.zip`, run `shear_wallet.exe` |
| Linux | Unzip `shear-wallet-0.38-linux.zip`, run `./shear_wallet` |
| Arch | Unzip `shear-wallet-0.38-archlinux.zip` (includes `PKGBUILD`) or run `./shear_wallet` |
| Android | Sideload `shear-wallet-0.38-android.apk` (`com.shear.shear_wallet`). Uninstall any old debug-signed build first |
| macOS | `.dmg` is packed on the MacBook — see `MACBOOK_HANDOFF.md` until the asset 200s |

## CLI

```bash
cd wallet
dart run bin/shear.dart help
dart run bin/shear.dart create --store ./session.json --password-file ./pw
dart run bin/shear.dart dest --store ./session.json --password-file ./pw
dart run bin/shear.dart send --to she1… --amount 0.001 --password-file ./pw
dart run bin/shear.dart vote --choice hold --password-file ./pw
dart run bin/shear.dart rewards
dart run bin/shear.dart vortex create --id mydapp --origin https://host/dapp.json --source-file ./dapp.json
dart run bin/shear.dart backup --out shewall.bin --password-file ./pw
dart run bin/shear.dart restore --file shewall.bin --password-file ./pw
```

Closure backup/restore is the **same** `exportEncryptedShewall` / `importEncryptedShewall` path as the GUI. A v1 (PBKDF2) `shewall.bin` still opens and reseals to v2 (Argon2id). Password never belongs on argv.

GUI-only: theme toggle, biometrics, camera QR. Everything else has a CLI command (`shear help`).

Mainnet `shear-v1` is not live and is not yet scheduled. `shear --network shear-v1` prints `clock_wait`.
