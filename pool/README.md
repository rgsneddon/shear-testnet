# shear-pool

Open-source Shear pool: stratum on `:1111`, HTTP dashboard on loopback `:8088`, optional P2P.

This cut speaks **shear-testnet-v4** (ADMITv2, Bulletproofs+, weight levy, Q16.16 packed ASERT toward **90s** blocks). When mainnet `shear-v1` is cut, update `MAGIC_TESTNET` / systemd `SHEAR_NETWORK` and this README — do not dual-stack.

Public site example in this repo is **https://mypool.site**. Operator admin is **https://mypool.site/admin**. Point those names at your box. Prod examples require `SHEAR_ADMIN_HOST` (generic example `mypool.site`); do not commit a real operator subdomain. First-run is deny-by-default when that env is unset.

## What you get

- Stratum bind `SHEAR_STRATUM_BIND` (testnet dest-only may use `0.0.0.0`; **prod example is `127.0.0.1` behind a TLS terminator**). `SHEAR_STRATUM_AUTH=1` (prod example on) requires an ed25519 login signature over `shear-stratum-login-v1`. Dev dest-only is `SHEAR_STRATUM_AUTH=0`. Unauthenticated dest login is an ephemeral tag, not dest ownership. Do not enable dest-ban without ownership once AUTH is on. Testnet cleartext TCP is temporary — see `deploy/nginx-stratum-tls.conf`. This tree does not ship TLS certificates. Confirm bind and login via `GET /api/stats` (`stratumBind` should be `127.0.0.1`, `loginAuth` should be `ed25519` when auth is on). Non-loopback ∧ AUTH≠1 sets `alerts.stratumDrift`. Reload fleet units with `deploy/reload-stratum-units.sh` (`SHEAR_STRATUM_BIND=127.0.0.1`, `SHEAR_STRATUM_AUTH=1`).
- Pin **ShearK-Miner 2.5** (or current cut) for the 128-byte job
- HTTP `127.0.0.1:8088` (nginx terminates TLS)
- Validating node + pool in one process (same magic as the book)
- Two meters: `hashrate` is a time-window / EMA (does not spike when a round resets). `proven_round` / `roundHashes` is accepted dest-bound work this block for hash-bonus minting and **does** reset at block found.
- Operator desk: username + password + 2FA (TOTP)

## Requirements

- Linux (this is the documented host)
- Node.js 18+
- A C toolchain (`make`, `cc`) for `crypto/native`
- nginx + Let’s Encrypt for the public name
- Disk for `SHEAR_DATA` (fresh dir on a magic change — wipe v3 `chain.bin`)

## Install

```bash
git clone https://github.com/rgsneddon/shear-pool.git /opt/shear-pool
cd /opt/shear-pool
npm install
make -C crypto/native
```

If `shearadmit.node` / `shearhash.node` fail to build, the pool cannot verify ADMITv2 or ShearHash. `npm run pool` exits if ShearHash-v3 cannot verify; shares would otherwise come back `native_missing`. Build RandomX then `make -C crypto/native shearhash.node` before mining. Do not copy a Darwin `.node` onto Linux.

## Datadir

```bash
sudo mkdir -p /var/lib/shear/testnet-v4
sudo chown "$USER":"$USER" /var/lib/shear/testnet-v4
```

v3 and v4 are different books. Do not reuse a `shear-testnet-v3` datadir.

## systemd

```bash
sudo cp deploy/shear-pool.service /etc/systemd/system/shear-pool.service
sudo cp deploy/shear-p2p.service /etc/systemd/system/shear-p2p.service
sudo systemctl daemon-reload
sudo systemctl enable --now shear-pool.service shear-p2p.service
sudo journalctl -u shear-pool -f
```

The pool unit does not bind `:30303`. `shear-p2p.service` (`node node/src/node.js --mode=p2p-sync`) owns P2P and feeds verified blocks to the pool on `127.0.0.1:30313`. Fleet peers run `deploy/shear-node.service` in that same p2p-sync mode, not this pool process. Solo localhost stratum stays `npm run solo`.

You should see a JSON line with `"magic":"shear-testnet-v4"`, `"stratum":1111`, `"http":8088`, `"p2p":0`.

Optional environment (drop-in `/etc/systemd/system/shear-pool.service.d/local.conf`):

| Variable | Meaning |
|---|---|
| `SHEAR_DATA` | Chain + pool state |
| `SHEAR_STRATUM` | Stratum port (default 1111) |
| `SHEAR_STRATUM_BIND` | Stratum bind host (default `127.0.0.1` behind TLS; set `0.0.0.0` only for local dest-only) |
| `SHEAR_STRATUM_AUTH` | `1` = require signed login (prod example on; `0` = dest-only for local dev) |
| `SHEAR_ALERT_CONCENTRATION` | `/api/stats` `alerts.concentration` threshold (default 0.5) |
| `SHEAR_ALERT_SHARE_BLOCK` | `/api/stats` `alerts.shareBlock` threshold (default 10000) |
| `SHEAR_HTTP` | Loopback HTTP (default 8088) |
| `SHEAR_P2P_IPC` | Localhost TCP to the P2P sidecar (default `127.0.0.1:30313`). The pool does not bind `:30303` |
| `SHEAR_SEEDS` | Used by the sidecar, not by the pool process |
| `SHEAR_ADMIN_HOST` | Dedicated admin hostname (required in prod examples; first-run is deny-by-default when unset) |
| `SHEAR_POOL_MINER` | Pool dest (`ssa1…`) if you do not want a generated ident |
| `SHEAR_PAYOUT_SWEEP_MS` | How often the pool pays miners who have accrued at least π SHE. The shipped unit sets `4000` (one π lot per miner per tick). |

## nginx

Example vhost: `deploy/nginx-mypool.site.conf`.

```bash
sudo cp deploy/nginx-mypool.site.conf /etc/nginx/sites-available/mypool.site
# edit server_name + certificate paths
sudo ln -s /etc/nginx/sites-available/mypool.site /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d mypool.site
```

Public miners: `ShearK-Miner --pool mypool.site:1111 --user YOUR_SSA1.worker`

Unauthenticated stratum login is dest-format only (no ownership proof). Soft-deny is per-IP; dest/tag durable bans require accepted shares or an operator ban.

`/api/stats` publishes `poolFeeBps`, `feeDest`, `hashrate` (HUD/EMA), `proven_round` per worker (hash-bonus), `topDestSharePct`, `shareBlockRatio`, `lostWorkHashes`, `hashBusy`, `alerts.concentration`, `alerts.shareBlock`, `autoPayoutMinNanos` (π SHE), and `stratumCleartextWarning`. Miner unpaid pot-share (after 1%) plus **fee-free hash bonus** auto-pay to the login `ssa1` at π SHE; the pool pays the levy. `/api/miners/:tag/withdraw` and `/api/pool/withdraw` return **410** `auto_payout`. Operator-trust model: admin password+TOTP can pause/kick/ban/withdraw; mutating calls append `admin-audit.jsonl` (including withdraw). Audit file: `$SHEAR_DATA/admin-audit.jsonl`.

## Solo / second pool

`SHARE_BIND=rx+noteCommit` is book law, so a third-party pool or solo template can validate the same shares. Run a second `shear-pool` with its own `SHEAR_DATA` and `SHEAR_SEEDS` pointing at `p2p.shear.digital:30303` (plus `r2r` / `b2b`). Do not claim multi-party mining security until a second path is live.

## Admin desk (first run)

1. Open **https://mypool.site/admin** (or your dedicated admin host if `SHEAR_ADMIN_HOST` is set).
2. Create **username** + **password** (8+ characters, confirm).
3. Enrol **2FA** (scan the QR, or type the authenticator key + 6-digit code). The desk stays closed until 2FA confirms.
4. Later logins need username, password, and the authenticator code.

If `SHEAR_ADMIN_HOST` is unset, first-run setup is **not** open to the world: a non-loopback request without an explicit setup token is `setup_forbidden`. Allowed first-run paths are the configured admin host, loopback + `SHEAR_ADMIN_SETUP=1`, or the in-process setup token. Do not leave first-run on a public hostname.

Admin HTML is `noindex`. Do not put operator secrets, SSH hosts, or a real admin subdomain in this git tree.

## 90 second blocks

Header `bits` on this book is **Q16.16 packed work**, not an integer leading-zero rung. Integer rungs could not represent the ~1.09× work 90s needs, so live v3 sat near 82s in a ±15% dead band. Packed ASERT (`BITS=q16.16`, half-life 288×90s) is the 90s law. Pool vardiff is not that knob. ShearK still submits integer share bits; the node applies the fractional target. Job stays 128 bytes.

## Mainnet later

When `shear-v1` is cut: new magic, wipe `SHEAR_DATA`, retarget systemd/nginx copy, and amend any admin hostname you chose. Do not run v4 and mainnet in one process.

## License

MIT. See `LICENSE`.
