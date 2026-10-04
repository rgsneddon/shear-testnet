# MacBook handoff — Continuum 0.70 disk image only

The only file this Mac builds and uploads is `shear-wallet-0.70-macos.dmg`.

Do not build Shear Sentinel. Do not build ShearK. Do not cut a node zip. Do not cut a miner.

**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md

**Repo:** https://github.com/rgsneddon/shear-testnet

**Branch:** `feat/continuum-067-master`. Do not build parent `dbb460eaef10e75bdeb7a809e7ac3058a9e67ef2`. That commit is before this wallet. The tip is the commit that contains this file and `kWalletVersion = '0.70'`. After `git pull`, `git rev-parse HEAD` is the tip.

**Checked on the Windows build host, 2026-10-04.** Flutter is installed. `xcodebuild` is not. This host cannot emit a Mach-O binary or a Continuum `.dmg`. `shear-wallet-0.70-macos.dmg` is absent here. Cut that disk image on the Mac with the commands below. Do not invent it on Windows and do not upload it from Windows.

## Pins

| What | Pin |
|------|-----|
| Wallet | Continuum 0.70, `kWalletVersion = '0.70'`, pubspec `0.70.0+95` |
| Book | `shear-testnet-v10` |
| Node | Shear Sentinel v17, product is **17.0**, already published at https://github.com/rgsneddon/shear-testnet/releases/tag/v17. Do not build Shear Sentinel on this Mac. The Apple library still needs that v17 node pin. |
| Miner | ShearK 2.8 is already published. Do not build ShearK on this Mac. The Apple library still needs ShearK 2.8. |
| Wallet release | https://github.com/rgsneddon/shear-testnet/releases/tag/0.70 |
| Tag `0.68` | Stays at `a3769db773a273c79567a3f3f451e2e973b06e21`. Do not move it. Do not upload onto it. Do not pass `--clobber`. |
| Tag `v16` | Git tag `v16` stays on the same commit as tag `0.66`. Do not move tag `v16`. Do not move tag `0.66`. |

`PRODUCT_VERSION` in `crypto/asert.js` is **17.0**. Do not set it to `18.0`, `16.0`, or `0.70`. `consensusFingerprint()` must not contain `17.0`, `18.0`, `16.0`, `15.0`, `0.70`, `0.68`, `0.67`, `0.66`, or `PRODUCT_VERSION`.

Block reward stays 1 SHE plus the hash bonus. Do not edit reward law. Do not wipe a datadir. Do not copy `tip.json` or a chain file. There is no version phone-home. Do not bounce `shear-pool`.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. `wallet/pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`. Do not ship a zip of the `.app`. The wallet pack script reads pubspec `+N` (95). It refuses build number 49.

## Node inside the app

The previous disk image had no node inside. This cut must. Connect bare, p2p node, and full node all use the runtime packed into `Shear.app/Contents/MacOS`: `runtime/node` plus `node/src/node.js`, the same idea as the Windows zip beside the executable.

Before the first pack, build the Mac native addon so `crypto/native/shearhash.node` exists (`make -C crypto/native shearhash.node` after the randomx cmake build). `wallet/pack/stage_macos_sidecar.py` copies that addon into the app. Do not copy an addon built on another OS. Do not cut a node zip. Do not attach a node archive. Do not build Shear Sentinel. Do not build ShearK. The Shear Sentinel v17 pack and the ShearK 2.8 pack stay isolated. This handoff does not change those builds.

The first `pack_macos.sh` stages that runtime before codesign. `pack/sign_and_notarize.py` signs `runtime/node` with the app. The second pack finds `runtime/node` already present and does not copy it again.

## Build, sign, pack

```sh
git clone https://github.com/rgsneddon/shear-testnet.git
cd shear-testnet
git checkout feat/continuum-067-master
git pull
git grep -n "kWalletVersion = '0.70'" wallet/lib/main.dart
cd wallet
SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
python3 pack/sign_and_notarize.py
SYNC_POOL_WALLET=0 bash pack_macos.sh
```

The first `pack_macos.sh` builds the app and stages the in-app node. `pack/sign_and_notarize.py` seals that app with Developer ID, submits it with notarytool, and staples the ticket. The second `pack_macos.sh` does not rebuild, because `PACK_REBUILD` is unset, and copies the sealed app with `ditto`. Passing `PACK_REBUILD=1` after signing replaces the seal. Do not pass `--clobber`.

Writes `wallet/dist/shear-wallet-0.70-macos.dmg`. Empty book does not auto-pull a bootstrap. `SYNC_POOL_WALLET=0`.

## Upload

The disk image uploads onto the new GitHub release `0.70` at https://github.com/rgsneddon/shear-testnet/releases/tag/0.70. Create that release if it does not exist yet. Do not pass `--clobber`. Do not upload onto tag `0.68`.

```sh
gh release upload 0.70 dist/shear-wallet-0.70-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach Windows, Android, Linux, Arch, Fedora, or OpenSUSE files from this machine. Do not attach a node archive. Do not attach a miner.

## Smoke

Attach the disk image. The short version string is 0.70. Open Shear. The window title is Shear 0.70. Connect bare works. p2p node and full node start the runtime inside the app. Quit. Do not populate a datadir from this handoff.

```sh
hdiutil attach dist/shear-wallet-0.70-macos.dmg
# CFBundleShortVersionString is 0.70
# Contents/MacOS/runtime/node and Contents/MacOS/node/src/node.js are inside the app
# codesign -dv --verbose=4 shows Developer ID Application: Russell Sneddon (SFCBP95595)
# xcrun stapler validate the sealed app
hdiutil detach "/Volumes/Shear 0.70"
```

## Gaps

- This Windows host did not codesign, notarize, or upload the dmg.
- Tag `0.68` is not moved.
- Shear Sentinel stays v17. ShearK stays 2.8. Magic stays `shear-testnet-v10`.
- Do not pass `--clobber`.
- Until this Mac pack runs, no published disk image contains the node runtime.

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 9. Hash bonus unit stays 1 nano.
- Public pages stay SaaS dark.
- Do not bounce `shear-pool`. Do not delete `chain.bin`.
- Do not rotate the live fee-payout ssa1 from this handoff.
