# MacBook handoff — Continuum 0.56 and SHEAR-NODEv7 (Apple only)

**You cut two Apple files.** Windows, Android, Linux, Arch, Fedora, and OpenSUSE wallet/node zips are built elsewhere.

| Product | File | GitHub tag | Release name |
|---|---|---|---|
| CONTINUUMv0.56 | `shear-wallet-0.56-macos.dmg` | `0.56` | Continuum 0.56 |
| SHEAR-NODEv7 | `shear-node-v7-macos.zip` | `v7` | SHEAR-NODEv7 |

**Repo:** https://github.com/rgsneddon/shear-testnet
**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Branch:** `main`
**Do not move:** `0.52`, `0.53`, `0.54`, `0.55`, `0.55.1`, `0.55.2`, `v6`
**Do not create** those old tags. Windows creates `0.56` (wallet) and `v7` (node) with the non-Mac assets. If a tag is missing, stop.
**Do not build here:** Windows zip, Android apk, Linux zip, Arch zip, Fedora zip, OpenSUSE zip
**Do not restyle the live site.** Download links on shear.digital pin Continuum **0.56** and SHEAR-NODEv7.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. Do not ship a zip of the `.app`. `pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`.

---

## Pins that must match `main`

```
wallet/lib/main.dart:     kWalletVersion = '0.56'
wallet/lib/shear_cli.dart: kCliVersion = '0.56'
wallet/pubspec.yaml:      version: 0.56.0+81
crypto/asert.js:          PRODUCT_VERSION = '7.0'
```

`PRODUCT_VERSION` is the node (SHEAR-NODEv7). Continuum is `0.56`. Do not set `PRODUCT_VERSION` to `0.56`.

`consensusFingerprint()` does **not** contain `0.52`, `0.53`, `0.54`, `0.55`, `0.55.1`, `0.55.2`, `0.56`, `7.0`, or `PRODUCT_VERSION`. Do not edit the fingerprint array.

`wallet/pack_macos.sh` names the image from `kWalletVersion`, so a stock run writes `shear-wallet-0.56-macos.dmg`. Set `BUILD_NUMBER=81` to match pubspec `0.56.0+81`.

The GUI sidecar is SHEAR-NODEv7 (`runtime/node` + `node/src/node.js`). Empty book does **not** auto-pull `boot.shear.digital`. Users who want a snapshot import it by hand.

Shared book with the standalone node: macOS `~/.shear/testnet-v5`. Windows `%APPDATA%\Shear\testnet-v5` (Roaming). Do not spawn a second node if one is already on 18332.

---

## Build Continuum 0.56

```bash
git pull
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.56';

cd wallet
BUILD_NUMBER=81 SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

Writes `wallet/dist/shear-wallet-0.56-macos.dmg`.

If `gh release view 0.56 --repo rgsneddon/shear-testnet` does not list the release, stop.

```bash
gh release upload 0.56 dist/shear-wallet-0.56-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach non-Mac wallet files from this machine.

---

## Build SHEAR-NODEv7

```bash
cd /path/to/shear-testnet
sh node/pack/pack_macos.sh
```

Writes `dist/shear-node-v7-macos.zip`. The zip must contain `pool/src/wallet_api.js` and `contracts/Reserve.json` (RPC and Reserve pin at boot).

If `gh release view v7 --repo rgsneddon/shear-testnet` does not list the release, stop.

```bash
unzip -l dist/shear-node-v7-macos.zip | grep -E 'wallet_api.js|Reserve.json'
gh release upload v7 dist/shear-node-v7-macos.zip --repo rgsneddon/shear-testnet --clobber
```

Native addons must be Darwin. `--clobber` replaces only the macOS zip.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 6. `isSpendableHeight(100, 105)` is true.
- Hash bonus unit stays 1 nano. One share floor stays 256 units.
- VPN tunnel stays out of the wallet UI.
- Public pages stay SaaS dark.
- Do not put a fleet IP address in this file or in a public page.
- Do not bounce `shear-pool` from the Mac. Do not delete `chain.bin`.
- Do not run `sync_pool_wallet.sh`. Set `SYNC_POOL_WALLET=0`.
