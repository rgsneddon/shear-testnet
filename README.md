# Shear

**She is Private.** ADMITv2 membership over this book's notes, with confidential amounts. Proof of work elects the tip. Continuity-settled.

This is the **main Shear tree** (`rgsneddon/shear-testnet`): node, crypto, specs, wallet source, pool source, site, tests. Official miner pin lives in a **separate** repo:

| Repo | What |
|------|------|
| [rgsneddon/shear-testnet](https://github.com/rgsneddon/shear-testnet) | **This tree** — node, wallet, pool, site, ADMITv2 (`shear-testnet-v4`) |
| [rgsneddon/ShearK](https://github.com/rgsneddon/ShearK) | Official miner pin + how-to (keep this repo) |

Windows ops start: [`HANDOFF_OPS.md`](HANDOFF_OPS.md). MacBook cuts Apple-only artifacts (Continuum 0.41 `.dmg`/CLI, iOS if cutting, ShearK 2.5 macOS): [`CONTINUUM-0.41-MAC-HANDOFF.md`](CONTINUUM-0.41-MAC-HANDOFF.md).

Offer a silent ID (`she1`) when someone pays you. Incoming coin lands on a revolving dest (`ssa1`) that the book writes. Rest-frame (`shear1`) stays in Closure. While this book has fewer than 10,000 notes the membership set is thin.

Each found block mints **1 SHE**, split among hasher dests that produced proven work that round. Each of those dests receives its own hash bonus on the next sealed block.

- Ticker: **SHE**
- Algo: **ShearHash-v3** (CPU, RandomX light)
- Miner pin: **ShearK-Miner 2.5** — https://github.com/rgsneddon/ShearK/releases/tag/2.5
- Wallet pin: **0.41** (GUI + CLI). Releases: https://github.com/rgsneddon/shear-testnet/releases/tag/0.41
- Stratum: `pool.shear.digital:1111`
- P2P: `p2p.shear.digital:30303` (seed), `r2r.shear.digital:30303`, `b2b.shear.digital:30303` (`shear-testnet-v4`)
- Site: https://shear.digital
- Pool: https://pool.shear.digital
- Chain: `shear-testnet-v4`

Mainnet `shear-v1` is **not live** and is not yet scheduled. Clients refuse to emit unless `SHEAR_MAINNET_EMIT=1` **and** `SHEAR_MAINNET_EMIT_CONFIRM=I_UNDERSTAND_SHEAR_MAINNET`. Fingerprint must include `POT_SCHED` + `EPOCH_DAYS=400` + oracle policy before emit. Do not set those env vars.

Block pot starts at **1.00 SHE** and falls **0.01 SHE per Vortex epoch** to a **0.20 SHE** floor. Testnet epochs are **4 days** (so rollovers can be watched); mainnet epochs are **400 days**. Hash bonus stays governance-voted. Reserve interest is oracle-frozen each epoch. The pot schedule is not votable.

One proven floor share mints hash-bonus units onto the dest that hashed. User transfers are signed Flow. The header commits a continuity root. Full nodes validate shareBatch until prune-1000; money vouts remain. The public pool is an equal node with a stratum.

## Packages

| Path | What |
|------|------|
| `specs/` | Header, validation, pool jobs, emissions, ADMITv2 |
| `crypto/` | ShearHash, header codec, Merkle, addresses, native ADMIT + BP+ |
| `node/` | Validating daemon, P2P `:30303`, RPC `:18332` |
| `wallet/` | GUI (Flutter) + CLI (`bin/shear.dart`) |
| `sheark-miner/` | Official C miner (ShearK-Miner) |
| `pool/` | Stratum `:1111` + dashboard |
| `site/` | shear.digital |

## Build your own node

Linux x86_64 (Debian/Ubuntu). Do **not** copy a macOS `shearhash.node` onto Linux.

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential cmake python3 pkg-config libssl-dev
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
# Rust (native ADMITv2 / BP+)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

git clone https://github.com/rgsneddon/shear-testnet.git
cd shear-testnet
git checkout main
npm ci
cmake -S crypto/randomx -B crypto/randomx/build -DARCH=native
cmake --build crypto/randomx/build -j"$(nproc)"
make -C crypto/native
node node/src/node.js --print-config
```

Headers check (runtime Node is not enough — `ls` must show `node_api.h`). If `ls` fails, install Node *with headers* (NodeSource / nodejs-devel), not a headerless binary:

```bash
node -v   # need 20+
node -e "console.log(require('path').join(process.config.variables.node_prefix||'/usr','include/node'))"
ls "$(node -e "process.stdout.write(require('path').join(process.config.variables.node_prefix||'/usr','include/node'))")/node_api.h"
```

NODE_INC recovery — do **not** `find /usr` only if empty (that sets `NODE_INC=.` and the compile shows bare `-I.`):

```bash
# Prefer Node's own prefix; fall back to find near the node binary
export NODE_INC="$(node -e "const fs=require('fs');const p=require('path');const base=process.config.variables.node_prefix||'/usr';const d=p.join(base,'include/node');if(fs.existsSync(p.join(d,'node_api.h'))){process.stdout.write(d);process.exit(0)}process.exit(1)" 2>/dev/null || dirname "$(find "$(dirname "$(dirname "$(readlink -f "$(which node)")")")" /usr/local /usr -name node_api.h 2>/dev/null | head -1)")"
echo "NODE_INC=$NODE_INC"   # must be a real directory, NOT . or empty
test -f "$NODE_INC/node_api.h" || { echo "Still missing headers — reinstall Node with devel/include"; exit 1; }
make -C crypto/native
```

`--print-config` must show `"magic":"shear-testnet-v4"`, `"admit":"ADMITv2"`, `"mainnet":false`. Other OS copy/paste deps (Fedora, Arch, openSUSE, macOS, Windows/WSL) live on https://shear.digital#solo-mine.

### Run

```bash
sudo mkdir -p /var/lib/shear/testnet-v4
sudo chown "$USER":"$USER" /var/lib/shear/testnet-v4

export SHEAR_DATA=/var/lib/shear/testnet-v4
export SHEAR_NETWORK=shear-testnet-v4
export SHEAR_P2P_PORT=30303
export SHEAR_P2P_BIND=0.0.0.0
export SHEAR_RPC_PORT=18332
export SHEAR_RPC_BIND=127.0.0.1
export SHEAR_SEEDS=p2p.shear.digital:30303,r2r.shear.digital:30303,b2b.shear.digital:30303

node node/src/node.js
# validator only (no stratum). Solo mining:
# npm run solo
# or: node node/src/node.js --solo
# or: node node/src/node.js --help
```

RPC stays on **loopback**. Wallet/CLI talks to `http://127.0.0.1:18332`. Optional systemd unit: `deploy/shear-node.service`.

Solo is **node + thin stratum + CLI + ShearK**. `npm run pool` is the public-pool operator stack — do not use it as the beginner solo path. Export all three `SHEAR_SEEDS` in the **same shell** as `npm run solo`. Outbound to those seeds is required; opening inbound `30303` alone does not sync. Status `height=0 want=0 ibd=false` is an empty tip that is **not** fetching and has no live peer ahead — `ibd=true` while catching up (outstanding getblocks, syncing, or a live peer tip is taller), not merely `want>0`. Mid-IBD `unsigned@N` then `prev`: pull tip, rebuild native, `SHEAR_GETBLOCK_BATCH=1` — do not wipe. Check `nc -vz p2p.shear.digital 30303`. Full copy/paste: https://shear.digital#solo-sync-stuck

IBD: headers then a window of getblocks (default 16 in flight). First checkpoint at height **1000**, then every **400**. Heavier fork that replaces a checkpoint hash is rejected (`reorg_checkpoint`).

### Mainnet later

Do **not** set `SHEAR_NETWORK=shear-v1` or `SHEAR_MAINNET_EMIT=1`. The process prints `clock_wait`. When mainnet is cut, use a **new** datadir.

## Mine

Solo (node + thin stratum + CLI + ShearK) — see https://shear.digital#solo-mine:

```
npm run solo
dart run bin/shear.dart dest --rpc http://127.0.0.1:18332
ShearK-Miner --pool 127.0.0.1:1111 --user ssa1YOURDEST.solo --threads 4
```

Optional public pool (not solo):

```
ShearK-Miner --pool pool.shear.digital:1111 --user ssa1YOURDEST.worker --threads 4
```

`ssa1.worker` / `ssa1.solo` is Continuum/CLI Copy dest — the `ssa1` shown on screen, not a rotated mailbox. Amounts are confidential; dests are stealth. Reuse that mining mailbox so blocks stay linked.

Wallet **0.41** syncs a local node at `127.0.0.1:18332` (headers + compact blocks). It does not use the old height sampler. Public pool HTTP submit is an advanced toggle.

Wallet tabs: Continuum, Flow, Resistance, Vortex, Shearview, Closure.
CLI covers the same functions (`dart run bin/shear.dart help`), including sign, The Reserve vote/rewards, vort1 create/register, and Closure backup/restore.
Backup: encrypted `shewall.bin` (same file in GUI and CLI; v1 files still open and reseal to v2). Hash samples collate per hasher dest and prune after 1000 confirmations; sealed transfers stay for the explorer. Optional bootstrap: [boot.shear.digital](https://boot.shear.digital) at height 1000, then every 400 blocks.

## Secrets

Never commit `SHEAR_DATA`, `admin.enc`, PEMs, or a live admin hostname. Pool admin host is `SHEAR_ADMIN_HOST` on the box only. Default seed is the hostname `p2p.shear.digital:30303` (also `r2r.shear.digital:30303`, `b2b.shear.digital:30303`) — never a raw IP in public copy.
