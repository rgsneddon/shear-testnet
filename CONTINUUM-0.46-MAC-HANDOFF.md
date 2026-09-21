# Continuum 0.46 + ShearK 2.5 — MacBook only (Apple parts)

The MacBook cuts **every Apple-only artifact**. The Windows box packs Windows zip, Android APK, Linux/Arch, and site pins.

**Wallet repo:** https://github.com/rgsneddon/shear-testnet  
**Wallet tag:** `0.46` — https://github.com/rgsneddon/shear-testnet/releases/tag/0.46  
**Miner repo:** https://github.com/rgsneddon/ShearK  
**Miner tag:** `2.5` — https://github.com/rgsneddon/ShearK/releases/tag/2.5  
**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/CONTINUUM-0.46-MAC-HANDOFF.md

Developer ID: `Russell Sneddon (SFCBP95595)`. Unsigned / un-notarized `.app` / `.dmg` / Mach-O Gatekeeper-blocks. Do not ship a zip of the wallet app.

This cut fixes Reserve when Continuum already shows spendable SHE. The hop-fee send collates a sealed note before it spends, and an empty note book no longer claims a cover it cannot spend. Pool HTML error pages surface as an error page with the HTTP status, not a FormatException. A successful Reserve lock says Sent — please wait 6 confirmations. Kind=lock stays sealed. Fee stays 0.05 SHE. Do not recut 0.45. Do not recut ShearK.

---

## A) Continuum 0.46 macOS GUI (notarized `.dmg`)

On the Mac (`/Users/russellsneddon/shear` or a clone):

```
git clone https://github.com/rgsneddon/shear-testnet.git ~/shear-testnet
cd ~/shear-testnet
git checkout main
git pull
cd wallet
flutter --version            # 3.44.6+ is fine
brew list libsodium >/dev/null || brew install libsodium
PACK_REBUILD=1 ./pack_macos.sh
python3 pack/sign_and_notarize.py
# writes wallet/dist/shear-wallet-0.46-macos.dmg
gh release upload 0.46 dist/shear-wallet-0.46-macos.dmg --repo rgsneddon/shear-testnet --clobber
```

- **Install:** open the disk image, drag Shear into Applications, eject, launch from Applications. Do not keep running it from the image, a zip, or Downloads.
- **Arch:** `lipo -archs Shear.app/Contents/MacOS/shear_wallet` (universal or arm64).
- Wallet must **not** bundle ShearK.

URL: `https://github.com/rgsneddon/shear-testnet/releases/download/0.46/shear-wallet-0.46-macos.dmg`

Then on `main`, replace any remaining site span `macOS — coming soon` with that href.

## B) Continuum 0.46 macOS CLI

Windows cannot emit a Darwin Mach-O.

```
cd ~/shear-testnet/wallet
dart compile exe bin/shear.dart -o dist/shear-0.46-macos
chmod +x dist/shear-0.46-macos
./dist/shear-0.46-macos --version    # 0.46
gh release upload 0.46 dist/shear-0.46-macos --repo rgsneddon/shear-testnet --clobber
```

Codesign + notarize the CLI if Gatekeeper blocks (`codesign -s "Developer ID Application: Russell Sneddon (SFCBP95595)" --options runtime`).

## C) iOS (same MacBook session, only if cutting)

The Windows box cannot produce an IPA. If this 0.46 cut includes iOS:

```
cd ~/shear-testnet/wallet
flutter build ipa --release --build-name=0.46.0 --build-number=63
# Xcode Organizer → Distribute App (Developer ID / App Store as decided)
```

Do **not** link a missing `.ipa` on the site. Fat sideload APK is Windows; iOS is Apple-only.

## D) ShearK-Miner 2.5 for Mac

Official miner is a **separate** ShearK release — never inside the wallet. Windows already ships `ShearK-Miner-2.5-windows.zip`. Linux is packed on `77.42.91.84`. **macOS miner is MacBook-only.** Pin stays **2.5**. Do not recut it for this wallet cut.

```
git clone https://github.com/rgsneddon/shear-testnet.git ~/shear-testnet
cd ~/shear-testnet
git checkout main
git pull
cd sheark-miner
make clean
make
./ShearK-Miner --selftest
# digest 98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b
codesign -s "Developer ID Application: Russell Sneddon (SFCBP95595)" --options runtime --timestamp ShearK-Miner
mkdir -p dist/macos
cp ShearK-Miner example.sh dist/macos/
# example.sh: set --threads $(sysctl -n hw.ncpu)
(cd dist/macos && zip -9 ../../ShearK-Miner-2.5-macos.zip ShearK-Miner example.sh)
gh release upload 2.5 ShearK-Miner-2.5-macos.zip --repo rgsneddon/ShearK --clobber
```

Zip root: `ShearK-Miner` + `example.sh` (same layout as linux; run with `--threads $(sysctl -n hw.ncpu)`). Notarize the zip/binary if Gatekeeper still blocks (`xcrun notarytool`). Do not recut ShearK **2.4**.

URL: `https://github.com/rgsneddon/ShearK/releases/download/2.5/ShearK-Miner-2.5-macos.zip`

After it 200s, add a macOS row on the ShearK README downloads table (same MacBook PR or a follow-up on `rgsneddon/ShearK`).

## E) Do not pack on the MacBook

Windows zip, Android APK, Linux/Arch wallet zips, Linux ShearK zip — those stay on the Windows box / `77.42.91.84`. Do not bounce the pool, node, or miner for this wallet cut.

## Version

Wallet public pin **0.46** (`kWalletVersion` / `kCliVersion`), store `0.46.0+63`. Miner pin **ShearK 2.5**.
