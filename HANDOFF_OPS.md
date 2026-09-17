# HANDOFF_OPS.md — Windows continue

**Written:** 2026-09-17T19:15Z from the Mac (`/Users/russellsneddon/shear`).  
**Canonical GitHub tree:** https://github.com/rgsneddon/shear-testnet  
**Working branch:** `feat/admit-v2`  
**This file is the Windows start for Shear.** Miner binaries stay in **`rgsneddon/ShearK`**. Pins are the **latest** clients: wallet **0.34**, ShearK **2.2**. Do not recut older tags.

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
| Wallet | **0.34** (`wallet/lib/main.dart` `kWalletVersion`) |
| Miner | **ShearK 2.2** — https://github.com/rgsneddon/ShearK/releases/tag/2.2 |
| SHARE_BIND | `rx+noteCommit` |
| Mainnet | **blocked**. Genesis pin stays `2026-09-18T21:00:00+01:00`. Do **not** invent another. Do **not** set `SHEAR_MAINNET_EMIT=1`. Operator is **not** cutting over. |

Wallet zip on **this** repo: https://github.com/rgsneddon/shear-testnet/releases/tag/0.34  
Miner zip: https://github.com/rgsneddon/ShearK/releases/tag/2.2 (`ShearK-Miner-2.2-windows.zip` is this box’s job if still missing).

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

## 3) Soak — **stopped** 2026-09-17T19:06Z

Operator asked to stop the soak. Do **not** restart `shear-ibd-v4-mine` or the soak-clock timer unless you mean to.

| | |
|--|--|
| Clock start | 2026-09-17T09:11Z |
| Stopped | ~2026-09-17T19:06Z (~10 h, **not** 24 h) |
| Tip | height **275**, magic `shear-testnet-v4`, ADMITv2 |
| Shared jroot | `f2a546d939b86cd5abcbb3041fdc34a6c06ceb189108e9d5bdcc789c5d8c6e71` (seed = peer-2) |
| Flow | `/var/lib/shear/testnet-v4/soak-flow.json` — `soak-flow-1789657598274` at height 195 |
| Isolated Reserve | p2pnode2 `reserve_exit=0` (lock **π SHE**, `votesIncrease=1`) |
| Isolated reorg | `reorg_exit=0` n=8 depth=7 |
| Isolated vort1 | `vort1_exit=0` |

Stopped: `shear-ibd-v4-mine` (disabled), `shear-v4-soak-clock.timer`, soak-recheck timer.  
Left up: seed, peer-2, p2pnode2, pool, `sheark-v4-afk`.

---

## 4) In-tree, **not** on the VPS nodes

Commit **`03fe7fe`** (and follow-ups on this branch) bind dest **P** as 1-of-D `p_com = P_j + wU` at the same hidden slot as `C̃`. jroot formula unchanged; **blob grew ~2 KB**. Deploying that native addon over the live datadir will fail IBD of already-sealed spends.

To cut it: wipe `SHEAR_DATA` on **every** public node, rsync this tree (Linux `shearadmit.node`, **exclude Darwin `.node`**), reset chain, re-peer. Do that only when you mean a new soak.

Native tests: `attacker_x_cannot_spend_victim_index`. JS: `crypto/admit.test.js`, `tests/adversary/admit_v2.js` (0 skip).

d0 / XOR-path / dest_leaf of the spent note are **not** on the wire (CDS).

---

## 5) Next work on Windows (priority)

1. Pack **wallet 0.34 Windows zip** onto existing tag `0.34` on **this** repo (do not recut). Darwin cannot `flutter build windows`.
2. If `ShearK-Miner-2.2-windows.zip` is still missing, pack it on **`rgsneddon/ShearK`** tag `2.2` (PE + `example.bat`). Do not recut 2.1/2.0.
3. When you want ADMITv2 dest-P bind on the fleet: wipe + deploy this branch, new 24 h mine+Flow.
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
- Recut an older wallet or ShearK tag. Pins are **0.34** and **2.2**.
- Put ShearK inside the wallet zip.
- Attach Darwin as `*-linux.zip`.
- Commit `id_ed25519_*`, `deploy/nginx-*-secrets.conf`, or `kyrusfables` admin host.
- Restart soak-clock / `shear-ibd-v4-mine` unless you intend a new 24 h run.
