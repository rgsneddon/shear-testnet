# Windows handoff — FINAL PLATE laws the Mac did not refute

**Read this file and apply it.** Continuum stays **0.55**. Do not cut **0.56**.

**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/WINDOWS-HANDOFF.md
**Mac pin note:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Repo:** https://github.com/rgsneddon/shear-testnet
**Branch to pack:** `main`
**Pin:** Continuum **0.55** (`kWalletVersion` `0.55.0`, pubspec `0.55.0+77`)

The Mac ran the FINAL PLATE wallet suites once on 2026-09-27. Both files finished together: **28 passed, 0 failed, exit 0**. That run is not a refutation. Leave those tests and the wallet paths they lock. Pack the Windows zip. Do not rewrite a plate to match a stale line number.

---

## What the Mac already proved

Command, from `wallet/`, Flutter 3.44.6:

```
flutter test test/plate1_wallet_test.dart test/plate_053_test.dart --reporter expanded
```

Result: `All tests passed!` at `+28`, about 98 seconds, exit 0. Wallet Dart sources under test were the `main` tree at `14265cc` (handoff commit on top of 0.55 source `82aa362`). Do not redo those tests by editing them. Re-run the same two files after `git pull`. A pass means stop. A failure is a Windows toolchain problem to report, not a reason to change the plate.

After that run, `main` moved to `0074816` — “Remove the Reddit button from Continuum 0.55.” That is the last wallet-client change. The pin stays 0.55. Discord, Telegram, and X stay. Do not restore the Reddit button, `kRedditUrl`, or the reddit hosts. The FINAL PLATE run did not cover that button. `wallet/test/shear_wallet_test.dart` on `main` is the check. Pull `0074816` (and anything after it) before the Windows build.

`plate_053` on `82aa362` had already passed twice (`+5` / `+5`) before this run. This Mac ran it again inside the same 28.

### `wallet/test/plate1_wallet_test.dart` (23)

- next owed sum matures in 6 seconds
- a pi deposit unlocks a vote and the plurality wins at epoch end
- vote fail copy is human and the vote post carries spendSeed
- vote fee hops off the mining mailbox when it is the only cover
- flow spend refuses the mining mailbox and uses another covering dest
- 70 plus 61 consolidates to one lock from; shortfall names need and have
- parseReceiveQr accepts full she1 and ssa1 and leaves To on a fingerprint
- closure Apply defaults to Connect bare, Android drops C, and B does not arm 1111
- VPN down blocks public send with the exact string and probe-up does not claim a mask
- shared node binary is the file beside Continuum
- sidecar Apply arms 1111 only for desktop C and stops on A
- Resistance Start arms one syncing node and Stop returns to Connect bare
- Resistance Start resumes the saved tip and Stop keeps the book
- closureSendMode round-trips and does not write continuumSendPath
- Apply switches the chip and shows the Resistance console
- a stored VPN session opens Connect bare and the send is not held for a tunnel
- Deposit sum consolidates 70+61 into a non-mailbox lock of 100
- Deposit sum locks max spendable minus levy from split notes
- Cast vote posts spendSeed and shows the submitted snack
- default tunnel is IPv4 and IPv6 with extended controls off
- the VPN tunnel switch is gone and Run node does not raise a hop
- Resistance Start and Stop stay on the heading
- Restore Privacy vort1 opens the client with extended controls off

### `wallet/test/plate_053_test.dart` (5)

- reserve deposit posts from the painted figure when notes do not cover
- reserve deposit refuses when the painted figure does not cover amount plus fee
- a refused pool post restores the painted figure
- continuum send and receive use the full payable address
- local node spawn has no bootstrap URL and the light seeker stays strict

`plate_053` starts `node pool/tests/painted_gate_server.mjs` from the repo root (the test computes that root when the working directory is `wallet/`). Do not rewrite that path.

---

## Laws those plates lock (apply by leaving them)

- Connect bare is the path. The VPN tunnel switch stays gone. Run node does not raise a hop. A stored VPN session still opens Connect bare, and a public send is not held for a tunnel.
- Resistance Start arms one syncing node, resumes the saved tip, and Stop keeps the book and returns to Connect bare. Start and Stop stay on the heading.
- Deposit sum consolidates 70+61 into one non-mailbox lock of 100. A shortfall names need and have. The mining mailbox is not the lock source when another dest covers.
- Vote posts carry `spendSeed`. The Cast vote snack is the submitted copy. The vote fee leaves the mining mailbox when that mailbox is the only cover.
- A full `she1` and `ssa1` parse as payable. A short `she1` fingerprint stays in To and is not paid.
- Closure Apply defaults to Connect bare. Android drops C. B does not arm 1111. Sidecar Apply arms 1111 only for desktop C and stops on A. `closureSendMode` round-trips and does not write `continuumSendPath`.
- Default tunnel routes are IPv4 `0.0.0.0/0` and IPv6 `::/0`, extended controls off. `deviceApproval` stays in `windows/runner/flutter_window.cpp`.
- Restore Privacy `vort1` opens with extended controls off.
- Painted reserve deposit posts from the painted figure when notes do not cover, refuses when that figure does not cover amount plus fee, and a refused pool post restores the painted figure.
- Continuum send and receive use the full payable address.
- Local node spawn has no bootstrap URL. The light seeker stays strict.
- Next owed sum matures in 6 seconds. A pi deposit unlocks a vote and the plurality wins at epoch end.
- The shared node binary is the file beside Continuum.

Do not restore a hop server. Do not put ShearK inside the wallet zip.

---

## Apply on this box

The publication clone `C:\Users\rgsne\shear-pool-node` was dirty on top of `82aa362` with a **0.56** draft. Discard that draft. Do not commit it. Do not point a link at `releases/tag/0.56`.

```
cd /d %USERPROFILE%\shear-testnet
git fetch origin
git checkout main
git pull
cd wallet
flutter test test\plate1_wallet_test.dart test\plate_053_test.dart
```

If those 28 pass, do not edit the two files. Then pack only the Windows GUI zip. `zip_windows.py` reads `kWalletVersion` and writes `wallet\dist\shear-wallet-0.55-windows.zip` (public pin is major.minor).

```
cd /d %USERPROFILE%\shear-testnet\wallet
flutter config --enable-windows-desktop
flutter pub get
flutter build windows --release --build-name=0.55.0 --build-number=77
cd /d %USERPROFILE%\shear-testnet
python wallet\pack\zip_windows.py
```

Zip root is `shear_wallet.exe`. No miner inside. Title string is Shear **0.55.0**.

Upload only after tag **0.55** exists. Do not create tag **0.56**. Do not move tags **0.52**, **0.53**, or **0.54**.

```
gh release upload 0.55 wallet\dist\shear-wallet-0.55-windows.zip --repo rgsneddon/shear-testnet --clobber
```

If `gh release view 0.55` says the release is missing, stop and leave the zip on disk. The Mac cuts tag `0.55` and the release name `Continuum 0.55.0`. Attaching the Windows zip to that existing release is the job. Creating the tag from this box is not.

---

## This box does not do

- Rebuild the macOS disk image. The Mac packs `shear-wallet-0.55-macos.dmg`.
- `flutter build macos` or notarize.
- Bump `kWalletVersion`, `PRODUCT_VERSION`, or pubspec to 0.56.
- Restore the Reddit button.
- Put `0.55` inside `consensusFingerprint()`.
- Change `HASH_BONUS_NANOS`, the 256 share floor, or spendable depth (`isSpendableHeight(100, 105)` stays true).
- Reset the chain, delete `chain.bin`, or bounce `shear-pool` or the bootstrap publisher.
- scp a whole HTML file onto shear.digital, or reload nginx for a pin string.
- Treat `wallet/pubspec.lock` drift from a Mac `flutter pub get` as a plate change. Do not commit a downgrade of `matcher`, `meta`, `test_api`, or `vector_math`.
- Set `wallet/pack/archlinux/PKGBUILD` `pkgver` back to `0.54`. `shear-wallet-0.55-linux.zip` is on release `0.55`, and `pkgver` is `0.55`.

One macOS compile line is separate from the plates: under Xcode 27, `MainFlutterWindow.swift` must call `Darwin.close(fd)` because `NSWindow.close` shadows the socket call. Windows does not need that line to link the PE. If it is on `main` when you pull, leave it.
