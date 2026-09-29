# MacBook handoff — Continuum 0.62 and Shear Sentinel v12 (Apple only)

**You cut two Apple files.** Windows, Android, Linux, Arch, Fedora, and OpenSUSE wallet/node zips are built elsewhere. This machine does not upload the Apple files.

| Product | File | GitHub tag | Release name |
|---|---|---|---|
| CONTINUUMv0.62 | `shear-wallet-0.62-macos.dmg` | `0.62` | Continuum 0.62 |
| Shear Sentinel v12 | `shear-node-v12-macos.zip` | `v12` | Shear Sentinel v12 |

**Repo:** https://github.com/rgsneddon/shear-testnet
**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Branch:** `main`
**Do not move:** `0.52`, `0.53`, `0.54`, `0.55`, `0.55.1`, `0.55.2`, `0.56`, `0.57`, `0.58`, `0.59`, `0.60`, `0.61`, `v6`, `v7`, `v8`, `v9`, `v10`, `v11`. Do not move tag `v7` or tag `v9`.
**Do not create** those old tags. Windows creates `0.62` (wallet) and `v12` (node) with the non-Mac assets. If a tag is missing, stop.
**Do not build here:** Windows zip, Android apk, Linux zip, Arch zip, Fedora zip, OpenSUSE zip
**Do not restyle the live site.** Download links on shear.digital pin Continuum **0.62**, Shear Sentinel v12, and ShearK **2.6**.
**Miner:** ShearK **2.6** stays on https://github.com/rgsneddon/ShearK/releases/tag/2.6. Do not cut a new miner from this handoff.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. Do not ship a zip of the `.app`. `pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`.

---

## Pins that must match `main`

```
wallet/lib/main.dart:     kWalletVersion = '0.62'
wallet/lib/shear_cli.dart: kCliVersion = '0.62'
wallet/pubspec.yaml:      version: 0.62.0+87
crypto/asert.js:          PRODUCT_VERSION = '12.0'
```

`PRODUCT_VERSION` is the node (Shear Sentinel v12). Continuum is `0.62`. Do not set `PRODUCT_VERSION` to `0.62` or to `11.0` or `0.61`.

`consensusFingerprint()` does **not** contain `0.52`, `0.53`, `0.54`, `0.55`, `0.55.1`, `0.55.2`, `0.56`, `0.57`, `0.58`, `0.59`, `0.60`, `0.61`, `0.62`, `7.0`, `8.0`, `9.0`, `10.0`, `11.0`, `12.0`, or `PRODUCT_VERSION`. Do not edit the fingerprint array.

`wallet/pack_macos.sh` names the image from `kWalletVersion`, so a stock run writes `shear-wallet-0.62-macos.dmg`. Set `BUILD_NUMBER=87` to match pubspec `0.62.0+87`.

The GUI sidecar is Shear Sentinel v12 (`runtime/node` + `node/src/node.js`). Empty book does **not** auto-pull `boot.shear.digital`. Users who want a snapshot import it by hand.

Shared book with the standalone node: macOS `~/.shear/testnet-v7`. Windows `%APPDATA%\Shear\testnet-v7` (Roaming). Do not spawn a second node if one is already on 18332.

---

## Build Continuum 0.62

```bash
git pull
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.62';

cd wallet
BUILD_NUMBER=87 SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

Writes `wallet/dist/shear-wallet-0.62-macos.dmg`.

If `gh release view 0.62 --repo rgsneddon/shear-testnet` does not list the release, stop.

```bash
gh release upload 0.62 dist/shear-wallet-0.62-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach non-Mac wallet files from this machine. Public pages do not link the disk image until that upload exists. Restore the download href on shear.digital in the same cut.

---

## Build Shear Sentinel v12

```bash
cd /path/to/shear-testnet
sh node/pack/pack_macos.sh
```

Writes `dist/shear-node-v12-macos.zip`. The zip must contain `pool/src/wallet_api.js` and `contracts/Reserve.json` (RPC and Reserve pin at boot).

If `gh release view v12 --repo rgsneddon/shear-testnet` does not list the release, stop. Do not move tag `v7`.

```bash
unzip -l dist/shear-node-v12-macos.zip | grep -E 'wallet_api.js|Reserve.json'
gh release upload v12 dist/shear-node-v12-macos.zip --repo rgsneddon/shear-testnet
```

Native addons must be Darwin. No `--clobber`. Do not upload this zip onto tag `v7`, tag `v9`, or tag `v10`.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 9. `isSpendableHeight(100, 108)` is true. `isSpendableHeight(100, 105)` is false.
- Hash bonus unit stays 1 nano. One share floor stays 256 units.
- VPN tunnel stays out of the wallet UI.
- Public pages stay SaaS dark.
- Do not put a fleet IP address in this file or in a public page.
- Do not bounce `shear-pool` from the Mac. Do not delete `chain.bin`.
- Do not run `sync_pool_wallet.sh`. Set `SYNC_POOL_WALLET=0`.
