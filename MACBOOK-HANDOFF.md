# MacBook handoff — cut Continuum 0.55.2 (Apple only)

**You cut 0.55.2.** The Apple disk image only. Windows, Android, Linux, Arch, and Fedora are already on tag `0.55.2`. Pin the same label Windows uses: Continuum **0.55.2**. Do not pin 0.56. Do not leave the Apple build on 0.55.1. Do not create tag `0.56`.

**Repo:** https://github.com/rgsneddon/shear-testnet
**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Branch:** `main`
**Tag:** `0.55.2` is created by Windows with the five non-Mac assets. Do not create that tag from this machine. Do not move `0.55.1` or `0.55`.
**Release name:** Continuum 0.55.2
**Do not move:** `0.52`, `0.53`, `0.54`, `0.55`, `0.55.1`
**Do not create:** `0.56`
**Do not build here:** Windows zip, Android apk, Linux zip, Arch zip, Fedora zip
**Do not edit the live site.** Windows points shear.digital at 0.55.2 and leaves the macOS button on `shear-wallet-0.55.1-macos.dmg` until this image is on the release. SaaS dark stays. Do not restyle pages.

Developer ID: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. Do not ship a zip of the `.app`. `pack_macos.sh` uses `ditto` so the notarization ticket survives. Do not replace that with `cp -R`.

---

## What you are packing

`git pull` on `main`. These must read 0.55.2 before you build:

- `wallet/lib/main.dart`: `kWalletVersion = '0.55.2'`
- `wallet/lib/shear_cli.dart`: `kCliVersion = '0.55.2'`
- `wallet/pubspec.yaml`: `version: 0.55.2+80`
- `crypto/asert.js`: `PRODUCT_VERSION = '0.55'`

`PRODUCT_VERSION` stays two-part. The wallet pin is `0.55.2`. Do not set `PRODUCT_VERSION` to `0.55.2` or `0.56`.

`consensusFingerprint()` does **not** contain `0.52`, `0.53`, `0.54`, `0.55`, `0.55.1`, `0.55.2`, `0.56`, or `PRODUCT_VERSION`. Do not edit the fingerprint array. A wallet release does not change it.

`wallet/pack_macos.sh` names the file from the full `kWalletVersion`, so a stock run writes `shear-wallet-0.55.2-macos.dmg`. Set `BUILD_NUMBER=80` so the build number matches pubspec `0.55.2+80`. The script default is 50. Do not rename the image to `shear-wallet-0.55-macos.dmg`. That name is release `0.55`.

---

## Why this cut exists

A pending Continuum row opens that transfer in Shearview.

An unpinned wallet posts `/api/wallet/send` to the GUI node at `127.0.0.1:18332`. That route queues a painted lock and a she1 or ssa1 send when chain notes are below amount plus fee and only owed-toward-π covers it.

A second painted send from the same dest posts the gross owed figure (net plus what this session already spent) and still queues when the remainder covers it.

Miner rewards stay unstealable. The pool job seals pot-after-fee and the hash bonus to the hasher dest. The pool dest receives only the 1% fee. A spend of the miner note verifies only with the key that commits to that dest. The pool operator key does not.

Historical testnet blocks that sealed the whole pot to the pool still verify. Do not reset the chain to change them.

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
- Do not run `sync_pool_wallet.sh`. Set `SYNC_POOL_WALLET=0`.

---

## Build

From a clean `main`:

```bash
grep kWalletVersion wallet/lib/main.dart
# must print: const kWalletVersion = '0.55.2';

cd wallet
BUILD_NUMBER=80 SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
```

That writes `wallet/dist/shear-wallet-0.55.2-macos.dmg`.

If `gh release view 0.55.2 --repo rgsneddon/shear-testnet` does not list the release, stop. Do not create a tag that has only the disk image. Windows creates tag `0.55.2` with the other five assets.

When the release exists, upload this image and do not replace the other assets:

```bash
gh release upload 0.55.2 dist/shear-wallet-0.55.2-macos.dmg \
  --repo rgsneddon/shear-testnet
```

No `--clobber`. Do not move `0.52`, `0.53`, `0.54`, `0.55`, or `0.55.1`. Do not create tag `0.56`. Do not attach Windows, Android, Linux, Arch, or Fedora files from this machine.
