# MacBook handoff — pin Continuum 0.55

**We will pin 0.55.** Not 0.56.

The published GitHub release and the live site are still Continuum **0.54**. `origin/main` already carries the 0.55 display build. The MacBook packs the Apple disk image for that 0.55 pin. It does not invent a 0.56 release, and it does not build Windows, Android, or Linux.

**Repo:** https://github.com/rgsneddon/shear-testnet
**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK-HANDOFF.md
**Pin we are cutting:** Continuum **0.55** — tag `0.55` once the packs exist
**Do not tag or upload:** `0.56`
**Leave these tags where they are:** `0.52`, `0.53`, `0.54`

Developer ID on the Apple cut: `Russell Sneddon (SFCBP95595)`. An unsigned disk image is Gatekeeper-blocked. Do not ship a zip of the `.app`.

---

## What “pin 0.55” means

`origin/main` at `82aa3620ea178e353916b8faf7c762a2e378be26` is the 0.55 source:

- `wallet/lib/main.dart`: `kWalletVersion = '0.55.0'`
- `wallet/pubspec.yaml`: `version: 0.55.0+77`
- `crypto/asert.js`: `PRODUCT_VERSION = '0.55'`
- `consensusFingerprint()` does **not** contain `0.55`, `0.54`, `0.53`, `0.52`, or `PRODUCT_VERSION`. A wallet release does not change the fingerprint. Do not edit the fingerprint array to “match” the pin.

Parent commit `3aeae1bb79da00bb30f27ffbd336ad09acf66938` is “Advance the manual-test wallet to Continuum 0.55.” `82aa362` only points the wallet source test at the circulation label and the local-send gate.

There is **no** GitHub release `0.55` yet, and **no** tag `0.55`. The five live download buttons are still the 0.54 assets:

- `shear-wallet-0.54-windows.zip`
- `shear-wallet-0.54-linux.zip`
- `shear-wallet-0.54-archlinux.zip`
- `shear-wallet-0.54-fedora.zip`
- `shear-wallet-0.54-android.apk`

Release `0.54` was published 2026-09-26. Do not rebuild it and do not move its tag. A macOS disk image was not part of that release.

---

## Do not take the Windows working tree

The Windows publication clone `C:\Users\rgsne\shear-pool-node` is dirty **on top of** `82aa362`. Those edits are **not** on GitHub. They drafted a 0.56 bump (`kWalletVersion` `0.56.0`, `PRODUCT_VERSION` `'0.56'`, `version: 0.56.0+78`, and many `0.54` pin strings rewritten to `0.56`) and they are incomplete: several tests still match `0\.54`, and `crypto/asert.test.js` on disk still expects product `0.55` while `asert.js` in that same tree says `0.56`.

Discard that draft. Do not commit it, do not scp it onto the live site, and do not point a WALLET link at `releases/tag/0.56`. That URL 404s. The explorer file in that dirty tree already has a `0.56` wallet href; the **live** explorer page does not.

`git pull` on a fresh Mac clone of `main` is the 0.55 tree plus this handoff. That is the tree to pack.

---

## Already done (do not redo)

Pushed on `main` before this handoff:

- `63e681a` — Empty datadir applies the public snapshot once. A datadir that already has `chain.bin` or `chain.jsonl` resumes from the recorded tip and does not pull. Help returns before that check.
- `d4e578c` — Bootstrap publisher republishes the newest pair every 6 seconds. A shorter snapshot than the one already published is refused. Checkpoint copy stays “first published at height 1000, overwritten every 400”. JSON cadence stays 200. Do not scp `deploy/nginx-boot.shear.digital.conf` over the live vhost.
- `ae53779` — Painted lock and send post from the dest the pull book credits. `plate_053` passed twice on `82aa362` (+5 / +5). Do not rewrite that path to match stale line numbers.
- `684253f` — Prune does not make a previously spendable balance unspendable.
- `3aeae1b` and `82aa362` — Continuum **0.55** display. Fingerprint length stays 1448 and does not contain the product version.
- Spendable depth is **6** confirmations. `isSpendableHeight(100, 105)` is true. It is not “after a 7th confirmation”.
- Hash bonus unit is **1 nano** = `0.00000000001` SHE. `HASH_BONUS_NANOS` stays 1. One share floor is 256 units (`unitsForShare`). Do not change either to make a displayed total look larger. Do not reset the chain.
- VPN tunnel is removed from the wallet UI. Connect bare is the path. Do not rebuild a hop server.
- Resistance Start resumes from the saved tip and syncs one block at a time. Stop saves that height. Stop does not wipe the book.
- ShearK miner pin stays **2.6**. `SHEARK_MINER_VERSION` in the fingerprint test stays `'2.5'` and stays out of the fingerprint.
- Public pages stay SaaS dark. Do not restore a light `--bg`. Do not restyle pool, explorer, mempool, or miner pages to change the pin.
- Genesis stays `2026-09-18T21:00:00+01:00`. The 1 October 2026 date is a display countdown, not genesis and not emit. Mainnet emit stays blocked.
- Live network line on the pool card stays `shear-testnet-v4` even though the chain magic in the API is `shear-testnet-v5`. Do not mass-rewrite the v4 pins.

Painted send law, still in force: a send is the user pushing a signed transaction. Each node verifies it. Unsigned bodies stay rejected. A short `she1` fingerprint stays unpayable. A full `she1` resolves to `ssa1` and posts with a signature `verifySpendSig` accepts.

---

## What is live right now

Checked against the running pool, not against the dirty Windows tree.

- Live pool process was still product version **0.53** at git head `c02f787`. Do not bounce `shear-pool` just to load a newer tree. Do not change `SHEAR_DATA` or `SHEAR_NETWORK`. Do not delete `chain.bin`.
- Bootstrap publisher is on a 6 second loop. Do not bounce it for this handoff.
- Home and wallet pages are still Continuum **0.54**, SaaS dark, with the five 0.54 download links. `/var/www/shear.digital/index.html` and `/var/www/shear.digital/docs/index.html` are immutable (`chattr +i`). Never scp a whole HTML file over them. Do not reload nginx for a static pin string.
- Explorer “ONGOING HASHBONUS WORK” **is deployed**. It shows the open round in SHE at 11 decimal places. One nano is `0.00000000001`. The formatter multiplies counted units by `hashBonusNanos` (live value 1) and divides by `100000000000`. An open round of 4096 nanos reads `0.00000004096 SHE`. The live page serves that formatter from `/var/www/explorer.shear.digital/explorer.html`. The wallet nav on that live page is still tag **0.54**.
- Circulating Shear on that page is **not** done. See the next section.
- `shear-node` on the pool host stays inactive. `shear-pool` is the chain.

Supply snapshot while the circulating card was still the 8-decimal formatter (height 1621):

- `potEmittedNanos` = 162100000000000
- `hashBonusEmittedNanos` = 4829440
- `extraMintedNanos` = 0 (no vault mint yet)
- `burnedNanos` = 0
- `circulatingNanos` = 162100004829440

Those add up: pot + hash bonus + vault mint − burned. The card was still running the sum through an 8-decimal truncate, so the last nanos of the hash bonus were not visible.

---

## Still open

### 1. Circulating Shear on the explorer

The card must show every **sealed** Shear on the network, at 11 decimal places, as one sum:

`potEmittedNanos + hashBonusEmittedNanos + extraMintedNanos − burnedNanos`

That is all block pots, all minted hash bonuses the node already counts, and vault-minted coins (`extraMintedNanos` / `mintBankNanos`). Staked and accruing vault balances are not added again; they are the same coins. The open round stays on the hash-bonus box, not in this total.

Do not add pull-book hash credits. Those credits stop at height 1258, are an off-chain ledger, and are many times the sealed `aLeaves` amounts. Adding them invents supply.

`hashBonusEmittedOfBlock` still misses a sealed empty-batch floor: one hash vout, confidential `nanos` 0, empty `aLeaves`, empty `shareBatch`. Consensus accepts that note at `unitsForShare()` (256 nanos). That hole is real and small. It is not the pull-book gap. Fix it in `pool/src/wallet_api.js` with a regression next to the existing `networkSupply` test before anyone bounces the pool to load it. A page-only change can show the API sum at 11 decimals without a bounce. The floor does not appear in the API until that process loads the fix.

Deploy the explorer card by editing `/var/www/explorer.shear.digital/explorer.html` in place. Do not copy the Windows dirty `pool/public/explorer.html` over it: that file’s WALLET link says `0.56`.

### 2. Cut the 0.55 packs, then move the public pin

Order:

1. Pack from the **committed** 0.55 tree, not the Windows 0.56 draft.
2. Tag `0.55` on that commit (or on a commit that contains only pin-doc fixes still at version 0.55). Do not move `0.52`, `0.53`, or `0.54`.
3. GitHub release “Continuum 0.55.0” with the assets below.
4. Point README, site, pool nav, and the live pages at `releases/tag/0.55` and `shear-wallet-0.55-*`. Stay SaaS dark.
5. Docs that still say “Startup does not pull a bootstrap” become the empty-book law at the same time: an empty book applies the snapshot once; a recorded tip resumes and does not pull.
6. `wallet/pack/archlinux/PKGBUILD` stays `pkgver=0.54` until the 0.55 linux zip is actually on the release, then it becomes 0.55.

Asset names, same pattern as 0.54:

| Pack | Where | Asset |
| --- | --- | --- |
| macOS disk image | **this MacBook** | `shear-wallet-0.55-macos.dmg` |
| Windows zip | Windows PC | `shear-wallet-0.55-windows.zip` |
| Android apk | Windows PC, after the Windows pack, not at the same time | `shear-wallet-0.55-android.apk` |
| Linux zip | pool host, not the Mac | `shear-wallet-0.55-linux.zip` |
| Arch zip | pool host, after the linux zip exists | `shear-wallet-0.55-archlinux.zip` |
| Fedora zip | same bytes as the linux zip, as with 0.54 | `shear-wallet-0.55-fedora.zip` |

`wallet/pack_macos.sh` names the file from the full `kWalletVersion`, so a stock run writes `shear-wallet-0.55.0-macos.dmg`. The release asset the site should link is `shear-wallet-0.55-macos.dmg`. Rename before upload, or the download buttons will 404.

Do not put `0.55` inside `consensusFingerprint()`. Tests must keep asserting the fingerprint does not contain the product version.

### 3. Reddit button

On `82aa362` the Continuum row still has Discord, Telegram, X, and Reddit. A removal of the Reddit button exists only in the dirty Windows tree, tangled with the 0.56 draft. It is **not** part of the 0.55 commit. Do not fish it out of that tree by taking the 0.56 version bump with it. If the pin should ship without Reddit, replay that removal as its own change on top of `82aa362` before tagging.

---

## MacBook build, when the 0.55 tag is the one you are cutting

```sh
git clone https://github.com/rgsneddon/shear-testnet.git ~/shear-testnet
cd ~/shear-testnet
git checkout main
git pull
# kWalletVersion must be 0.55.0. If it says 0.56.0 you have the wrong tree.
grep kWalletVersion wallet/lib/main.dart
cd wallet
flutter --version
brew list libsodium >/dev/null || brew install libsodium
PACK_REBUILD=1 ./pack_macos.sh
# stock output: wallet/dist/shear-wallet-0.55.0-macos.dmg
# release asset name:
#   wallet/dist/shear-wallet-0.55-macos.dmg
python3 pack/sign_and_notarize.py
```

Install check: open the disk image, drag Shear to Applications, eject, launch from Applications. Do not leave it running from the image. The wallet must not bundle ShearK.

Upload only after the `0.55` release exists:

```sh
gh release upload 0.55 wallet/dist/shear-wallet-0.55-macos.dmg --repo rgsneddon/shear-testnet --clobber
```

Windows and Android stay on the Windows PC. Linux, Arch, and Fedora stay on the pool host. Do not run two Flutter builds in one wallet tree.

---

## Laws the pin must not break

- A send is a signed transaction the user pushes. Nodes verify it. Do not describe that as posting every coin to the pool.
- Empty book, bootstrap forced: pull `https://boot.shear.digital/latest.json` once and apply it. A recorded tip resumes. Missing snapshot: log and still start. Help must not print `bootstrap_missing` or `bootstrap_pulled`.
- Spendable at 6. Hash bonus nano stays 1. Share floor stays 256. No chain reset.
- Do not debit the pull book to invent a painted spend. Mempool accept is the bar.
- Do not bounce `shear-pool` as a side effect of the pin. The circulating floor fix is the only supply change that needs that process, and only after its test is green.
- Do not kill an open wallet on the Windows PC.
- Dead hosts stay dead. Contabo stays untouched.
