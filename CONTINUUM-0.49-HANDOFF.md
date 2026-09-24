# Continuum 0.49 — hasher Spendable

Store version `0.49.0+71`. Public tag **0.49**. ShearK stays **2.5**. Do not recut 0.48.

Installed 0.48 can still show pot-class SHE on the hasher mining dest after the pool reconstruct is already dust. The pool balance was not the book the wallet kept. This cut makes the last successful `GET /api/wallet/balance` the Spendable book for that dest.

## Download (what Russell installs)

GitHub release (same place as 0.48):

https://github.com/rgsneddon/shear-testnet/releases/tag/0.49

| Platform | Asset |
|----------|--------|
| Windows | `shear-wallet-0.49-windows.zip` — unzip, run `shear_wallet.exe` |
| Android | `shear-wallet-0.49-android.apk` — uninstall the old sideload first (`com.shear.shear_wallet`) |
| Linux | `shear-wallet-0.49-linux.zip` |
| Arch | `shear-wallet-0.49-archlinux.zip` |
| macOS | MacBook only. `wallet/pack_macos.sh` writes `wallet/dist/shear-wallet-0.49.0-macos.dmg`. Not in the Windows pack. |

Tag the release `0.49` on `rgsneddon/shear-testnet`. `rgsneddon/shear-wallet` stopped at 0.35; do not upload this cut there.

After install: unlock, leave Continuum open until the height is the live tip (force the full credit sync by unlocking again if a pull was still in flight). Spendable is the pool reconstruct, not the miner HUD and not Owed toward π.

## Pack

From `wallet/` after `flutter pub get`. Flutter 3.47.x or 3.44.6. Pubspec is already `0.49.0+71`.

Windows (this box; Darwin cannot `flutter build windows`):

```
flutter config --enable-windows-desktop
flutter build windows --release --build-name=0.49.0 --build-number=71
python pack/zip_windows.py
```

Zip path: `wallet/dist/shear-wallet-0.49-windows.zip` (pin is the first two version parts). Upload:

```
gh release upload 0.49 dist/shear-wallet-0.49-windows.zip --repo rgsneddon/shear-testnet --clobber
```

Android fat APK (not `--split-per-abi`):

```
set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
flutter build apk --release --build-name=0.49.0 --build-number=71
```

Or `bash pack/pack_android.sh` (`BUILD_NUMBER` defaults to 71). Asset `shear-wallet-0.49-android.apk`.

Linux / Arch, when packing on the Linux host:

```
flutter build linux --release --build-name=0.49.0 --build-number=71
```

`pack/zip_linux.sh` writes `shear-wallet-0.49-linux.zip` and `shear-wallet-0.49-archlinux.zip` (`pkgver=0.49`). macOS: `pack_macos.sh` on the MacBook (`CONTINUUM-0.46-MAC-HANDOFF.md` for notarize). No miner inside any wallet zip.

## What changed

Live `GET /api/wallet/balance?address=<hasher ssa1>` is already dust (~9.78e-5 SHE) on pool `b35c5f4`. Continuum 0.48 still invented:

- Sealed note scan preferred a fatter `amount` over `nanos` (pot-after-fee on a hash vout).
- Those hash folds were queued and `settleTo` added them on the next tip, after a good snapshot.
- Unlock summed cached blockfound rows (pot + hash) back into Spendable. `rememberSpendable` only ever raised that number.
- A 504 / timeout / HTML body was swallowed and treated as a finished sync, so the invent was what got saved.

0.49 pins Spendable to the balance that actually landed. Owed-π / confirming pot stay on the owed line. A missed pull does not replace the pin and does not count as sync done. In Reserve is untouched.

## Acceptance

Hasher mining dest only:

`ssa1q4ws2yd6xsedd7q0drkeup2c9wvan4xmps3zcglnz65nqvakrngcyv6xuylekk0rza8uusg9uzfdcktz6a5hq94gmp5`

1. Install **0.49.0** (window title `Shear 0.49.0`), not the 0.48 zip.
2. Unlock and wait until tip sync shows the live height.
3. `GET https://pool.shear.digital/api/wallet/balance?address=<dest above>` `balance` is the honest dust (hash notes + any real pool-withdraw, not pot-class SHE).
4. Continuum **Spendable** matches that balance (about `0.000097800` SHE while the dest is still dust). It must not show N × ~0.99 SHE.
5. **Owed toward π** may be non-zero. It is not added into Spendable.
6. Lock the app, unlock again (or let the next poll run). Spendable stays on that balance. A hung pool (504) must not jump it back to the pot sum.
7. In Reserve, if it already shows an honest lock (for example 35 SHE), leave it. That figure is not Continuum Spendable.
8. Do not compare Spendable to the miner hashbonus HUD.
