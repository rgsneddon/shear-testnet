# HANDOFF_OPS.md — Windows continue

**Written:** 2026-09-17T19:20Z from the Mac (`/Users/russellsneddon/shear`). HEAD **`f63c1e1`+** (dest-P bind `03fe7fe` is in this history).  
**Canonical GitHub tree:** https://github.com/rgsneddon/shear-testnet  
**Working branch:** `feat/admit-v2`  
**This file is the Windows start for Shear.** Miner binaries stay in **`rgsneddon/ShearK`**. Pins are the **latest** clients: wallet **0.35**, ShearK **2.4**. Do not recut older tags.

Other Shear GitHub repos (`rgsneddon/shear`, `rgsneddon/shear-wallet`, `rgsneddon/shear-pool`) are being deleted. Clone **this** repo only, plus **ShearK**.

---

## 0) Clone on the formatted Windows box

Command Prompt (`cmd.exe`):

```
gh auth login
gh repo clone rgsneddon/shear-testnet %USERPROFILE%\shear-testnet
gh repo clone rgsneddon/ShearK %USERPROFILE%\ShearK
cd /d %USERPROFILE%\shear-testnet
git checkout feat/admit-v2
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
| Fingerprint | `shear-book-law-2` … `ADMIT=ADMITv2\|RANGE=bpplus\|LEVY=weight\|NETWORK=shear-testnet-v4\|BITS=q16.16\|ASERT_TAU_MS=25920000` |
| Wallet | **0.35** (`wallet/lib/main.dart` `kWalletVersion`) |
| Miner | **ShearK 2.4** — https://github.com/rgsneddon/ShearK/releases/tag/2.4 |
| SHARE_BIND | `rx+noteCommit` |
| Mainnet | **blocked**. Genesis pin stays `2026-09-18T21:00:00+01:00`. Do **not** invent another. Do **not** set `SHEAR_MAINNET_EMIT=1`. Operator is **not** cutting over. |

Wallet zip on **this** repo: https://github.com/rgsneddon/shear-testnet/releases/tag/0.35  
Miner zip: https://github.com/rgsneddon/ShearK/releases/tag/2.4 (`ShearK-Miner-2.4-windows.zip` is this box’s job if still missing).

---

## 2) Live fleet (leave running)

SSH as **root** with key `~/.ssh/id_ed25519_restore_privacy_eu` (on the Mac; copy the **private** key to the Windows box yourself — it is not in git).

| Box | IP | Role | Units |
|-----|-----|------|--------|
| P2pnode / seed | `46.224.132.83` | `p2p.shear.digital:30303` | `shear-ibd-v4` (RPC 18332), `shear-ibd-v4-peer2` (RPC 18333) |
| p2pnode2 | `77.42.91.84` | second validating node | `shear-ibd-v4` |
| Dedicated-de | `178.105.187.178` | pool **is** the node | `shear-pool-v4` (stratum `:1111`, HTTP `127.0.0.1:8088`), `sheark-v4-afk` |

Tree on boxes: `/opt/shear-v4`. Data: `/var/lib/shear/testnet-v4` (peer-2 `/var/lib/shear/testnet-v4-peer2`).

DE miner dest: `ssa1qkdevt2u9k0494ynhkresghyjnugalv0muzzjf8gmd4reugrt072qc7y7dk94sjph0zuqaq7p4ytx9apymseshr3ft0.de2`

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

1. Pack **wallet 0.34 Windows zip** onto existing tag `0.34` on **this** repo (do not recut). Darwin cannot `flutter build windows`.
2. If `ShearK-Miner-2.4-windows.zip` is still missing, pack it on **`rgsneddon/ShearK`** tag `2.2` (PE + `example.bat`). Do not recut 2.1/2.0.
3. Confirm seed/peer-2/p2pnode2/DE share height+jroot after dest-P wipe; isolated reorg/Reserve/vort1 on this binary; optional new 24 h mine+Flow.
4. Keep mainnet blocked. No `SHEAR_MAINNET_EMIT=1`.

---

## 6) Build notes

- Linux node: `make -C crypto/native` on the box. Never copy a macOS `.node` to Linux.
- p2pnode2 (Ubuntu 26.04) has no gcc — copy Linux `shearadmit.node` from P2pnode.
- Wallet Flutter 3.44.6. Pin **0.34**. `--build-name=0.34`.
- Pool HTTP: `/api/stats`, not `/stats`.
- Operator admin vhost is **not** in git.

---

## 7) Do not

- Invent a mainnet genesis datetime.
- Dual-stack ADMITv1 + ADMITv2.
- Recut an older wallet or ShearK tag. Pins are **0.35** and **2.4**.
- Put ShearK inside the wallet zip.
- Attach Darwin as `*-linux.zip`.
- Commit `id_ed25519_*`, `deploy/nginx-*-secrets.conf`, or a live admin hostname.
- Restart soak-clock / `shear-ibd-v4-mine` unless you intend a new 24 h run.
