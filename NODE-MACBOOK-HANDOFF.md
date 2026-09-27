# MacBook handoff — Shear node 0.56 (Apple only)

**You cut the macOS node zip.** Continuum wallet Apple image stays on tag `0.55.2` until a separate wallet cut. This job is `shear-node-0.56-macos.zip` on GitHub release **0.56**.

**Repo:** https://github.com/rgsneddon/shear-testnet
**This file:** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md
**Branch:** `main`
**Tag:** `0.56` is created from Windows with the non-Mac node zips (windows, linux, archlinux, fedora, opensuse). Do not create tag `0.56` from this machine if it already exists. Do not move `0.52`–`0.55.2`. OpenSUSE is `shear-node-0.56-opensuse.zip`.
**Release name:** Shear node 0.56
**Do not build here:** Windows / Linux / Arch / Fedora / OpenSUSE node zips, or any Continuum wallet pack.
**Do not edit the live site** except if Windows already pointed shear.digital/node at 0.56. SaaS dark stays.

---

## What you are packing

`git pull` on `main`. These must read **0.56** before you build:

- `crypto/asert.js`: `PRODUCT_VERSION = '0.56'`
- `node/pack/pack_macos.sh` writes `dist/shear-node-0.56-macos.zip`

`consensusFingerprint()` does **not** contain `0.56` or `PRODUCT_VERSION`. Do not edit the fingerprint array.

```bash
git pull
cd /path/to/shear-testnet
sh node/pack/pack_macos.sh
```

That builds RandomX + `crypto/native` on this Mac, then zips `shear-node.sh` + `node/src` + `crypto`. Native addons must be Darwin. Never copy a Linux `.node` into this zip.

Upload (no `--clobber` unless Windows asks):

```bash
gh release upload 0.56 dist/shear-node-0.56-macos.zip --repo rgsneddon/shear-testnet
```

If `gh release view 0.56 --repo rgsneddon/shear-testnet` does not list the release, stop. Windows creates tag `0.56` with the other node zips.

---

## What the user runs

Unzip. `chmod +x shear-node.sh`. `./shear-node.sh`. Optional `./shear-node.sh --solo` only after `ibd=false`. No automatic bootstrap. Manual snapshot: https://boot.shear.digital
