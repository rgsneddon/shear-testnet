# Shear

**She is Private.** ADMITv2 membership over this book's notes, with confidential amounts. Proof of work elects the tip. Continuity-settled.

This is the **main Shear tree**: node, crypto, specs, wallet source, pool source, ShearK source, site, tests. Sibling release repos:

| Repo | What |
|------|------|
| [rgsneddon/shear](https://github.com/rgsneddon/shear) | This tree (build-your-own node + full project) |
| [rgsneddon/shear-wallet](https://github.com/rgsneddon/shear-wallet) | GUI + CLI wallet **releases** (every pin is an executable per platform) |
| [rgsneddon/ShearK](https://github.com/rgsneddon/ShearK) | Official miner pin + how-to |
| [rgsneddon/shear-pool](https://github.com/rgsneddon/shear-pool) | Open-source pool + deploy how-to |
| [rgsneddon/shear-testnet](https://github.com/rgsneddon/shear-testnet) | **shear-testnet-v4** working tree (ADMITv2 soak / public testnet) |

Offer a silent ID (`she1`) when someone pays you. Incoming coin lands on a revolving dest (`ssa1`) that the book writes. Rest-frame (`shear1`) stays in Closure. While this book has fewer than 10,000 notes the membership set is thin.

Each found block mints **1 SHE**, split among hasher dests that produced proven work that round. Each of those dests receives its own hash bonus on the next sealed block.

- Ticker: **SHE**
- Algo: **ShearHash-v3** (CPU, RandomX light)
- Miner pin: **ShearK-Miner 1.8** — https://github.com/rgsneddon/ShearK/releases/tag/1.8
- Wallet pin: **0.34** (GUI + CLI). Releases: https://github.com/rgsneddon/shear-wallet
- Stratum: `pool.shear.digital:1111`
- P2P: `p2p.shear.digital:30303` (`shear-testnet-v4`)
- Site: https://shear.digital
- Pool: https://pool.shear.digital
- Chain: `shear-testnet-v4`

Mainnet `shear-v1` is **not live**. Clients refuse to emit before the in-tree genesis instant. Do not invent a different datetime.

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

git clone https://github.com/rgsneddon/shear.git
cd shear
npm ci
cmake -S crypto/randomx -B crypto/randomx/build -DARCH=native
cmake --build crypto/randomx/build -j"$(nproc)"
make -C crypto/native
node node/src/node.js --print-config
```

`--print-config` must show `"magic":"shear-testnet-v4"`, `"admit":"ADMITv2"`, `"mainnet":false`.

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
export SHEAR_SEEDS=p2p.shear.digital:30303

node node/src/node.js
# or: node node/src/node.js --help
```

RPC stays on **loopback**. Wallet talks to `http://127.0.0.1:18332`. Optional systemd unit: `deploy/shear-node.service`.

IBD: headers then a window of getblocks (default 16 in flight). First checkpoint at height **1000**, then every **400**. Heavier fork that replaces a checkpoint hash is rejected (`reorg_checkpoint`).

### Mainnet later

Do **not** set `SHEAR_NETWORK=shear-v1` today. The process prints `clock_wait` until the frozen genesis instant. When mainnet is cut, the same tree and this how-to apply with `SHEAR_NETWORK=shear-v1` and a new datadir. Testnet v4 stays in [shear-testnet](https://github.com/rgsneddon/shear-testnet).

## Mine

Log in with wallet **Copy dest**:

```
ShearK-Miner --pool pool.shear.digital:1111 --user ssa1YOURDEST.worker --threads 4
```

`ssa1.worker` is the dest the wallet exported for this worker. Amounts are confidential; dests are stealth. Reuse links your blocks; rotate dests.

Wallet **0.34** syncs a local node at `127.0.0.1:18332` (headers + compact blocks). It does not use the old height sampler. Public pool HTTP submit is an advanced toggle.

Wallet tabs: Continuum, Flow, Resistance, Vortex, Shearview, Closure.
CLI covers the same functions (`dart run bin/shear.dart help`), including sign, The Reserve vote/rewards, vort1 create/register, and Closure backup/restore.
Backup: encrypted `shewall.bin` (same file in GUI and CLI; v1 files still open and reseal to v2). Hash samples collate per hasher dest and prune after 1000 confirmations; sealed transfers stay for the explorer. Optional bootstrap: [boot.shear.digital](https://boot.shear.digital) at height 1000, then every 400 blocks.

## Secrets

Never commit `SHEAR_DATA`, `admin.enc`, PEMs, or a live admin hostname. Pool admin host is `SHEAR_ADMIN_HOST` on the box only. Default seed is the hostname `p2p.shear.digital:30303` — never a raw IP in public copy.
