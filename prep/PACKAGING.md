# Packaging — this run (prep only)

Launch: **Friday 11 September 2026**, 21:00 BST. Do not publish genesis hash. Do not pack Windows/Linux wallet here.

| Artefact | Built this run? | Notes |
|---|---|---|
| Branch `prep/mainnet-shear-v1` | yes | from 0.27 tip `f8dbf2d` |
| `crypto/network.js` + foreign-magic tests | yes | |
| Genesis generator `crypto/genesis_mainnet.js` | yes | hash left **TBD** in `prep/genesis-mainnet.json` (not mined/published) |
| Node `--network mainnet` | yes | separate datadir `mainnet` |
| `deploy/shear-node-mainnet.service` | yes | no stratum, no 1111 |
| `deploy/seed-p2p.shear.digital.md` | yes | do not start until cutover |
| ShearK 1.5 magic-only Makefile `mainnet` | **yes** (local `ShearK-Miner-mainnet`) | `--print-config` `"magic":"shear-v1"`; default `ShearK-Miner` stays testnet magic; binary not committed |
| Wallet `shear_network.dart` mainnet profile | yes | pin remains **0.27** |
| Pool copy | snapshot + `prep/pool-mainnet/` only | **not deployed** |
| Staged `prep/site/index.html` | yes | unpublished |
| Linux node tarball | **no** | commands below |
| ShearK mainnet linux zip | **no** | `make -C sheark-miner mainnet` then zip `ShearK-Miner-mainnet` |
| Wallet macOS/Android recut | **no** | reuse shipped 0.27 Amelia cut; do not recut 0.26 |
| Windows/Linux wallet zips | **no** | leftover on the laptop — see `prep/WINDOWS-HANDOFF.md` |

## Wallet 0.27 reuse (do not recut)

- macOS dmg sha256 `144ae73633eca22558d9dfcd07a10dd5b4d36c5b72227b869619ad3768fa6df3`
- Android apk sha256 `425b5168f94354a1692804a820f9c1c1f44d49fa91b6148d22e8dcc72c61a01f`
- If a later `[mainnet]` labelled cut is needed: same pin **0.27**, notarize commands as `wallet/pack/sign_and_notarize.py` + `PACK_REBUILD=0 ./pack_macos.sh`. Do not invent 0.28.

## Node tarball (later, this machine)

```
git archive --format=tar.gz --prefix=shear-node-mainnet/ HEAD -o dist/shear-node-mainnet.tar.gz
```

Do not install as a running `shear-testnet-v2` book on 46.224.132.83.
