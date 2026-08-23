# SHEPLAN — Shear full build (canonical)

**Saved:** 2026-08-23 (second save: original `/plan` + every later lock, then operator stop)  
**Use this file as the `/goal` source of truth.**  
Tree: `/Users/russellsneddon/shear` · private GitHub `rgsneddon/shear`.  
Copies: `/Users/russellsneddon/shear/SHEPLAN.md` · `/Users/russellsneddon/Desktop/SHEPLAN.md` · `/Users/russellsneddon/SHEPLAN.md`.

Do not start mainnet. **Testnet first.** Operator asked to **stop work** after this save; a new `/goal` will resume from this file.

This document is the approved `/plan` plus every later lock from the same session (including the wallet 0.0.1 goal). Later locks override earlier rows when they conflict.

---

## Product

Clean independent Nakamoto-consensus coin. Continuity-settled (one hash = one transaction). Private by default. No operator book as the source of truth. **New project**, not an upgrade of any existing chain. Live books, balances, and miners of other networks stay untouched.

| Item | Value |
|------|--------|
| Name | **Shear** |
| Ticker | **SHE** |
| Domain | **shear.digital** (Namecheap) |
| Pool | **pool.shear.digital:1111** |
| Server | Germany **178.105.187.178** (`ssh de`) |
| Repo | Private GitHub monorepo **`rgsneddon/shear`** |
| Consensus | Nakamoto most-work, **header** PoW, P2P gossip |
| Block time | **90 s** |
| Resistance | Header `bits`; **ASERT** per block toward 90 s; floor 14 bits; ceiling 32 bits; genesis 21 |
| Algo (public) | **ShearHash** · personalization **`ShearHash-v1`** · 8-round SHA256 · wire `client=ShearHash` |
| Address | **`shear1`** (bech32, HRP `shear`) on **both** testnet and mainnet; networks isolated by magic, not HRP |
| Testnet magic | **`shear-testnet-v1`** |
| Mainnet magic | **`shear-v1`** (later, separate genesis; never merge) |
| Miner | Official C miner, all platforms. **No dual-login fee.** Do **not** use the phrase “feeless miner” anywhere in shipped copy, code comments, UI, README, pool HTML, miner `--print-config`, handoff, or binaries. |
| P2P | **30303/tcp** |
| HTTP | **80/443** nginx + Let’s Encrypt |
| Stratum bind | Public pool **`0.0.0.0:1111`**; HTTP dashboard **`127.0.0.1:8088`** behind nginx |
| Launch | **Public testnet first.** Mainnet blocked until the testnet checklist is green **and** the operator says go. |
| Run this work as | **`/goal`** (adversarial verification). Not a plain chat implement. |

### Names that must never appear in Shear artifacts

No other coin, pool, miner, wallet, chain, or project name in Shear code comments, docs, UI, website, announcements, or binaries. Internally the implementer may copy structure from existing trees on this Mac; the published tree is Shear-only. CI grep gate.

Also banned as a phrase: **“feeless miner”** / **“feeless”** describing the miner. Policy remains: no dual-login fee; hash bonuses are not fee’d; public pool may take **1% of the 1 SHE pot only**.

---

## Emissions (three paths — do not collapse)

### 1. Block pot — **1 SHE**

Every valid block mints **exactly 1 SHE** in the coinbase (`kind: pot`).

- Solo: the finder.
- Pool: split by proven work in that round. Public pool may take **1% of this pot only** for development.
- Hash bonuses are **not** fee’d.
- The **1 SHE pot never changes** via Vortex votes.

### 2. Per-hash bonus — **0.000000001 SHE × hashes, to each hasher**

Each valid hash in the **current block round** mints **1 nano (0.000000001 SHE)** to the **miner who produced that hash**.

Alice 4 000 hashes + Bob 1 000 hashes in the same round → Alice 4 000 nanos, Bob 1 000 nanos, same coinbase (`kind: hash`). The block finder does **not** scoop other miners’ hash bonuses.

Continuity root commits the samples. After 100 confirmations the sample list may be pruned; coinbase outputs stay.

Vortex vote (every 400 days) may move this bonus **+10⁻¹⁰**, **−10⁻¹⁰**, or leave it.

**Lag-1 settlement (lock):** the hashed header cannot change after hashing starts. Snapshot `roundHashes` when a block is found; pay those hash-bonus outputs on the **next** job/coinbase (`pendingPayout`). Do **not** invent 1 nano at login. Do **not** reset `roundHashes` before paying. Test: two miners N and M both get their own nanos.

### 3. The Reserve — stake + BoE interest (only dapp that may mint extra SHE)

The Reserve is a Vortex dapp, **not** a third coinbase line for mining.

- Deposit **π SHE** (3.141592653589793…) to unlock a vote for the current 400-day Vortex.
- Deposited SHE is **locked for that Vortex**.
- Locked principal accrues **Bank of England Base Rate** interest for 400 days.
- After Vortex end: withdraw **principal + interest** to Continuum (spendable).
- Hardcoded program id: **`shear-reserve-v1`**.
- Consensus helper: **`extraMintAllowed(programId)`** is true **only** for `shear-reserve-v1`. `verifyBlock` / `append` reject unfunded extra txs otherwise.

**Who may draw on protocol emissions**

| Path | Mints SHE? |
|------|------------|
| Block pot (1 SHE) | yes, coinbase |
| Per-hash bonus (10⁻⁹ × hashes, per miner) | yes, coinbase |
| **The Reserve** (BoE interest on locked stake) | **yes — the only dapp allowed to** |
| Any other Vortex dapp (third-party staked coins, vaults, etc.) | **no.** Operators must **top up** a reward pool with **existing circulating SHE**. Consensus **rejects** a mint from any program id other than `shear-reserve-v1`. |

BoE oracle must not reorg blocks or steal the 1 SHE pot.

---

## Wallet (Chronoflux) — 0.0.1 lock

### Tabs

| Tab | Symbol | Purpose |
|-----|--------|---------|
| Continuum | ∇·J = 0 | Balances / overview. Spendable SHE after a block is found, plus this round’s pending hashes. |
| Flow | J^μ | Send / receive `shear1`. |
| Resistance | η | Mining stats + current Resistance. Desktop Mine spawns the **bundled** official C miner (no second installer). Phones keep an in-app Dart ShearHash hasher. |
| Vortex | Ω^{μν} | General contract surface (deploy / call). Third parties cannot print SHE. |
| Shear | S_{μν} | Emission + rewards explainer (1 SHE pot + 0.000000001 SHE per hash to each hasher + Reserve). |
| Reserve | π | The Reserve dapp: lock, BoE interest, vote. |
| **Closure** | **G_{μν}** | **Password and backup.** Geometric closure of the wallet. Encrypts **`shewall.json`**. |

Hover/long-press **explainers on every tab** (the symbol + a short sentence). Copy must be Shear-only.

Look matches the pool: light background, dark ink, cyan/blue/green accents (`#eef3f8` / `#0d2137` or equivalent). Shipped wallet copy contains **zero** names of any other coin or project.

Testnet only: magic `shear-testnet-v1`, addresses `shear1`, view key generated and persisted.

### Ledger behaviour (wallet functions)

Like a real explorer wallet, not a book credit UI:

- **Pending hashes** this open round (1 nano each) sit in pending. Not spendable. Not an explorer row yet.
- **Spendable at block found.** `confirmRound` moves pending hash bonus (+ any pot share) into spendable and writes an explorer-visible coinbase row.
- History / explorer rows from the pool/node, not a fake book.

### Backup — `shewall.json`

One-file copy/import (wallet.dat-*style* restore, not Berkeley DB).

- Filename: **`shewall.json`**. Honest suffix because the dump is JSON.
- Envelope kind: `shear-shewall-v1` (plaintext session) / `shear-shewall-v1-enc` (sealed).
- Password seals the file with **AES-256-GCM** + **PBKDF2**.
- Closure tab is the password/security surface (Chronoflux **G_{μν}**).
- Do **not** ship a `.dat` / BDB wallet.

### 0.0.1 installers (this Mac)

This Mac cuts every platform it can. **Windows / Linux / Arch zips are not built on this Mac.**

| Artifact | Rule |
|----------|------|
| **macOS `.dmg`** | Volume **Shear 0.0.1**. Contains `Shear.app`, bundled `shear-miner`, **Applications symlink**, and **`Move to Applications.txt`**. User must put the app in Applications, not run from the image. |
| Android **APK** | Cut if SDK allows. |
| iOS | Unsigned zip is enough if `--no-codesign` / no team profile. Skip-log a real SDK/signing failure; do not fake an IPA. |
| Desktop packages | Bundle the official ShearHash C miner next to the app. Resistance Mine uses that binary. `--selftest` / `--print-config`: `client`/`algorithm` **ShearHash**. **No “feeless” fields.** |
| Phones | In-app hasher; must not require the C binary. |

GitHub **`rgsneddon/shear`** pin **0.0.1** on **one** tag (no sibling). Mac-cut artifacts on that tag. **No mainnet zip.**

Handoff leftover (Windows laptop): attach `shear-wallet-0.0.1-windows.zip` / `-linux.zip` / `-archlinux.zip` with the miner **inside** those zips.

---

## Privacy

- Private by default.
- Amounts visble on the public explorer.
- Identities obfuscated (rotating shear tags). No plain `shear1` on public rows.
- Wallet generates a **view key**. Pasting it on the explorer reveals **only that user’s** transactions.

---

## Consensus

### Header — **120 bytes** little-endian

Field list is authoritative. Packed size is **120** (4+32+32+32+8+4+8), not 112.

| Offset | Size | Field |
|--------|------|--------|
| 0 | 4 | `version` u32 = 1 |
| 4 | 32 | `prev_block_hash` |
| 36 | 32 | `merkle_root` (coinbase first) |
| 68 | 32 | `continuity_root` (Merkle of collated hash samples) |
| 100 | 8 | `timestamp` u64 Unix ms |
| 108 | 4 | `bits` u32 Resistance |
| 112 | 8 | `nonce` u64 |

PoW: `ShearHash(header) ≤ target(bits)`.

### Validation (every full node)

1. Version recognised.  
2. `prev_block_hash` matches previous header hash.  
3. Timestamp > MTP of previous 11; not more than 2 hours future.  
4. `bits` equals ASERT for this height.  
5. Header PoW meets target.  
6. Merkle root matches ordered txs.  
7. Continuity root matches ordered samples.  
8. Coinbase first: **exactly 1 SHE pot** plus **exactly 10⁻⁹ SHE × each hasher’s hashes** (per-miner `kind: hash` outputs). Hash-bonus counts come from the **lag-1 snapshot**, not a rewritten live header.  
9. Other txs: signatures, no double-spend, amounts balance.  
10. Extra mint only if program id is `shear-reserve-v1` (`extraMintAllowed`).  
11. Block weight cap starts at **4 MB**.

Most-work: `work = 2^256 / (target + 1)`. Heaviest valid chain wins. Equal work keeps first-seen. Full reorgs allowed. No operator finality window.

v1 continuity = Merkle (or sorted hash). Polynomial/KZG is a later version bump of the same 32-byte field.

Genesis: fair launch, mine from block 1, **no premine, no founder reward, no ICO, no airdrop/bridge**. Empty continuity root. Announced future genesis time.

---

## Pool (new coin — not a copy of the old book pool)

The current operator pool has flaws (synthetic puzzles, book-side credit). **Shear needs real work**, not a restyle of that credit path.

The public pool is a **stratum in front of a local validating node**. Mint happens only when that node accepts a header that meets Resistance.

### Every job must include the full header

| Field | Required | Why |
|-------|----------|-----|
| `version` | yes | hashed |
| `prev_block_hash` | yes | hashed; stale if tip moves |
| `merkle_root` | yes | hashed |
| `continuity_root` | yes | hashed |
| `timestamp` | yes | hashed |
| `bits` | yes | hashed; share vs block target |
| `nonce` | zeroed; miner fills | hashed |
| `jobId` | yes | bind submit |
| `height` | yes | coinbase height |
| `shareBits` | yes | vardiff |
| `blockBits` | yes | equals header `bits` |
| `header` | 240 hex of the 120-byte template | what the miner hashes |

If any field is missing, do **not** serve the job. A found block is that header + winning nonce + the body the node already bound to the template. The pool does **not** invent roots.

Must not: credit value on a non-header share; seal a window the node cannot re-validate; unlist a still-connected hasher when a block is found; dual-login a miner fee; mention other projects; say “feeless miner”.

**Pool audit** (required): auth, duplicate shares, job replay, DoS, fee confusion, TLS vs plaintext, GPU/ASIC refuse, miners stay listed across a found block, lag-1 payout (two miners both paid their own hashes).

### Pool UI

Same **layout** as the current operator pool (banner, GET YOUR MINER COMMAND LINE, stat tiles, miner table, last transfers). **Light** palette (cream/white cards, dark ink, cyan/blue/green accents). Shear names only. Nav: Pool, Explorer, Hashrates, Miner, Wallet, Node, Vortex — no other-product links.

### Miner CLI lock

`--pool host:port` must parse host and port separately. Copy host into its own buffer, **strip the port**, do **not** restore the colon (bug was `127.0.0.1:1111` becoming `127.0.0.1:1111:1111`). `--selftest` vector `6e95b903…`. `--print-config` has **no** feeless fields.

---

## Architecture

```
Miners --stratum:1111--> Pool (optional) --header template--> Local node
Any full node <---- P2P :30303 ----> any full node
Wallet / explorer --> node RPC / pool wallet API
Vortex runtime    --> chain state
The Reserve       --> only emission-drawing dapp
```

Germany is **one equal node + one public pool + nginx**, not a master. If Germany is down, the heaviest valid tip elsewhere continues.

Do **not** copy “live book credits hashes” as the mint path.  
Do **not** stop or reconfigure live book systemd units on Germany (`rpt-gnfp-pool`, `rpt-gnfp-cminer`, or any other non-Shear unit).

---

## Monorepo

`github.com/rgsneddon/shear` (private). Create if missing.

```
shear/
  SHEPLAN.md      this file
  specs/          consensus, emissions, pool, reserve
  crypto/         ShearHash, header, Merkle, addresses, ASERT, cloak, mint
  node/           validate, reorg, P2P :30303, RPC
  miner/          official C miner
  pool/           stratum :1111 + light dashboard + wallet_api
  wallet/         Flutter 0.0.1 Chronoflux tabs + shewall.json
  vortex/         contract runtime (Solidity-compatible transpile, not a full EVM in v1)
  reserve/        The Reserve
  explorer/       amounts on; identities sheared; view-key search
  site/           shear.digital
  deploy/         systemd + nginx for 178.105.187.178
  WINDOWS_HANDOFF.md  pointer to rgsneddon/handoff Shear section
  tests/
```

Fiat-denominated Vortex contracts are in-scope as a field + oracle interface; third-party staking still cannot mint.

---

## Windows leftover

Required. Pointer file: `shear/WINDOWS_HANDOFF.md` → **https://github.com/rgsneddon/handoff** section **Shear**.

Do **not** mix Shear pins into other projects’ leftover rows. No sibling tags.

Laptop leftover (wallet 0.0.1 lock, supersedes “wallet later” wording):

1. `shear-miner-0.1.0-windows.zip` on the miner tag if that Darwin miner already shipped — `--selftest` ok, `client=ShearHash`, default `pool.shear.digital:1111`.
2. **Now also:** `shear-wallet-0.0.1-windows.zip` / `-linux.zip` / `-archlinux.zip` with the miner **inside** the zip, on the **same** `v0.0.1` tag as the Mac wallet.
3. No mainnet genesis zip until testnet exit is approved.

---

## Server (Germany 178.105.187.178) — Part 3 included

Firewall ports already opened. DNS A: `@`, `www`, `pool` → `178.105.187.178`.

SSH: `ssh de` (root, `~/.ssh/id_ed25519_restore_privacy_eu`). **Do not stop or reconfigure live book units.** Add **new** nginx sites and **new** systemd units `shear-node`, `shear-pool`.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx certbot python3-certbot-nginx ufw git curl

# /etc/nginx/sites-available/shear.digital
# server_name shear.digital www.shear.digital; root /var/www/shear.digital;
sudo mkdir -p /var/www/shear.digital /var/www/pool.shear.digital
sudo ln -sf /etc/nginx/sites-available/shear.digital /etc/nginx/sites-enabled/
# same pattern for pool.shear.digital
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d shear.digital -d www.shear.digital
sudo certbot --nginx -d pool.shear.digital
```

Units once binaries exist: `shear-node` (P2P 30303, RPC localhost), `shear-pool` (`0.0.0.0:1111`, HTTP 127.0.0.1:8088). Tree on server: `/opt/shear`. Pool HTML: `/var/www/pool.shear.digital/`.

Done when `https://shear.digital` and `https://pool.shear.digital` serve TLS and 1111 is bound.

---

## Phases (order is load-bearing)

0. Private repo, README, nginx+certbot, Coming Soon (site says **testnet**).  
1. Specs + crypto + 120-byte header tests + ShearHash C/JS vectors.  
2. Node consensus: validate, most-work, reorg, coinbase 1 SHE + per-miner hash nanos, Reserve-only extra mint.  
3. P2P :30303.  
4. Header-template mining; C miner; pool :1111 + **audit** + **light UI** + lag-1 payout.  
5. Wallet Continuum / Flow / Resistance / Shear / Vortex / Reserve / **Closure**; `shewall.json`; 0.0.1 Mac-cut installers.  
6. Explorer + view keys.  
7. **Public testnet `shear-testnet-v1`.** Gate.  
8. Vortex + The Reserve **on testnet**.  
9. Mainnet only after checklist + operator go.

**Out of first ship:** polynomial continuity, full EVM, third-party fiat rails beyond The Reserve oracle, mainnet-before-testnet, copying the old book credit path, the phrase “feeless miner”.

### Testnet-exit checklist (all required before mainnet)

- [ ] Two or more full nodes stay in consensus across a Germany restart  
- [ ] Heavier valid chain adopted; mutated/foreign books rejected  
- [ ] Miner earns only on valid header PoW  
- [ ] Pool audit closed; jobs always carry the full header  
- [ ] View-key explorer does not leak other users  
- [ ] No forbidden foreign-project strings  
- [ ] Hash bonus paid **per hasher**, not only the finder (lag-1 snapshot)  
- [ ] Third-party dapp mint rejected; Reserve mint allowed  
- [ ] Zero “feeless miner” in shipped artifacts  
- [ ] Operator explicitly approves leaving testnet  

---

## Tests (gating)

1. Header encode/decode + ShearHash C vs JS vectors.  
2. Validate / most-work / reorg / coinbase: 1 SHE pot + per-miner 10⁻⁹ × hashes.  
3. Two-node P2P reorg.  
4. Miner `--print-config` is ShearHash, **zero** fee login, **zero** “feeless” fields; local stratum accepts a share.  
5. Pool: miner stays listed across a found block; incomplete header job is refused; two miners N/M both paid lag-1 hashes.  
6. Wallet close/reopen keeps `shear1` + honest spendable; encrypted `shewall.json` restores address and txs; tabs include Closure.  
7. Explorer: no `shear1` without view key.  
8. `https://shear.digital` and `https://pool.shear.digital` TLS; `ss` shows 1111.  
9. Second node IBDs testnet and stays on tip after Germany restart.  
10. `shear-reserve-v1` may mint interest; any other program id mint fails.  
11. Wallet 0.0.1: identity + view key persist; theme tokens light/dark ink; DMG Applications advice; bundled miner `--selftest`; grep gate for foreign names and “feeless”.

Run consensus, pool, and wallet identity tests **twice**.

---

## Risks

- Consensus bugs fork funds → testnet until reorg tests are green.  
- Low hashrate 51% at launch — fair launch still the policy.  
- Germany is the first public seed; P2P must work without it.  
- BoE oracle is Reserve-only; never consensus-critical.  
- Name leakage from copy-paste → grep gate.  
- Do not touch live book systemd on 178.105.187.178.  
- Lag-1 vs “pay this round in the same header” — header roots cannot change after hashing; snapshot is mandatory.  
- iOS IPA may fail without a team/profile; unsigned zip + skip log is the bar.  

---

## Status at operator stop (2026-08-23)

Work **stopped on request**. Do not continue the wallet ship until a new `/goal`.

### Done (on disk; not all pushed)

- Private repo `rgsneddon/shear` exists. Last **pushed** commits: `ad6866d` (testnet 0.1.0 header PoW / miner / pool), `bcfc304` (lag-1 round hashes; Reserve-only extra mint; public stratum :1111). **No git tags.**
- Specs + crypto (120-byte header, ShearHash C/JS, merkle, address HRP `shear` → `shear1`, ASERT, mint/`extraMintAllowed`).
- Node: `chain.js` coinbase per-miner `kind:hash`; `verifyBlock` rejects unfunded extra txs unless Reserve.
- Pool: header jobs, `snapshotRound` / `pendingPayout`, light `public/index.html`, `wallet_api.js` (untracked), systemd `shear-pool` on Germany `0.0.0.0:1111`.
- Miner C: `--selftest` / `--print-config` / `--pool` / `--user`; host-buffer port parse fix; feeless fields stripped in **local** miner source (uncommitted).
- Germany: DNS A `@`/`www`/`pool` → 178.105.187.178; certs live; `shear-pool.service` active. **Live book units still running — leave them.**
- Wallet 0.0.1 Flutter tree at `shear/wallet/` (**untracked**): seven tabs including Closure; shewall.json AES-GCM; pending vs spendable at `confirmRound`; hover explainers; light pool palette.
- Mac-cut packages on disk under `wallet/dist/` (not on GitHub):
  - `shear-wallet-0.0.1-macos.dmg` (~18 MB)
  - `shear-wallet-0.0.1-android.apk` (~47 MB)
  - `shear-wallet-0.0.1-ios-unsigned.zip` (~6.6 MB, unsigned)

### Not done / dirty at stop

- Local uncommitted Shear edits: `.gitignore`, README, this SHEPLAN, `WINDOWS_HANDOFF.md`, miner C + miner tests, `node/src/store.js`, pool HTML, `pool/src/pool.js`, specs, plus untracked `pool/src/wallet_api.js` and entire `wallet/`.
- **No `v0.0.1` tag / GitHub release.** Mac-cut artifacts not uploaded.
- `WINDOWS_HANDOFF.md` still says miner pin **0.1.0** / wallet later 0.1.0 — wallet leftover rewrite **not finished**.
- `rgsneddon/handoff` last Shear push `c71cf3d` still describes the miner leftover and still uses “feeless miner” language. Wallet 0.0.1 leftover row may be a local unpushed edit — treat as incomplete.
- Live pool HTML on Germany may still contain “feeless” until `/var/www/pool.shear.digital/` is redeployed from the stripped local file.
- P2P :30303, explorer, Vortex runtime, Reserve dapp, second full node, public testnet-exit checklist — still open.
- Mainnet blocked.

---

## Suggested `/goal` line

```
/goal Execute SHEPLAN.md at /Users/russellsneddon/shear/SHEPLAN.md (and Desktop/SHEPLAN.md). Build Shear testnet first as specified: private rgsneddon/shear, 120-byte header PoW, 1 SHE pot + 0.000000001 SHE per hash to each hasher in the round (lag-1 snapshot), The Reserve (shear-reserve-v1) is the only dapp that may mint extra SHE, third-party staking must top up, new header-template pool on :1111 with light UI, C miner (no dual-login fee; never say “feeless miner”), Germany nginx+certs without touching live book units, wallet 0.0.1 Chronoflux tabs including Closure G_{μν}, encrypted shewall.json, Mac DMG/APK/iOS-unsigned plus Windows leftover zips in rgsneddon/handoff Shear section. Zero other-project names. Do not start mainnet.
```

If the next goal is only to **finish the interrupted 0.0.1 wallet ship**, use:

```
/goal Resume SHEPLAN wallet 0.0.1 ship from Status at operator stop: commit+push shear (including untracked wallet/), tag/release v0.0.1 with wallet/dist Mac-cut artifacts, finish handoff leftover (Windows/Linux/Arch 0.0.1 zips with miner inside; no feeless language), rewrite WINDOWS_HANDOFF.md, scp stripped pool HTML to de:/var/www/pool.shear.digital/, grep feeless=0. Do not start mainnet. Do not stop live book units.
```
