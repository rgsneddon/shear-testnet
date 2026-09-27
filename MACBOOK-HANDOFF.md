# MacBook handoff — cut Continuum 0.55.1 (Apple only)

**You cut 0.55.1.** The Apple disk image only. Windows, Android, Linux, Arch, and Fedora are not this machine. Pin the same label Windows uses: Continuum **0.55.1**. Do not pin 0.56. Do not leave the Apple build on 0.55. Do not create tag `0.56`.

**Repo:** https://github.com/rgsneddon/shear-testnet
**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Branch:** `main`
**Tag:** `0.55.1` already exists and already has `shear-wallet-0.55.1-macos.dmg`. Do not move it. Do not move `0.55`.
**Release name:** Continuum 0.55.1
**Do not move:** `0.52`, `0.53`, `0.54`, `0.55`
**Do not create:** `0.56`
**Do not build here:** Windows zip, Android apk, Linux zip, Arch zip, Fedora zip
**Do not edit the live site.** Windows points shear.digital at 0.55.1 and links a button only when that file is on the release. SaaS dark stays. Do not restyle pages.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. Do not ship a zip of the `.app`.

---

## What you are packing

`git pull` on `main`. These must read 0.55.1 before you build:

- `wallet/lib/main.dart`: `kWalletVersion = '0.55.1'`
- `wallet/lib/shear_cli.dart`: `kCliVersion = '0.55.1'`
- `wallet/pubspec.yaml`: `version: 0.55.1+79`
- `crypto/asert.js`: `PRODUCT_VERSION = '0.55'`

`PRODUCT_VERSION` stays two-part. The wallet pin is `0.55.1`. Do not set `PRODUCT_VERSION` to `0.55.1` or `0.56`.

`consensusFingerprint()` does **not** contain `0.55.1`, `0.56`, `0.55`, `0.54`, `0.53`, `0.52`, or `PRODUCT_VERSION`. Do not edit the fingerprint array. A wallet release does not change it.

`wallet/pack_macos.sh` names the file from the full `kWalletVersion`, so a stock run writes `shear-wallet-0.55.1-macos.dmg`. That is the release asset. Do not rename it to `shear-wallet-0.55-macos.dmg`. That name is release `0.55`.

---

## Why this cut exists

Miner rewards are unstealable. The pool job seals pot-after-fee and the hash bonus to the hasher dest. The pool dest receives only the 1% fee. A spend of the miner note verifies only with the key that commits to that dest. The pool operator key does not. `node/tests/test_pot_prop.js` covers that (`miner pot and hash notes are spendable only by the miner key`).

Historical testnet blocks that sealed the whole pot to the pool still verify. Do not reset the chain to “fix” them.

Mainnet is prepped and **not** emitting. `docs/MAINNET.md` is the note. Genesis stays `2026-09-18T21:00:00+01:00`. Do not set `SHEAR_MAINNET_EMIT`. The 1 October 2026 date is a display countdown, not genesis and not emit.

A pending Continuum row opens that transfer in Shearview.

---

## Leave these alone

- Reddit stays removed. Discord, Telegram, and X stay.
- Empty book applies `https://boot.shear.digital` once. A datadir that already has `chain.bin` or `chain.jsonl` resumes from the recorded tip and does not pull.
- Spendable depth stays 6. `isSpendableHeight(100, 105)` is true.
- Hash bonus unit stays 1 nano. One share floor stays 256 units.
- VPN tunnel stays out of the wallet UI.
- Public pages stay SaaS dark.
- Do not put a fleet IP address in this file or in a public page.
- Do not bounce `shear-pool` from the Mac. Do not delete `chain.bin`.

---

## Build

From a clean `main`:

```bash
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.55.1';

cd wallet
flutter build macos --release --build-name=0.55.1 --build-number=79
bash pack_macos.sh
```

If tag `0.55.1` does not exist yet, create the release and upload only the disk image:

```bash
gh release create 0.55.1 dist/shear-wallet-0.55.1-macos.dmg \
  --repo rgsneddon/shear-testnet \
  --title "Continuum 0.55.1" \
  --notes "Continuum 0.55.1. Apple disk image. Miner pot-after-fee and hash bonus seal to the hasher dest. The pool dest receives only the 1% fee. Mainnet emit stays off."
```

Tag `0.55.1` already exists. If you rebuild the disk image, upload with `gh release upload 0.55.1` and do not move the tag. Do not create tag `0.56`. Do not attach Windows, Android, or Linux files from this machine.
