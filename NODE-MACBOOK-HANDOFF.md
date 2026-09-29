# MacBook handoff — Shear Sentinel v12 and Continuum 0.62 (Apple only)

Two Apple files. Do not mix the tags. This machine does not upload them.

| Product | File | GitHub tag |
|---|---|---|
| Shear Sentinel v12 | `shear-node-v12-macos.zip` | `v12` |
| CONTINUUMv0.62 | `shear-wallet-0.62-macos.dmg` | `0.62` |

**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md
**Also:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Repo:** https://github.com/rgsneddon/shear-testnet · **branch:** `main`
**Do not move:** `0.52`–`0.61`, `v6`, `v7`, `v8`, `v9`, `v10`, `v11`. Tags `0.60` and `v10` stay. Do not move tag `v7` or tag `v9`.
**Do not build here:** Windows / Linux / Arch / Fedora / OpenSUSE zips or the Android apk
**Do not restyle the live site.** Pin strings on shear.digital are Continuum **0.62**, node **v12**, and ShearK **2.6**.
**Miner:** ShearK **2.6** stays on https://github.com/rgsneddon/ShearK/releases/tag/2.6. Do not cut a new miner from this handoff.

`node/pack/zip_node.py` (what `pack_macos.sh` calls) must ship `node/src`, `crypto`, `pool/src/wallet_api.js`, `pool/src/hash_credit.js`, `pool/src/withdraw_state.js`, and `contracts/Reserve.json`. RPC imports `wallet_api.js`; `reserve_evm.js` reads `Reserve.json` at boot. Without those files the unzipped node exits 1.

Shared book (Shear Sentinel v12 and Continuum 0.62): macOS/Linux `~/.shear/testnet-v7`. Windows `%APPDATA%\Shear\testnet-v7` (Roaming). One process at a time on :30303 / :18332.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. `wallet/pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`.

`PRODUCT_VERSION` in `crypto/asert.js` is **12.0** (Shear Sentinel v12). Continuum pin is `kWalletVersion = '0.62'`. Do not set `PRODUCT_VERSION` to `0.62` or to `11.0` or `0.61`. `consensusFingerprint()` must not contain `12.0`, `11.0`, `10.0`, `9.0`, `8.0`, `7.0`, `0.62`, `0.61`, `0.60`, `0.59`, `0.58`, `0.57`, `0.56`, or `PRODUCT_VERSION`.

---

## 1. Shear Sentinel v12

```bash
git pull
grep "PRODUCT_VERSION" crypto/asert.js
# must print: export const PRODUCT_VERSION = '12.0';
sh node/pack/pack_macos.sh
```

Writes `dist/shear-node-v12-macos.zip`. Windows creates tag `v12` with the other OS zips. If `gh release view v12 --repo rgsneddon/shear-testnet` is missing, stop. Do not move tag `v7`.

```bash
unzip -l dist/shear-node-v12-macos.zip | grep -E 'wallet_api.js|Reserve.json'
gh release upload v12 dist/shear-node-v12-macos.zip --repo rgsneddon/shear-testnet
```

Native addons must be Darwin. No `--clobber`. Do not upload this zip onto tag `v7`, tag `v9`, or tag `v10`.

---

## 2. CONTINUUMv0.62

```bash
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.62';

cd wallet
BUILD_NUMBER=87 SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

Writes `wallet/dist/shear-wallet-0.62-macos.dmg`. The sidecar node inside Continuum is Shear Sentinel v12 (`node/src/node.js`). Empty book does **not** auto-pull a bootstrap.

Windows creates tag `0.62` with the non-Mac wallet assets. If `gh release view 0.62 --repo rgsneddon/shear-testnet` is missing, stop.

```bash
gh release upload 0.62 dist/shear-wallet-0.62-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach Windows, Android, Linux, Arch, Fedora, or OpenSUSE files from this machine. Public pages do not link the disk image until that upload exists. Restore the download href on shear.digital in the same cut.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 9. Hash bonus unit stays 1 nano.
- Public pages stay SaaS dark.
- Do not bounce `shear-pool`. Do not delete `chain.bin`.
- `SYNC_POOL_WALLET=0`.
