# Shear wallet releases

Canonical release home: **https://github.com/rgsneddon/shear-wallet**

Every tag ships **executables for each platform** (GUI + CLI where the OS allows):

| Asset | File |
|-------|------|
| macOS GUI | `shear-wallet-<pin>-macos.dmg` (Developer ID + notarized when cut on a Mac) |
| macOS CLI | `shear-<pin>-macos` (`dart compile exe bin/shear.dart`) |
| Windows GUI | `shear-wallet-<pin>-windows.zip` (`shear_wallet.exe`) |
| Windows CLI | `shear-<pin>-windows.exe` |
| Linux GUI | `shear-wallet-<pin>-linux.zip` (`shear_wallet` ELF) |
| Linux CLI | `shear-<pin>-linux` |
| Arch | `shear-wallet-<pin>-archlinux.zip` (`PKGBUILD` + linux bundle, `pkgver=<pin>`) |
| Android | `shear-wallet-<pin>-android.apk` |

No miner inside any wallet zip. Official miner is [ShearK](https://github.com/rgsneddon/ShearK).

GUI Closure Export and CLI `shear backup` write the same encrypted `shewall.bin`. GUI Import and CLI `shear restore` read it. v1 files still open.

Historical pins below were cut on `rgsneddon/shear-testnet`. New pins (0.34+) attach here. Missing Windows on some old tags is leftover — **0.34 and later must not ship without every platform executable.**

## 0.35 (current)

ADMITv2 book `shear-testnet-v4`. Short public `she1` / `ssa1` / `shear1` (dest20 / fingerprint). Native ADMITv2 send path. GUI + CLI. Magic pin `kBookMagic = shear-testnet-v4`. ShearK **2.3**. Do not recut 0.34.

## 0.34

ADMITv2 book `shear-testnet-v4`. GUI + CLI. Sign Flow / pool-pull / Reserve vote / lock. vort1 create + register + call. Reserve staked rewards + claim. Closure backup/restore (v1 migrate). Magic pin `kBookMagic = shear-testnet-v4`. ShearK **2.2**. Mainnet `shear-v1` refused (`clock_wait`). Windows / Linux / Arch zips pack on the Windows box.

## 0.33 — 2026-09-13

v3-only node-sync. Magic `shear-testnet-v3`. Sync on the login splash. Leftover v2 nodes dropped. macOS / Android / Linux / Arch. No Windows zip on this tag.

## 0.32 — 2026-09-13

Node-sync testnet wallet. Local RPC `127.0.0.1:18332`. Not flyclient. Last pin before 0.33 splash sync.

## 0.31 — 2026-09-12

Last flyclient pin. ADMITv1 Flow + Reserve lock/vote/withdraw. Magic `shear-testnet-v3`. No Windows zip.

## 0.30 — 2026-09-11

Dest-bind privacy (`ssa1` only). Hash bonus 1u per proven floor share to each hasher dest. Full `she1` payment-code login. Miner ShearK 1.6.

## 0.29 — 2026-09-09

First live genesis bind drops leftover pre-reset txs. FlyClient locators restored.

## 0.28 — 2026-09-09

Read-header sync (headers 1…tip). FlyClient locators removed.

## 0.27 — 2026-09-07

Whitepaper FitH. Reserve deposits two-row scroller. Remove vortice from this wallet only.

## 0.26 — 2026-09-07

Flow Send keeps sent / not sent. Levy never exceeds 0.001 SHE. Miner ShearK 1.5.

## 0.25 — 2026-09-07

Sealed-epoch vote pane remembers the choice. Hashbonus banner 11 decimal SHE.

## 0.24 — 2026-09-06

Continuum mempool levy on Reserve lock and vote.

## 0.23 — 2026-09-06

Cast vote. First ≥π vote uses portal dest-opening. CONFIRM gate.

## 0.22 — 2026-09-06

YOUR VOTE WILL BE SEALED. One vote per portal per epoch.

## 0.21 — 2026-09-06

Signed Reserve votes post `kind=vote`. AppBar sync bar.

## 0.20 — 0.14

Interim testnet pins (Reserve / Flow / leftover Windows). Do not recut.

## 0.13

Public download pin of that week. Do not restore 0.12.

## 0.9 — 0.8

Linux/Arch leftover zip pins. PKGBUILD `pkgver` matches the pin.

## 0.7

Reserve vortice: Solidity + EVM runtime, live hash-bonus enact.

## 0.6

Password seal, SAF export, Import shewall.bin, Continuum split. Desktop export writes the picked path (no bytes on macOS).

## 0.5

Password-sealed shewall.bin, export path, Continuum socials.

## 0.4

Mac-cut pin; leftover Windows.

## 0.3

Owned spendable send, Join 99-day claim, extra-mint lock.

## 0.2

INTERNET on Android release so pool sync works. Full-block Continuum/Shearview.

## 0.1 / 0.1.0

Windows zip packer. Continuum height follows pool tip. Reconstructed spendable on first sync.

## 0.0.9

Continuum live pending hashes and receives; spendable on block-found.

## 0.0.8

she1 Flow login, Closure rest-frame, send pays dest.

## 0.0.7

1e-11 SHE per hash, eight-digit public amounts.

## 0.0.6

The Join, 11-decimal SHE, vort1. deploy keys.

## 0.0.5

No mining in the GUI.

## 0.0.4

she1 payment code as public ID.

## 0.0.3 / 0.0.1

Chronoflux tabs, lean prune.
