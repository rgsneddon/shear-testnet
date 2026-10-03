# MacBook handoff — Shear Sentinel v16 and Continuum 0.67 (Apple only)

Two Apple files. Do not mix the tags. This machine uploads only these two files onto tags `v16` and `0.67`. It does not replace the Windows, Linux, Arch, Fedora, or OpenSUSE assets, and it does not pass `--clobber`. The GitHub release is not published yet.

| Product | File | GitHub tag |
|---|---|---|
| Shear Sentinel v16 | `shear-node-v16-macos.zip` | `v16` |
| Continuum 0.67 | `shear-wallet-0.67-macos.dmg` | `0.67` |

**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md
**Also:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Repo:** https://github.com/rgsneddon/shear-testnet · **branch:** `main`
**Book:** `shear-testnet-v10`. Datadir `~/.shear/testnet-v10` (Windows `%APPDATA%\Shear\testnet-v10`). One process at a time on :30303 / :18332.

**Node pin is Shear Sentinel v16 (product 16.0).** Do not pass `--clobber`. Do not upload this zip onto `v15`.

**Previous tag `0.66` stays.** Do not rebuild those assets, do not pass `--clobber`, and do not upload a 0.67 file onto `0.66` or `0.65`.

**This cut's non-Mac zips** are packed on the Windows and Linux hosts onto tags `v16` and `0.67`. This Mac uploads only the two Apple files.

**Checked on the Windows build host, 2026-10-02.** Flutter 3.47.4 is installed. `xcodebuild` is not. WSL has no distribution. This host cannot emit a Mach-O binary or a Continuum `.dmg`. `dist/shear-wallet-0.67-macos.dmg` and `dist/shear-node-v16-macos.zip` are absent. Cut both on the Mac with the commands below. Do not invent them on Windows and do not upload them from Windows.

**Do not move:** `0.52`–`0.66`, `v6`–`v15`. Tags `0.60` and `v10` stay.
**Do not build here:** Windows / Linux / Arch / Fedora / OpenSUSE zips or the Android apk.
**Do not restyle the live site from this machine.** Download pins for this cut are Continuum **0.67**, Shear Sentinel **v16**, and ShearK **2.7** (`stratum+ssl://pool.shear.digital:443`).
**Miner:** ShearK **2.7** is the TLS-aware pin. Do not label a 2.6 rebuild as TLS-done. Do not put ShearK inside the disk image. The Windows miner zip must include the OpenSSL DLLs beside `ShearK-Miner.exe`.

`node/pack/zip_node.py` (what `pack_macos.sh` calls) must ship `node/src`, `crypto`, `node_modules`, `pool/src/wallet_api.js`, `pool/src/hash_credit.js`, `pool/src/withdraw_state.js`, `pool/src/posture.js`, and `contracts/Reserve.json`. RPC imports `wallet_api.js`; the pool entry imports `posture.js`; `reserve_evm.js` reads `Reserve.json` at boot. Without those files the unzipped node exits 1. `crypto/native/shearhash.node` in this zip must be Mach-O built on this Mac.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. `wallet/pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`. Do not ship a zip of the `.app`.

`PRODUCT_VERSION` in `crypto/asert.js` is **16.0** (Shear Sentinel v16). Continuum pin is `kWalletVersion = '0.67'` and pubspec `0.67.0+92`. Do not set `PRODUCT_VERSION` to `17.0` or to `0.66`. `consensusFingerprint()` must not contain `17.0`, `16.0`, `15.0`, `0.67`, `0.66`, or `PRODUCT_VERSION`.

`node/pack/pack_macos.sh` reads that pin and refuses anything other than `16.0`. The zip it checks is `dist/shear-node-v16-macos.zip`.

---

## 0. Pull

```bash
git checkout main
git pull
grep "PRODUCT_VERSION" crypto/asert.js
# must print: export const PRODUCT_VERSION = '16.0';
grep MAGIC_TESTNET_V10 crypto/asert.js
# must print: export const MAGIC_TESTNET_V10 = 'shear-testnet-v10';
npm ci
```

Upload onto GitHub tag `v16` and tag `0.67`. The GitHub release is not published yet. Do not pass `--clobber`. Do not move tag `0.66`.

---

## 1. Shear Sentinel v16

```bash
sh node/pack/pack_macos.sh
unzip -l dist/shear-node-v16-macos.zip | grep -E 'wallet_api.js|posture.js|Reserve.json|shearhash.node'
gh release upload v16 dist/shear-node-v16-macos.zip --repo rgsneddon/shear-testnet
```

No `--clobber`. Native addons must be Darwin. Do not upload this zip onto tag `v15`. The release is not published yet.

---

## 2. Continuum 0.67

The disk image is the GUI. It does not contain the node tree. The Sentinel zip from section 1 is the node. `pack_macos.sh` reads the pubspec `+N` (92). It refuses build number 49.

```bash
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.67';

cd wallet
SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

Writes `wallet/dist/shear-wallet-0.67-macos.dmg`. Empty book does **not** auto-pull a bootstrap.

```bash
gh release upload 0.67 dist/shear-wallet-0.67-macos.dmg --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not attach Windows, Android, Linux, Arch, Fedora, or OpenSUSE files from this machine.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Spendable depth stays 9. Hash bonus unit stays 1 nano.
- Public pages stay SaaS dark.
- Do not bounce `shear-pool`. Do not delete `chain.bin`.
- `SYNC_POOL_WALLET=0`.
- Do not rotate the live fee-payout ssa1 from this handoff. Russell pins that later.
