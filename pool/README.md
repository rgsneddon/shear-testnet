# shear-pool

Open-source Shear pool: stratum on `:1111`, HTTP dashboard on loopback `:8088`, optional P2P.

This cut speaks **shear-testnet-v4** (ADMITv2, Bulletproofs+, weight levy, Q16.16 packed ASERT toward **90s** blocks). When mainnet `shear-v1` is cut, update `MAGIC_TESTNET` / systemd `SHEAR_NETWORK` and this README — do not dual-stack.

Public site example in this repo is **https://mypool.site**. Operator admin is **https://mypool.site/admin**. Point those names at your box. A dedicated admin hostname is optional (`SHEAR_ADMIN_HOST`); do not commit a real operator subdomain.

## What you get

- Stratum `0.0.0.0:1111` (ShearK 128-byte job; pin **ShearK-Miner 1.7**)
- HTTP `127.0.0.1:8088` (nginx terminates TLS)
- Validating node + pool in one process (same magic as the book)
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

If `shearadmit.node` / `shearhash.node` fail to build, the pool cannot verify ADMITv2 or ShearHash. Fix the native build before mining.

## Datadir

```bash
sudo mkdir -p /var/lib/shear/testnet-v4
sudo chown "$USER":"$USER" /var/lib/shear/testnet-v4
```

v3 and v4 are different books. Do not reuse a `shear-testnet-v3` datadir.

## systemd

```bash
sudo cp deploy/shear-pool.service /etc/systemd/system/shear-pool.service
sudo systemctl daemon-reload
sudo systemctl enable --now shear-pool.service
sudo journalctl -u shear-pool -f
```

You should see a JSON line with `"magic":"shear-testnet-v4"`, `"stratum":1111`, `"http":8088`.

Optional environment (drop-in `/etc/systemd/system/shear-pool.service.d/local.conf`):

| Variable | Meaning |
|---|---|
| `SHEAR_DATA` | Chain + pool state |
| `SHEAR_STRATUM` | Stratum port (default 1111) |
| `SHEAR_HTTP` | Loopback HTTP (default 8088) |
| `SHEAR_P2P_PORT` | Public P2P (default 30303). `0` disables |
| `SHEAR_SEEDS` | Comma-separated `host:port` peers |
| `SHEAR_ADMIN_HOST` | Dedicated admin hostname (optional) |
| `SHEAR_POOL_MINER` | Pool dest (`ssa1…`) if you do not want a generated ident |

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

## Admin desk (first run)

1. Open **https://mypool.site/admin** (or your dedicated admin host if `SHEAR_ADMIN_HOST` is set).
2. Create **username** + **password** (8+ characters, confirm).
3. Enrol **2FA** (authenticator key + 6-digit code). The desk stays closed until 2FA confirms.
4. Later logins need username, password, and the authenticator code.

If `SHEAR_ADMIN_HOST` is set, first-run setup is allowed only on that host (not on the public pool name). Loopback + `SHEAR_ADMIN_SETUP=1` is an emergency first-run on the box itself.

Admin HTML is `noindex`. Do not put operator secrets, SSH hosts, or a real admin subdomain in this git tree.

## 90 second blocks

Header `bits` on this book is **Q16.16 packed work**, not an integer leading-zero rung. Integer rungs could not represent the ~1.09× work 90s needs, so live v3 sat near 82s in a ±15% dead band. Packed ASERT (`BITS=q16.16`, half-life 288×90s) is the 90s law. Pool vardiff is not that knob. ShearK still submits integer share bits; the node applies the fractional target. Job stays 128 bytes.

## Mainnet later

When `shear-v1` is cut: new magic, wipe `SHEAR_DATA`, retarget systemd/nginx copy, and amend any admin hostname you chose. Do not run v4 and mainnet in one process.

## License

MIT. See `LICENSE`.
