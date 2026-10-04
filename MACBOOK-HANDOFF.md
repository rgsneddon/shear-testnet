# MacBook handoff — Continuum 0.70 disk image only

The only file this Mac builds and uploads is `shear-wallet-0.70-macos.dmg`.

Do not build Shear Sentinel. Do not build ShearK. Do not cut a node zip. Do not cut a miner. Do not pass `--clobber`.

**Repo:** https://github.com/rgsneddon/shear-testnet

**Full steps:** https://github.com/rgsneddon/shear-testnet/blob/main/NODE-MACBOOK-HANDOFF.md

**Branch:** `feat/continuum-067-master`. The tip is the commit that contains `kWalletVersion = '0.70'` and this file. Do not build parent `dbb460eaef10e75bdeb7a809e7ac3058a9e67ef2`.

Wallet pin is Continuum 0.70 (`0.70.0+95`). Book magic stays `shear-testnet-v10`. Node pin stays Shear Sentinel v17 (product 17.0) on the existing `v17` release. Miner pin stays ShearK 2.8. Tag `0.68` stays at `a3769db773a273c79567a3f3f451e2e973b06e21`. Tag `v16` stays on the same commit as tag `0.66`. Do not move those tags.

The Mac Continuum app must include the node runtime inside the app so Connect bare, p2p node, and full node all work. `pack_macos.sh` copies `runtime/node` and `node/src/node.js` into `Shear.app/Contents/MacOS` before codesign, the same layout the Windows zip uses beside the executable. Do not attach a node archive.

```sh
git clone https://github.com/rgsneddon/shear-testnet.git
cd shear-testnet
git checkout feat/continuum-067-master
git pull
cd wallet
SYNC_POOL_WALLET=0 PACK_REBUILD=1 bash pack_macos.sh
python3 pack/sign_and_notarize.py
SYNC_POOL_WALLET=0 bash pack_macos.sh
gh release upload 0.70 dist/shear-wallet-0.70-macos.dmg --repo rgsneddon/shear-testnet
```

The second `pack_macos.sh` leaves `PACK_REBUILD` unset so the Developer ID seal from `pack/sign_and_notarize.py` survives `ditto`. The first pack stages the in-app node. The second pack does not copy it again. Do not pass `--clobber`. Do not attach any other file from this Mac.

Smoke: the window title is Shear 0.70. Connect bare, p2p node, and full node use the node runtime inside the app. Do not populate a datadir from this handoff.
