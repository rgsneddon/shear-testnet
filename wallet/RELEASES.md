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

## 0.49 (current)

Custody hasher Spendable is the last successful pool reconstruct (sealed hash notes plus real pool-withdraw landings). Pool `c02f787` (PR #39 and #40) is included: a missing `poolDest` no longer paints N×0.99 onto the hasher, and sealed notes replace a painted coinbase credit. Continuum still does not treat that pool balance as installed until `applyPoolSnapshot` wrote it onto the mining dest. A fatter note `amount`, a cached blockfound pot, an explorer rollup, an empty-book unlock, an orphaned height, a sibling slot, or a 504 does not put pot-class SHE back onto that dest. While a pool is attached, `confirmRound` / `settleTo` do not fund Spendable and `rememberSpendable` does not restore an archive figure before the first balance write. After the write, Spendable is the hash-note sum (plus real withdraw landings) and that sum stays at or under circulating supply. A HUD match, a dust paint, or Owed / In Reserve is not that check. One 504 is retried once. Force-sync is done only when the mining dest and every other attempted dest were written. Unlock saves the book only after that write. The pane repaints from that owned sum, so a sibling dest correction shows even when the mailbox figure stays put. Owed-π stays display-only. Admin custody display is not Continuum Spendable. This is not a UI clamp. Sign on Reserve withdraw does not credit Continuum or clear In Reserve until the pool accepts the withdraw tx. A pinned reserve credit does not raise the pin. An archive without a pool book does not sum history while a pool is attached. Public tag **0.49** (store `0.49.0+71`, Android `versionCode` 71). Asset `shear-wallet-0.49-android.apk` is packed with `flutter build apk --release --build-name=0.49.0 --build-number=71` after merge (this VM has no Android SDK). Download: https://github.com/rgsneddon/shear-testnet/releases/tag/0.49 — see `CONTINUUM-0.49-HANDOFF.md`. ShearK pin stays **2.5**. Tag 0.48 packs were not replaced. macOS `.dmg` stays the MacBook handoff (`CONTINUUM-0.46-MAC-HANDOFF.md`).

## 0.48

Tip sync asks local RPC, local pool, and the public pool together, with a 5s budget on each seed. A refused loopback no longer hides the live height. `shear_wallet --print-tip <file>` writes that height and exits. Reserve stays the unprivate VPN / IP confirm. There is no privacy hop. Public tag **0.48** (store `0.48.0+70`). ShearK pin stays **2.5**. Tag 0.47 packs were not replaced. macOS `.dmg` stays the MacBook handoff (`CONTINUUM-0.46-MAC-HANDOFF.md`).

## 0.47

Reserve send is the unprivate path. Vortex says a send shows your IP to the node and to use a VPN. Confirm **I already use a VPN / I accept exposing my IP**, then Send. There is no Shear privacy hop. A lock the chain accepts shows **Sent — please wait 6 confirmations**. Public tag **0.47** (store `0.47.0+68` on the release; tree display may read `0.47.1`). ShearK pin stays **2.5**. Tag 0.46 packs were not replaced. macOS `.dmg` stays the MacBook handoff (`CONTINUUM-0.46-MAC-HANDOFF.md`).

## 0.46

Reserve hop fee collates a sealed note when Continuum spendable already covers 0.05 SHE plus the levy. An empty or incomplete note book no longer claims that cover. Pool HTML and other non-JSON bodies surface as `pool returned an error page (http_N)`, not a FormatException. A successful Reserve lock shows **Sent — please wait 6 confirmations**. Lock, vote, and withdraw still post the sealed public-nanos vout. Fee stays **0.05 SHE**. ShearK pin stays **2.5**. Do not recut 0.45. Android `.apk` packed on Windows. macOS `.dmg` is a MacBook handoff (`CONTINUUM-0.46-MAC-HANDOFF.md`).

## 0.45

Privacy hop fee crypto (range proof + BP+/ADMIT) runs off the UI isolate. Android shows **Paying hop fee…** then **Connecting Privacy hop…**. Handshake budget is 15s and 3 tries. A VPN permission grant resumes connect without paying the 0.05 SHE fee again in the same session. Fee and connect failures snack the real reason and leave the hop off or in error. Fee stays **0.05 SHE** to `ssa1q4ke8sdxgma3sstuf6h0lsqh08w0e8qqkf7mfv6`. Reserve lock, vote, and withdraw post the sealed public-nanos vout the pool verifies. ShearK pin stays **2.5**. Do not recut 0.44. Android `.apk` and the Windows zip packed on Windows. Linux and Arch zips packed on the Helsinki pack host. macOS `.dmg` is a MacBook handoff (`CONTINUUM-0.45-MAC-HANDOFF.md`).

## 0.44

Reserve hop fee failures show the node reason instead of **not sent - try again**. Confirmed **Send without privacy hop** is not rewritten to the public-node IP warning (`allowPublicHttp` is honoured on submit). Vote uses the same allow. Fee stays **0.05 SHE** to `ssa1q4ke8sdxgma3sstuf6h0lsqh08w0e8qqkf7mfv6`. ShearK pin stays **2.5**. Do not recut 0.43. Android `.apk` packed on Windows. macOS `.dmg` is a MacBook handoff (`CONTINUUM-0.44-MAC-HANDOFF.md`).

## 0.43

Optional Reserve Privacy hop: one tap pays **0.05 SHE** to the pool fee dest `ssa1q4ke8sdxgma3sstuf6h0lsqh08w0e8qqkf7mfv6` (ssa1, never she1), then connects residual SHEAR-HOP / EU at `77.42.35.12:44044`. With hop up, Reserve Send does not need a local Shear node. Hop is optional — **Send without privacy hop** confirms **I already use a VPN / I accept exposing my IP**. Android VpnService is the residual dataplane. Light-sync tip display stays. Do not recut 0.42. Android `.apk` packed on Windows. macOS `.dmg` is a MacBook handoff (`CONTINUUM-0.43-MAC-HANDOFF.md`).

## 0.42

Built-in light sync: height 0 / empty fake stats never become the current tip. When a live same-genesis source reports height ≥ 1, Continuum follows that tip via header + compact-block catch-up (not the old FlyClient sampler). ADMITv2 / sealed-vin / compactTx stay unweakened; viewKey stays out of query strings. Do not recut 0.41. Android `.apk` packed on Windows. macOS `.dmg` is a MacBook handoff (`CONTINUUM-0.42-MAC-HANDOFF.md`).

## 0.41

ShearView collates the owner pending + recent confirmed set on wallet open (not only post-open deltas). Continuum Receive Copy ID / QR is the full payable she1. Flow maps a short she1 fingerprint to a clear advisory. Windows Flow Scan QR opens the camera/scanner page (webcam capability). Reserve/Flow spends wait for local RPC and never send via public pool HTTP. Do not recut 0.40. Android `.apk` packed on Windows. macOS `.dmg` is a MacBook handoff (`CONTINUUM-0.41-MAC-HANDOFF.md`).

## 0.40

Always follow live tip: tipBusy finally, 8s timeout, idle 4s poll, restore last sealed height on unlock. Do not recut 0.39. Android `.apk` packed on Windows. macOS `.dmg` is a MacBook handoff.

## 0.39

Light-on-receive: pending height&lt;1 poll is tip/balance only (no 1 Hz history+notes+memoOpen). Catch-up yields between header/compact batches. Continuum 0.39. Solo path is node + thin stratum (`npm run solo`) + CLI + ShearK — not `npm run pool`. Do not recut 0.38. Android `.apk` packed on Windows. macOS `.dmg` is a MacBook handoff.

## 0.38

Owner Continuum/ShearView for mined `ssa1`: dest-owned hash notes open and spend after 6 confs; pool-withdraw π landings list with amount/dest/status; destProof accepts destCommit homeDest so history is not explorer-redacted. ShearView list shows height, from/to, date, sums, snippet; tap → Resistance full tx. Copy dest stays homeDest. Posted Flow vin remains C̃-only. Do not recut 0.37. Android `.apk` packed on Windows. macOS `.dmg` is a MacBook handoff.

## 0.37

Hashbonus seals on-chain to the hasher dest immediately (dest20 + wrap). Continuum spendable and Shearview fold dest-owned hash notes after 6 confs. The 1 SHE pot stays custodial on the pool wallet until 30 confirms, then π auto-payout. Do not recut 0.36. Android `.apk` is packed on Windows. macOS `.dmg` is a MacBook handoff.

## 0.36

Dest-opening Shearview/pending (amounts-only pool history no longer wipes dest-owned rows). Continuum Reddit at https://www.reddit.com/r/shear/. Social buttons open https URLs with no query/fragment/referrer. ADMITv2 book `shear-testnet-v4`. GUI + CLI. Required miner ShearK **≥ 2.4**. Do not recut 0.35. Android `.apk` is packed on Windows. macOS `.dmg` is a MacBook handoff.

## 0.35

ADMITv2 book `shear-testnet-v4`. Short public `she1` / `ssa1` / `shear1` (dest20 / fingerprint). Native ADMITv2 send path. GUI + CLI. Magic pin `kBookMagic = shear-testnet-v4`. Required miner ShearK **≥ 2.4**. Do not recut 0.34. Android `.apk` is packed on Windows. macOS `.dmg` is a MacBook handoff.

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
