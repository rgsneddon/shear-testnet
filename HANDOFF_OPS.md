# HANDOFF_OPS.md — Windows continue

**Written:** 2026-09-17T19:20Z from the Mac (`/Users/russellsneddon/shear`). HEAD **`f63c1e1`+** (dest-P bind `03fe7fe` is in this history).  
**Canonical GitHub tree:** https://github.com/rgsneddon/shear-testnet  
**Working branch:** `main`  
**This file is the Windows start for Shear.** Miner binaries stay in **`rgsneddon/ShearK`**. Pins are **0.47** (wallet) and ShearK **2.5**. Pin **0.47**. Do not recut older tags. The MacBook cuts **macOS only** (`CONTINUUM-0.46-MAC-HANDOFF.md`). This Windows box packs APK, Windows zip, Linux/Arch, and site pins.

Other Shear GitHub repos (`rgsneddon/shear`, `rgsneddon/shear-wallet`, `rgsneddon/shear-pool`) are being deleted. Clone **this** repo only, plus **ShearK**.

---

## 0) Clone on the formatted Windows box

Command Prompt (`cmd.exe`):

```
gh auth login
gh repo clone rgsneddon/shear-testnet %USERPROFILE%\shear-testnet
gh repo clone rgsneddon/ShearK %USERPROFILE%\ShearK
cd /d %USERPROFILE%\shear-testnet
git checkout main
git pull
notepad HANDOFF_OPS.md
```

Private inventory (optional): `gh repo clone rgsneddon/handoff %USERPROFILE%\handoff`

---

## 1) Pins (do not recut)

| What | Pin |
|------|-----|
| Book / magic | `shear-testnet-v4` |
| ADMIT | ADMITv2 (Pasta arity-32 CDS; Membership, not Multiple) |
| Fingerprint | `shear-book-law-2` … `ADMIT=ADMITv2\|RANGE=bpplus\|LEVY=weight\|NETWORK=shear-testnet-v4\|BITS=q16.16\|ASERT_TAU_MS=25920000\|ASERT_HARDEN=2\|ASERT_EASE=2` |
| Wallet | **0.47** (`wallet/lib/main.dart` `kWalletVersion`) |
| Miner | **ShearK 2.5** — https://github.com/rgsneddon/ShearK/releases/tag/2.5 |
| SHARE_BIND | `rx+noteCommit` |
| Mainnet | **blocked**. Launch date is not decided. Do **not** set `SHEAR_MAINNET_EMIT=1`. Operator is **not** cutting over. |

Wallet zip on **this** repo: https://github.com/rgsneddon/shear-testnet/releases/tag/0.47  
Miner zip: https://github.com/rgsneddon/ShearK/releases/tag/2.5 (`ShearK-Miner-2.5-windows.zip` is this box’s job if still missing).

---

## 2) Live fleet (leave running)

SSH as **root** with key `~/.ssh/id_ed25519_restore_privacy_eu` (on the Mac; copy the **private** key to the Windows box yourself — it is not in git).

| Box | IP | Role | Units |
|-----|-----|------|--------|
| **shear-pool** | `77.42.91.84` | pool **is** the node; Linux/Arch pack host; Helsinki | `shear-pool.service` (stratum `:1111`, HTTP `:8088`, P2P `:30303`), `sheark-v4-afk` |
| **p2p-a** | `157.180.70.110` | seed `p2p.shear.digital:30303`; Helsinki | `shear-node.service` / `shear-ibd-v4` |
| **p2p-b** | `2.28.8.89` | satellite `r2r.shear.digital:30303`; Falkenstein | `shear-node.service` / `shear-ibd-v4` |
| **p2p-c** | `178.156.222.223` | satellite `b2b.shear.digital:30303`; Ashburn | `shear-node.service` / `shear-ibd-v4` |

Tree on every box: `/opt/shear-v4`. Data: `/var/lib/shear/testnet-v4`. Magic remains **`shear-testnet-v4`** (not v3, not v5). The epoch pot is a **fingerprint** change (`POT_SCHED` / `EPOCH_DAYS=4`); wipe every datadir together, then start the three P2P nodes, then the pool. Dedicated-de `178.105.187.178` and old seed `46.224.132.83` are dead — do not recut them.

Windows SSH key is `~\.ssh\id_ed25519` (this box). Mac key name remains `id_ed25519_restore_privacy_eu`.

Linux/Arch wallet zips are packed **on 77.42.91.84** (`wallet/pack/pack_linux_de.sh` with `SHEAR_WALLET=/opt/shear-v4/wallet`). Windows zip + Android APK are packed on this Windows box. macOS `.dmg` is MacBook-only (`CONTINUUM-0.46-MAC-HANDOFF.md`).

`/stats` on pool `:8088` prints `missing`; use **`/api/stats`**.

---

## 3) Dest-P bind fleet cut — 2026-09-17T19:16Z

Datadirs **wiped** on seed, peer-2, p2pnode2, Dedicated-de. Linux `shearadmit.node` rebuilt on P2pnode and copied to the other two boxes. Empty genesis jroot (dest-P bind does not change empty J):

`7af6bf27660f95c6bc5bd15a0ffb5fc57b8381b16392d049134e415bf8461e7a`

Seed + peer-2 + p2pnode2 shared that jroot at height 0 after restart. Pool (`sheark-v4-afk`) began mining immediately; seed logged `p2p_ingest prev` for heights 2–4 (missing block 1). **IBD catch-up may still be in flight** — confirm same height+jroot before treating the fleet as one tip.

P2pnode native bench (jroot then prove, dest-P blob):

| \|J\| | prove | verify | proof |
|------|-------|--------|-------|
| 1k | 163 ms | 41 ms | 14018 B |
| 10k | 211 ms | 69 ms | 20482 B |
| 100k | 294 ms | 89 ms | 26946 B |

VPS `node --test crypto/admit.bench.js tests/adversary/admit_v2.js crypto/admit.test.js`: **13/13 pass, 0 skip** (includes attacker-x + victim index).

`shear-ibd-v4-mine` and soak-clock stay **off**. Do not start them unless you want a new 24 h run.

Prior isolated soak on the **old** (pre-wipe) datadir: `reorg_exit=0`, `reserve_exit=0` (π SHE lock), `vort1_exit=0`. Re-run those on p2pnode2 against **this** binary when you resume soak.

---

## 4) Dest-P bind (in-tree **and** on `/opt/shear-v4`)

`p_com = P_j + wU` is 1-of-D at the same hidden slot as `C̃`. `dest_parent` = Vesta commit of `H_to_field` over the arity-32 dest P bucket. d0 / dest_leaf of the spent note stay off the wire. Blob ~2 KB larger; empty jroot unchanged.

Do **not** copy a Darwin `.node` onto Linux. p2pnode2 has no gcc — copy `shearadmit.node` from P2pnode.

---

## 5) Next work on Windows (priority)

1. Pack **wallet 0.47** Windows/Android on this box onto tag `0.47`. Linux/Arch on `77.42.91.84`. Darwin cannot `flutter build windows`.
2. **Android 0.47 APK is packed on this Windows box** (Flutter + Android SDK 36 + Eclipse Temurin JDK 17). See §6a. Do not wait for the Mac for Android.
3. **Apple-only artifacts stay a MacBook cut** (`CONTINUUM-0.46-MAC-HANDOFF.md`): Continuum 0.47 `.dmg` + CLI, iOS if cutting, ShearK-Miner 2.5 macOS zip. Do not recut 0.45.
4. If `ShearK-Miner-2.5-windows.zip` is still missing, pack it on **`rgsneddon/ShearK`** tag `2.5` (PE + `example.bat`). Do not recut 2.4/2.3.
5. Keep mainnet blocked. No `SHEAR_MAINNET_EMIT=1` without `SHEAR_MAINNET_EMIT_CONFIRM=I_UNDERSTAND_SHEAR_MAINNET`.

---

## 6) Build notes

- Linux node: `make -C crypto/native` on the box. Never copy a macOS `.node` to Linux.
- p2pnode2 (Ubuntu 26.04) has no gcc — copy Linux `shearadmit.node` from P2pnode.
- Wallet Flutter **3.47.x** (or 3.44.6). Pin **0.47**. `--build-name=0.47.0` / pubspec `0.47.0+63`.
- Pool HTTP: `/api/stats`, not `/stats`.
- Operator admin vhost is **not** in git.
- Stratum fleet: `SHEAR_STRATUM_BIND=127.0.0.1` and `SHEAR_STRATUM_AUTH=1` (or TLS in front of loopback). Reload with `deploy/reload-stratum-units.sh`. Checklist: `deploy/STRATUM_CHECKLIST.md`. Confirm `/api/stats` `stratumBind≠0.0.0.0` and `loginAuth≠dest-only` when AUTH is on; `alerts.stratumDrift` fires on non-loopback ∧ AUTH≠1. Do not enable dest-ban without ownership once AUTH is on. Do not invent TLS certs.

### 6a) Android APK on this Windows box

SDK is at `%LOCALAPPDATA%\Android\Sdk` (platform android-36, build-tools 36.0.0). JDK is Eclipse Temurin **17** at `C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot`. `JAVA_HOME` is often unset — set it for the pack, do not install another JDK.

```
set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
set ANDROID_SDK_ROOT=%ANDROID_HOME%
cd /d %USERPROFILE%\shear-testnet\wallet
flutter pub get
flutter build apk --release --build-name=0.47.0 --build-number=63
copy /Y build\app\outputs\flutter-apk\app-release.apk dist\shear-wallet-0.47-android.apk
copy /Y build\app\outputs\flutter-apk\app-release.apk ..\dist\shear-wallet-0.47-android.apk
gh release upload 0.47 dist\shear-wallet-0.47-android.apk --repo rgsneddon/shear-testnet --clobber
```

Fat APK only (`flutter build apk`, not `--split-per-abi`). `applicationId` `com.shear.shear_wallet`. Uninstall any old debug-signed build before sideload. Tag `0.47` has `shear-wallet-0.47-android.apk`.

### 6b) MacBook — Apple parts only

The Windows box cannot produce notarized macOS, iOS, or a Darwin ShearK binary. Full Apple cut list (wallet `.dmg` + CLI, iOS if cutting, **ShearK-Miner 2.5 macOS zip**): [`CONTINUUM-0.46-MAC-HANDOFF.md`](CONTINUUM-0.46-MAC-HANDOFF.md).

---

## 7) Do not

- Invent a mainnet genesis datetime.
- Dual-stack ADMITv1 + ADMITv2.
- Recut an older wallet or ShearK tag. Pins are **0.47** and **2.5**. Do not recut 0.45.

## 7) Stratum live stats vs tip units

In-repo pool units bind loopback and set AUTH (`deploy/shear-pool.service`). After copying units to the fleet:

```
sudo bash deploy/reload-stratum-units.sh
# expects /api/stats stratumBind=127.0.0.1 and loginAuth not dest-only
```

Live drift (`0.0.0.0` / dest-only / cleartext) is ops, not an in-repo default bug. `/api/stats` `alerts.stratumDrift` is the in-repo gate; refuse-start is prod-profile only so soak still boots. Terminate TLS in front of `127.0.0.1:1111`. Do not enable dest-ban without ownership once AUTH is on.
- Put ShearK inside the wallet zip.
- Attach Darwin as `*-linux.zip`.
- Commit `id_ed25519_*`, `deploy/nginx-*-secrets.conf`, or a live admin hostname.
- Restart soak-clock / `shear-ibd-v4-mine` unless you intend a new 24 h run.

---

## 8) Pool operator spend seed — restore (no hex in git)

Auto-payout signs from **`SHEAR_DATA/pool-spend.seed`** (mode **0600**) matching **`SHEAR_DATA/pool-miner.json` dest20**. Typical `SHEAR_DATA` is `/var/lib/shear/testnet-v4` (`shear-pool.service`). Never put the hex in a systemd `Environment=` line, EnvironmentFile, unit drop-in, or this repo. Prefer the 0600 file on disk.

Off-host vault (Windows, outside git): `C:\Users\rgsne\Desktop\SHEAR-SECRETS\` contains `pool-spend.seed`, `pool-miner.json`, and `SHA256SUMS`. Paths only — **do not paste seed hex here**. Desktop map: `C:\Users\rgsne\Desktop\NOTE-pool-spend-SEED-BACKUP.md`.

`GET /api/stats` must show `bootPoolOperator.signed=true` after a matching restore. Journal must not show `need_spend_key` / `auto_payout_unsigned` / `pool_operator_unsigned`.

## 9) Ops notes (non-blockers — not code-merge work)

- Fleet: run `deploy/reload-stratum-units.sh` (or set unit `SHEAR_STRATUM_BIND=127.0.0.1` + `SHEAR_STRATUM_AUTH=1` + TLS); confirm `/api/stats` (`stratumBind`, `loginAuth`, `alerts.stratumDrift`, `stratumConfigSource`). Cleartext warning remains until TLS.
- `SHEAR_ADMIN_HOST=pool.shear.digital` (or the Host operators actually browse); `/api/admin/*` is the desk API.
- Hostname: re-cert or DNS-retire `docs.shear.digital` + `whitepaper.shear.digital`; then HSTS + baseline headers (separate ops). In-repo copy now points at `https://shear.digital/docs/` and `https://shear.digital/whitepaper/`.
- Concentration: keep `alerts.concentration`; bring a second hasher — no multi-party security claims at `topDest=100%`.
- Seed hygiene: 0600 datadir restore; hex off git/units; watch first signed π auto-pay after `confirmedNeed=30` (path ready; `signed=true` live).
- Soak checklist (watch, not code): Continuum 0.47 on live worker Copy dest — mine → ≥6 conf → ShearView row → Resistance; fail release if empty after sealed hash notes. ASERT settle claim only after ≥288 blocks. Thin |J| until ≥10k.
- W7 (this tree): fork verify uses a trial vault clone at the fork root + `applyReserveBlock` per accepted fork block (VS-R1); owner history always `destProofOpen(homeDest)` and notes ingest before empty ShearView. Leave `wallet_api` previewWithdraw-only, biometrics unlock-token, prove stdin/FFI, TOTP mutate gate.

### Restore one-liner (after a datadir wipe)

Wipe deletes the on-host seed. Restore **both** files together, then start P2P nodes, then the pool.

From the Windows box that holds the vault (`~\.ssh\id_ed25519`):

```
scp -i %USERPROFILE%\.ssh\id_ed25519 %USERPROFILE%\Desktop\SHEAR-SECRETS\pool-spend.seed %USERPROFILE%\Desktop\SHEAR-SECRETS\pool-miner.json root@77.42.91.84:/var/lib/shear/testnet-v4/
ssh -i %USERPROFILE%\.ssh\id_ed25519 root@77.42.91.84 "chmod 600 /var/lib/shear/testnet-v4/pool-spend.seed /var/lib/shear/testnet-v4/pool-miner.json; systemctl restart shear-pool.service"
```

Signed check (prints `{signed:true}` only — never dumps hex):

```
ssh -i %USERPROFILE%\.ssh\id_ed25519 root@77.42.91.84 "cd /opt/shear-v4 && node --input-type=module -e \"import { bootPoolOperator } from './pool/src/pool_ident.js'; const b = bootPoolOperator({ dataDir: '/var/lib/shear/testnet-v4' }); if (!b.signed) process.exit(2); console.log(JSON.stringify({ signed: true }));\""
```

Then: `curl -sS http://127.0.0.1:8088/api/stats` → `bootPoolOperator.signed` is true. `journalctl -u shear-pool.service -n 80 --no-pager` has no `need_spend_key` / `auto_payout_unsigned`.

If seed missing: do **not** restart dest-only. Restore both vault files, `chmod 600`, restart `shear-pool.service`, confirm `signed=true`. Minting a new pair abandons that custodial dest and needs a coordinated fleet datadir wipe (below).

### Coordinated shear-testnet-v4 datadir wipe

Magic stays **`shear-testnet-v4`**. Keep Continuum pin 0.47 / ShearK 2.5. Wipe every datadir together, restore the pool ident from the Desktop vault onto the pool box, start the three P2P nodes, then the pool.

| Order | Box | IP | Stop | Data |
|------|-----|----|------|------|
| 1 | shear-pool | `77.42.91.84` | `systemctl stop shear-pool.service` | `/var/lib/shear/testnet-v4` |
| 2 | p2p-a | `157.180.70.110` | `systemctl stop shear-node.service` | `/var/lib/shear/testnet-v4` |
| 3 | p2p-b | `2.28.8.89` | `systemctl stop shear-node.service` | `/var/lib/shear/testnet-v4` |
| 4 | p2p-c | `178.156.222.223` | `systemctl stop shear-node.service` | `/var/lib/shear/testnet-v4` |

```
# on each box (pool first, then a/b/c):
systemctl stop <unit>
rm -rf /var/lib/shear/testnet-v4
mkdir -p -m 700 /var/lib/shear/testnet-v4
# pool only: restore pool-spend.seed + pool-miner.json from SHEAR-SECRETS (chmod 600)
# start p2p-a, p2p-b, p2p-c, THEN pool:
systemctl start shear-node.service   # on a/b/c
systemctl start shear-pool.service   # on 77.42.91.84 last
```

Do not recut dead hosts `178.105.187.178` / `46.224.132.83`. Do not set `SHEAR_MAINNET_EMIT`.
