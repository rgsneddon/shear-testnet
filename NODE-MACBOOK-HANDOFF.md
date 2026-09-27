# MacBook handoff — SHEAR-NODEv7 and Continuum 0.56 (Apple only)

Two Apple files. Do not mix the tags.

| Product | File | GitHub tag |
|---|---|---|
| SHEAR-NODEv7 | `shear-node-v7-macos.zip` | `v7` |
| CONTINUUMv0.56 | `shear-wallet-0.56-macos.dmg` | `0.56` |

**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md
**Also:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Repo:** https://github.com/rgsneddon/shear-testnet · **branch:** `main`
**Do not move:** `0.52`–`0.55.2`, `v6`
**Do not build here:** Windows / Linux / Arch / Fedora / OpenSUSE zips or the Android apk
**Do not restyle the live site.** Pin strings on shear.digital are Continuum **0.56** and node **v7**.

`node/pack/zip_node.py` (what `pack_macos.sh` calls) must ship `node/src`, `crypto`, `pool/src/wallet_api.js`, `pool/src/hash_credit.js`, `pool/src/withdraw_state.js`, and `contracts/Reserve.json`. RPC imports `wallet_api.js`; `reserve_evm.js` reads `Reserve.json` at boot. Without those files the unzipped node exits 1.

Shared book (SHEAR-NODEv7 and Continuum 0.56): macOS/Linux `~/.shear/testnet-v5`. Windows `%APPDATA%\Shear\testnet-v5` (Roaming). One process at a time on :30303 / :18332.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. `wallet/pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`.

`PRODUCT_VERSION` in `crypto/asert.js` is **7.0** (SHEAR-NODEv7). Continuum pin is `kWalletVersion = '0.56'`. Do not set `PRODUCT_VERSION` to `0.56`. `consensusFingerprint()` must not contain `7.0`, `0.56`, or `PRODUCT_VERSION`.

---

## 1. SHEAR-NODEv7

```bash
git pull
grep "PRODUCT_VERSION" crypto/asert.js
# must print: export const PRODUCT_VERSION = '7.0';
sh node/pack/pack_macos.sh
```

Writes `dist/shear-node-v7-macos.zip`. Tag `v7` already exists on GitHub (Windows uploaded the other OS zips). If `gh release view v7 --repo rgsneddon/shear-testnet` is missing, stop.

```bash
unzip -l dist/shear-node-v7-macos.zip | grep -E 'wallet_api.js|Reserve.json'
gh release upload v7 dist/shear-node-v7-macos.zip --repo rgsneddon/shear-testnet --clobber
```

Native addons must be Darwin. `--clobber` replaces only the macOS zip.

---

## 2. CONTINUUMv0.56

```bash
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.56';

cd wallet
BUILD_NUMBER=81 SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

Writes `wallet/dist/shear-wallet-0.56-macos.dmg`. The sidecar node inside Continuum is SHEAR-NODEv7 (`node/src/node.js`). Empty book does **not** auto-pull a bootstrap.

Windows creates tag `0.56` with the non-Mac wallet assets. If `gh release view 0.56 --repo rgsneddon/shear-testnet` is missing, stop.

```bash
gh release upload 0.56 dist/shear-wallet-0.56-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach Windows, Android, Linux, Arch, Fedora, or OpenSUSE files from this machine.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 6. Hash bonus unit stays 1 nano.
- Public pages stay SaaS dark.
- Do not bounce `shear-pool`. Do not delete `chain.bin`.
- `SYNC_POOL_WALLET=0`.
