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

Pool `b35c5f4` `reconstructOwner` already returns the hasher's mature notes. It does not paint pot-after-fee onto that dest. `GET /api/wallet/balance` is `balance` plus a separate `owedPi` / `confirmingPot`. Continuum Spendable is `spendableOwned`, the sum of those balance writes. It does not read admin `custodyDisplay` or the pool dest's pot. The accrual tick repaints when that owned sum changes, including when a sibling dest is corrected and the mailbox figure stays put.

Fail-closed bars for this cut (pool custody). `bindSpendable` is not the fix; a landed book ignores it.

- FC-CC1. `applyPoolSnapshot` overwrites `_spendable[dest]` with `json.balance`. It does not max or merge a cached invent.
- FC-CC2. A 504, timeout, or HTML body is not force-sync done. `creditSyncLanded` is true only when every owned dest's live balance wrote in that sweep.
- FC-CC3. Sealed nanos win over a fatter note `amount`. After the sweep, Spendable equals the live balances, not the local note book.
- FC-CC4. Under a pool, `/api/wallet/balance` is the spendable authority. Hash folds and `settleTo` do not add a second pot reconstruct onto a pinned dest.
- FC-CC5. A shewall/archive that contains `poolBook` does not sum landing history into Spendable. `rememberSpendable` cannot raise a pinned dest.
- FC-CC6. One sweep overwrites every owned dest that answered, and zeroes an owned dest that has no live write and no prior pin. A sibling 504 does not leave that dest's invent in the sum, and does not mark the sweep done.

Reserve (35 SHE, the honest lock) stays on the portal. This cut does not debit it to chase Spendable.

- Sign on Reserve withdraw does not call `creditReserve` and does not clear the portal. Continuum posts `kind: withdraw` and adds principal plus interest only after the pool returns that withdraw tx. A local or refused post leaves both books as they were. The CLI `claim` command does not settle the portal.
- An archive with no `poolBook` debits confirmed locks from the source dest and does not pay the vault dest back into Spendable. When `poolBook` is present, history is not summed.

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
