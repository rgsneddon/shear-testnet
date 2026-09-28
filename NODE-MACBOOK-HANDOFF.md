# MacBook handoff — SHEAR-NODEv8 and Continuum 0.57 (Apple only)

Two Apple files. Do not mix the tags.

| Product | File | GitHub tag |
|---|---|---|
| SHEAR-NODEv8 | `shear-node-v8-macos.zip` | `v8` |
| CONTINUUMv0.57 | `shear-wallet-0.57-macos.dmg` | `0.57` |

**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md
**Also:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Repo:** https://github.com/rgsneddon/shear-testnet · **branch:** `main`
**Do not move:** `0.52`–`0.56`, `v6`, `v7`. Do not move tag `v7`.
**Do not build here:** Windows / Linux / Arch / Fedora / OpenSUSE zips or the Android apk
**Do not restyle the live site.** Pin strings on shear.digital are Continuum **0.57**, node **v8**, and ShearK **2.6**.
**Miner:** ShearK **2.6** stays on https://github.com/rgsneddon/ShearK/releases/tag/2.6. Do not cut a new miner from this handoff.

`node/pack/zip_node.py` (what `pack_macos.sh` calls) must ship `node/src`, `crypto`, `pool/src/wallet_api.js`, `pool/src/hash_credit.js`, `pool/src/withdraw_state.js`, and `contracts/Reserve.json`. RPC imports `wallet_api.js`; `reserve_evm.js` reads `Reserve.json` at boot. Without those files the unzipped node exits 1.

Shared book (SHEAR-NODEv8 and Continuum 0.57): macOS/Linux `~/.shear/testnet-v5`. Windows `%APPDATA%\Shear\testnet-v5` (Roaming). One process at a time on :30303 / :18332.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. `wallet/pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`.

`PRODUCT_VERSION` in `crypto/asert.js` is **8.0** (SHEAR-NODEv8). Continuum pin is `kWalletVersion = '0.57'`. Do not set `PRODUCT_VERSION` to `0.57`. `consensusFingerprint()` must not contain `8.0`, `7.0`, `0.56`, `0.57`, or `PRODUCT_VERSION`.

---

## 1. SHEAR-NODEv8

```bash
git pull
grep "PRODUCT_VERSION" crypto/asert.js
# must print: export const PRODUCT_VERSION = '8.0';
sh node/pack/pack_macos.sh
```

Writes `dist/shear-node-v8-macos.zip`. Windows creates tag `v8` with the other OS zips. If `gh release view v8 --repo rgsneddon/shear-testnet` is missing, stop. Do not move tag `v7`.

```bash
unzip -l dist/shear-node-v8-macos.zip | grep -E 'wallet_api.js|Reserve.json'
gh release upload v8 dist/shear-node-v8-macos.zip --repo rgsneddon/shear-testnet
```

Native addons must be Darwin. No `--clobber`. Do not upload this zip onto tag `v7`.

---

## 2. CONTINUUMv0.57

```bash
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.57';

cd wallet
BUILD_NUMBER=82 SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

Writes `wallet/dist/shear-wallet-0.57-macos.dmg`. The sidecar node inside Continuum is SHEAR-NODEv8 (`node/src/node.js`). Empty book does **not** auto-pull a bootstrap.

Windows creates tag `0.57` with the non-Mac wallet assets. If `gh release view 0.57 --repo rgsneddon/shear-testnet` is missing, stop.

```bash
gh release upload 0.57 dist/shear-wallet-0.57-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach Windows, Android, Linux, Arch, Fedora, or OpenSUSE files from this machine.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 6. Hash bonus unit stays 1 nano.
- Public pages stay SaaS dark.
- Do not bounce `shear-pool`. Do not delete `chain.bin`.
- `SYNC_POOL_WALLET=0`.
