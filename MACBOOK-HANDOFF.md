# MacBook handoff — cut Continuum 0.56 (Apple only)

**You cut 0.56.** The Apple disk image only. Windows, Android, Linux, Arch, and Fedora are not this machine.

**Repo:** https://github.com/rgsneddon/shear-testnet
**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Branch:** `main`
**Tag to create:** `0.56` on the commit that contains this handoff
**Release name:** Continuum 0.56.0
**Do not move:** `0.52`, `0.53`, `0.54`, `0.55`
**Do not build here:** Windows zip, Android apk, Linux zip, Arch zip, Fedora zip
**Do not edit the live site.** `0.55` stays the public pin until the 0.56 assets exist. SaaS dark stays. Do not restyle pages.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. Do not ship a zip of the `.app`.

---

## What you are packing

`git pull` on `main`. These must read 0.56 before you build:

- `wallet/lib/main.dart`: `kWalletVersion = '0.56.0'`
- `wallet/lib/shear_cli.dart`: `kCliVersion = '0.56.0'`
- `wallet/pubspec.yaml`: `version: 0.56.0+78`
- `crypto/asert.js`: `PRODUCT_VERSION = '0.56'`

`consensusFingerprint()` does **not** contain `0.56`, `0.55`, `0.54`, `0.53`, `0.52`, or `PRODUCT_VERSION`. Do not edit the fingerprint array. A wallet release does not change it.

`wallet/pack_macos.sh` names the file from the full `kWalletVersion`, so a stock run writes `shear-wallet-0.56.0-macos.dmg`. The release asset is `shear-wallet-0.56-macos.dmg`. Rename before upload.

---

## Why this cut exists

Miner rewards are unstealable. The pool job seals pot-after-fee and the hash bonus to the hasher dest. The pool dest receives only the 1% fee. A spend of the miner note verifies only with the key that commits to that dest. The pool operator key does not. `node/tests/test_pot_prop.js` covers that (`miner pot and hash notes are spendable only by the miner key`).

Historical testnet blocks that sealed the whole pot to the pool still verify. Do not reset the chain to “fix” them.

Mainnet is prepped and **not** emitting. `docs/MAINNET.md` is the note. Genesis stays `2026-09-18T21:00:00+01:00`. Do not set `SHEAR_MAINNET_EMIT`. The 1 October 2026 date is a display countdown, not genesis and not emit.

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
# must print: const kWalletVersion = '0.56.0';

cd wallet
flutter build macos --release --build-name=0.56.0 --build-number=78
bash pack_macos.sh
mv -f dist/shear-wallet-0.56.0-macos.dmg dist/shear-wallet-0.56-macos.dmg
```

Create the release, then upload only the disk image:

```bash
gh release create 0.56 dist/shear-wallet-0.56-macos.dmg \
  --repo rgsneddon/shear-testnet \
  --title "Continuum 0.56.0" \
  --notes "Continuum 0.56.0. Apple disk image. Miner pot-after-fee and hash bonus seal to the hasher dest. The pool dest receives only the 1% fee. Mainnet emit stays off."
```

If tag `0.56` already exists, upload with `gh release upload 0.56` and do not move the tag. Do not attach Windows, Android, or Linux files from this machine.
