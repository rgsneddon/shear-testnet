# MacBook handoff — Shear Sentinel v10 and Continuum 0.60 (Apple only)

Two Apple files. Do not mix the tags. This machine does not upload them.

| Product | File | GitHub tag |
|---|---|---|
| Shear Sentinel v10 | `shear-node-v10-macos.zip` | `v10` |
| CONTINUUMv0.60 | `shear-wallet-0.60-macos.dmg` | `0.60` |

**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md
**Also:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Repo:** https://github.com/rgsneddon/shear-testnet · **branch:** `main`
**Do not move:** `0.52`–`0.59`, `v6`, `v7`, `v8`, `v9`. Do not move tag `v7` or tag `v9`.
**Do not build here:** Windows / Linux / Arch / Fedora / OpenSUSE zips or the Android apk
**Do not restyle the live site.** Pin strings on shear.digital are Continuum **0.60**, node **v10**, and ShearK **2.6**.
**Miner:** ShearK **2.6** stays on https://github.com/rgsneddon/ShearK/releases/tag/2.6. Do not cut a new miner from this handoff.

`node/pack/zip_node.py` (what `pack_macos.sh` calls) must ship `node/src`, `crypto`, `pool/src/wallet_api.js`, `pool/src/hash_credit.js`, `pool/src/withdraw_state.js`, and `contracts/Reserve.json`. RPC imports `wallet_api.js`; `reserve_evm.js` reads `Reserve.json` at boot. Without those files the unzipped node exits 1.

Shared book (Shear Sentinel v10 and Continuum 0.60): macOS/Linux `~/.shear/testnet-v5`. Windows `%APPDATA%\Shear\testnet-v5` (Roaming). One process at a time on :30303 / :18332.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. `wallet/pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`.

`PRODUCT_VERSION` in `crypto/asert.js` is **10.0** (Shear Sentinel v10). Continuum pin is `kWalletVersion = '0.60'`. Do not set `PRODUCT_VERSION` to `0.60`. `consensusFingerprint()` must not contain `10.0`, `9.0`, `8.0`, `7.0`, `0.60`, `0.59`, `0.58`, `0.57`, `0.56`, or `PRODUCT_VERSION`.

---

## 1. Shear Sentinel v10

```bash
git pull
grep "PRODUCT_VERSION" crypto/asert.js
# must print: export const PRODUCT_VERSION = '10.0';
sh node/pack/pack_macos.sh
```

Writes `dist/shear-node-v10-macos.zip`. Windows creates tag `v10` with the other OS zips. If `gh release view v10 --repo rgsneddon/shear-testnet` is missing, stop. Do not move tag `v7`.

```bash
unzip -l dist/shear-node-v10-macos.zip | grep -E 'wallet_api.js|Reserve.json'
gh release upload v10 dist/shear-node-v10-macos.zip --repo rgsneddon/shear-testnet
```

Native addons must be Darwin. No `--clobber`. Do not upload this zip onto tag `v7` or tag `v9`.

---

## 2. CONTINUUMv0.60

```bash
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.60';

cd wallet
BUILD_NUMBER=85 SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

Writes `wallet/dist/shear-wallet-0.60-macos.dmg`. The sidecar node inside Continuum is Shear Sentinel v10 (`node/src/node.js`). Empty book does **not** auto-pull a bootstrap.

Windows creates tag `0.60` with the non-Mac wallet assets. If `gh release view 0.60 --repo rgsneddon/shear-testnet` is missing, stop.

```bash
gh release upload 0.60 dist/shear-wallet-0.60-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach Windows, Android, Linux, Arch, Fedora, or OpenSUSE files from this machine. Public pages do not link the disk image until that upload exists. Restore the download href on shear.digital in the same cut.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 6. Hash bonus unit stays 1 nano.
- Public pages stay SaaS dark.
- Do not bounce `shear-pool`. Do not delete `chain.bin`.
- `SYNC_POOL_WALLET=0`.
