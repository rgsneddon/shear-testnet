# MacBook handoff — Shear Sentinel v15 and Continuum 0.65 (Apple only)

Two Apple files. Do not mix the tags. This machine uploads only these two files onto tags that already exist. It does not replace the Windows, Linux, Arch, Fedora, or OpenSUSE assets already on those tags.

| Product | File | GitHub tag |
|---|---|---|
| Shear Sentinel v15 | `shear-node-v15-macos.zip` | `v15` |
| CONTINUUMv0.65 | `shear-wallet-0.65-macos.dmg` | `0.65` |

**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md
**Also:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Repo:** https://github.com/rgsneddon/shear-testnet · **branch:** `main`
**Book:** `shear-testnet-v10`. Datadir `~/.shear/testnet-v10` (Windows `%APPDATA%\Shear\testnet-v10`). One process at a time on :30303 / :18332.

**Already on tag `v15` (do not rebuild, do not pass `--clobber`):** `shear-node-v15-windows.zip`, `shear-node-v15-linux.zip`, `shear-node-v15-archlinux.zip`, `shear-node-v15-fedora.zip`, `shear-node-v15-opensuse.zip`.

**Already on tag `0.65` (do not rebuild, do not pass `--clobber`):** `shear-wallet-0.65-windows.zip`, `shear-wallet-0.65-linux.zip`, `shear-wallet-0.65-archlinux.zip`, `shear-wallet-0.65-fedora.zip`, `shear-wallet-0.65-android.apk`.

**Do not move:** `0.52`–`0.64`, `v6`, `v7`, `v8`, `v9`, `v10`, `v11`, `v12`, `v13`, `v14`. Tags `0.60` and `v10` stay. Do not move tag `v7`, tag `v9`, tag `v12`, tag `v14`, or tag `0.64`.
**Do not build here:** Windows / Linux / Arch / Fedora / OpenSUSE zips or the Android apk.
**Do not restyle the live site.** Pin strings on shear.digital are Continuum **0.65**, node **v15**, and ShearK **2.6**. Do not edit shear.digital from this machine.
**Miner:** ShearK **2.6** stays on https://github.com/rgsneddon/ShearK/releases/tag/2.6. Do not cut a new miner from this handoff. Do not put ShearK inside the disk image.

`node/pack/zip_node.py` (what `pack_macos.sh` calls) must ship `node/src`, `crypto`, `node_modules`, `pool/src/wallet_api.js`, `pool/src/hash_credit.js`, `pool/src/withdraw_state.js`, and `contracts/Reserve.json`. RPC imports `wallet_api.js`; `reserve_evm.js` reads `Reserve.json` at boot. Without those files the unzipped node exits 1. `crypto/native/shearhash.node` in this zip must be Mach-O built on this Mac.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. `wallet/pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`. Do not ship a zip of the `.app`.

`PRODUCT_VERSION` in `crypto/asert.js` is **15.0** (Shear Sentinel v15). Continuum pin is `kWalletVersion = '0.65'`. Do not set `PRODUCT_VERSION` to `0.65` or to `0.64` or to `0.62` or to `12.0` or to `11.0` or `0.61`. `consensusFingerprint()` must not contain `15.0`, `14.0`, `13.0`, `12.0`, `11.0`, `10.0`, `9.0`, `8.0`, `7.0`, `0.65`, `0.64`, `0.62`, `0.61`, `0.60`, `0.59`, `0.58`, `0.57`, `0.56`, or `PRODUCT_VERSION`.

`node/pack/pack_macos.sh` reads that pin and refuses anything other than `15.0`. The zip it checks is `dist/shear-node-v15-macos.zip`.

---

## 0. Pull

```bash
git checkout main
git pull
grep "PRODUCT_VERSION" crypto/asert.js
# must print: export const PRODUCT_VERSION = '15.0';
grep MAGIC_TESTNET_V10 crypto/asert.js
# must print: export const MAGIC_TESTNET_V10 = 'shear-testnet-v10';
npm ci
```

If `gh release view v15 --repo rgsneddon/shear-testnet` or `gh release view 0.65 --repo rgsneddon/shear-testnet` is missing, stop. Do not create a new tag. Do not move tag `v7`.

---

## 1. Shear Sentinel v15

```bash
sh node/pack/pack_macos.sh
unzip -l dist/shear-node-v15-macos.zip | grep -E 'wallet_api.js|Reserve.json|shearhash.node'
gh release upload v15 dist/shear-node-v15-macos.zip --repo rgsneddon/shear-testnet
```

No `--clobber`. Native addons must be Darwin. Do not upload this zip onto tag `v7`, tag `v9`, tag `v10`, tag `v12`, or tag `v14`.

---

## 2. CONTINUUMv0.65

The disk image is the GUI. It does not contain the node tree. The Sentinel zip from section 1 is the node.

```bash
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.65';

cd wallet
BUILD_NUMBER=90 SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

Writes `wallet/dist/shear-wallet-0.65-macos.dmg`. Empty book does **not** auto-pull a bootstrap.

```bash
gh release upload 0.65 dist/shear-wallet-0.65-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach Windows, Android, Linux, Arch, Fedora, or OpenSUSE files from this machine.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 9. Hash bonus unit stays 1 nano.
- Public pages stay SaaS dark.
- Do not bounce `shear-pool`. Do not delete `chain.bin`.
- `SYNC_POOL_WALLET=0`.
