# MacBook handoff — Continuum 0.68 and Shear Sentinel v17 (Apple only)

**You cut the Continuum disk image on this Mac and upload that file onto release `0.68`.** Do not pass `--clobber`. Do not rebuild the Windows, Android, Linux, Arch, Fedora, or OpenSUSE packs on this Mac. The node zip is not uploaded from here.

| Product | File | GitHub tag | Release name |
|---|---|---|---|
| Continuum 0.68 | `shear-wallet-0.68-macos.dmg` | `0.68` | Continuum 0.68 |
| Shear Sentinel v17 | `shear-node-v17-macos.zip` | `v17` | Shear Sentinel v17 |

**Repo:** https://github.com/rgsneddon/shear-testnet
**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Node steps (same cut):** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md
**Branch:** `main`. That branch contains `PRODUCT_VERSION = '17.0'` and `kWalletVersion = '0.68'`.
**Book:** `shear-testnet-v10`. Datadir `~/.shear/testnet-v10`. One process at a time on :30303 / :18332.

**Node pin is Shear Sentinel v17 (product 17.0).** Do not pass `--clobber`. Do not upload this zip onto `v15`. The six node packs are https://github.com/rgsneddon/shear-testnet/releases/tag/v17: `shear-node-v17-windows.zip`, `shear-node-v17-linux.zip`, `shear-node-v17-archlinux.zip`, `shear-node-v17-fedora.zip`, `shear-node-v17-opensuse.zip`, and `shear-node-v17-macos.zip`. Git tag `v16` stays on the same commit as tag `0.66`. Do not move tag `v16`.

**Previous tag `0.66` stays.** Do not move tag `0.67`. Do not move tag `0.66`. Do not upload a 0.68 file onto `0.67`, `0.66`, or `0.65`.

**Do not move:** `0.52` through `0.66`, `v6` through `v15`. Tags `0.60` and `v10` stay.

**Do not build here:** Windows zip, Android apk, Linux zip, Arch zip, Fedora zip, OpenSUSE zip, ShearK.

**Miner:** ShearK **2.8** is the TLS-aware pin (`stratum+ssl://pool.shear.digital:443`). Localhost solo stays `stratum+tcp://127.0.0.1:1111`. Do not label a 2.6 rebuild as TLS-done. Do not put ShearK inside the disk image.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. Do not ship a zip of the `.app`. `wallet/pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`.

---

## Who packs the other files

This Mac does not. Linux is a VPS cut, not a Windows cut and not a Mac cut. The Windows build host has Flutter and no Xcode, and WSL has no distribution, so it cannot cut the `.dmg` or a Mach-O node zip either.

| Host | What it packs | How |
|---|---|---|
| Windows PC | `shear-node-v17-windows.zip`, `ShearK-Miner-2.8-windows.zip` (OpenSSL DLLs beside the exe), `shear-wallet-0.68-windows.zip`, fat `shear-wallet-0.68-android.apk` | `python node/pack/zip_node.py windows`, ShearK `zip_windows.py`, `flutter build windows --release` then `python wallet/pack/zip_windows.py`, `wallet/pack/pack_android.sh` |
| Linux VPS | `shear-wallet-0.68-linux.zip` and `shear-wallet-0.68-archlinux.zip` (Arch zip is the PKGBUILD plus that Linux bundle, which is what `pack_linux_de.sh` writes). Node `shear-node-v17-linux.zip` after `make -C crypto/native` on that host. | Side directory. Do not overwrite the live `/opt/shear-v4` tree and do not restart `shear-pool` or `shear-p2p` from this handoff. `SHEAR_WALLET` must point at the side tree. `pack_linux_de.sh` reads pubspec `+N` and refuses build number 49. |
| Fedora host | `shear-node-v17-fedora.zip` and a Fedora wallet zip only when `shearhash.node` / the GUI are built on Fedora | Do not rename an Ubuntu zip to fedora. |
| OpenSUSE host | `shear-node-v17-opensuse.zip` only when the native addon is built on OpenSUSE | Do not rename another distro's zip. |

`node/pack/zip_node.py` refuses to ship a Windows `.node` inside a Linux zip, and it refuses a Linux `.node` inside the Windows zip. Native addons in the macOS zip must be Mach-O built on this Mac.

The Android release keystore is not in git. `wallet/android/key.properties` is gitignored. One Continuum release cert is reused for every later publish. Debug-signed 0.65/0.66 needs one export, uninstall, then 0.68. Later upgrades stay in place. No login version phone-home.

---

## Pins that must match this cut

```
wallet/lib/main.dart:      kWalletVersion = '0.68'
wallet/lib/shear_cli.dart: kCliVersion = '0.68'
wallet/pubspec.yaml:       version: 0.68.0+93
crypto/asert.js:           PRODUCT_VERSION = '17.0'
crypto/asert.js:           MAGIC_TESTNET_V10 = 'shear-testnet-v10'
```

`PRODUCT_VERSION` is Shear Sentinel v17. It is **17.0**. Continuum is `0.67`. Do not set `PRODUCT_VERSION` to `16.0` or to `0.66`. `consensusFingerprint()` must not contain `17.0`, `16.0`, `0.68`, `0.67`, `0.66`, or `PRODUCT_VERSION`.

`node/pack/pack_macos.sh` refuses anything other than `17.0`. The zip it checks is `dist/shear-node-v17-macos.zip`. It must contain `pool/src/wallet_api.js`, `pool/src/posture.js`, `contracts/Reserve.json`, and a Mach-O `crypto/native/shearhash.node`.

`wallet/pack_macos.sh` reads the pubspec `+N` (93). It refuses build number 49. The disk image is the GUI. It does not contain the node tree and it does not contain ShearK. Empty book does not auto-pull a bootstrap.

---

## 0. Pull

```bash
git checkout main
git pull
grep "PRODUCT_VERSION" crypto/asert.js
# must print: export const PRODUCT_VERSION = '17.0';
grep MAGIC_TESTNET_V10 crypto/asert.js
# must print: export const MAGIC_TESTNET_V10 = 'shear-testnet-v10';
npm ci
```

The Continuum disk image uploads onto the existing GitHub release `0.68` at https://github.com/rgsneddon/shear-testnet/releases/tag/0.68. The node zip is an asset of https://github.com/rgsneddon/shear-testnet/releases/tag/v17 with the other five node flavors. Do not pass `--clobber`. Do not move tag `0.67`. Do not move tag `0.66`. Do not move tag `v16`.

---

## 1. Shear Sentinel v17

```bash
sh node/pack/pack_macos.sh
unzip -l dist/shear-node-v17-macos.zip | grep -E 'wallet_api.js|posture.js|Reserve.json|shearhash.node'
```

No `--clobber`. Native addons must be Darwin. This rebuild checks the Mach-O addon. The release workflow publishes this zip with the other five flavors on tag `v17`. Do not upload this zip from this machine. Do not upload this zip onto tag `v15`. Do not move tag `v16`. Tag `v16` stays on the same commit as tag `0.66`. The previous node zips on release `0.67` stay where they are.

---

## 2. Continuum 0.68

```bash
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.68';

cd wallet
SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

Writes `wallet/dist/shear-wallet-0.68-macos.dmg`.

```bash
gh release upload 0.68 dist/shear-wallet-0.68-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach Windows, Android, Linux, Arch, Fedora, or OpenSUSE files from this machine.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 9. Hash bonus unit stays 1 nano.
- Public pages stay SaaS dark.
- Do not put a fleet IP address in this file.
- Do not bounce `shear-pool`. Do not delete `chain.bin`. Do not restamp a tip stall.
- `SYNC_POOL_WALLET=0`.
- Do not rotate the live fee-payout ssa1 from this handoff. Russell pins that later.
- Book stays `shear-testnet-v10`. A version bump alone does not wipe the wallet.
