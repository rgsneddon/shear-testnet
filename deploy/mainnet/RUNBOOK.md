# R18a runbook: rebuild the three hosts on their mainnet OSes

Status: **prepared, not run.** Nothing in this directory has run on any host.
Every wipe, reinstall, firewall change, install or start needs Russell's GO,
one host at a time (docs/ROADMAP.md, "R18a and R18b detail").

R18a rebuilds the hosts after shear-dev (R15) and before the v12 cut (R16),
so the v12 testnet and stressnet run on the OSes mainnet will use. The
teardown checklist below is also R18b's: before the mainnet release deploy,
it clears everything testing left behind.

## The hosts

| Role | Host | OS | Runs | Firewall |
|------|------|----|------|----------|
| pool | 77.42.91.84 | Ubuntu Server LTS (current) | `shear-p2p` (owns :30303), `shear-pool` (stratum :1111, HTTP :8088 on loopback), nginx (80/443) | ufw: `firewall/ufw-pool.sh` |
| p2p-a | 157.180.70.110 | Debian stable | `shear-node` (:30303) | nftables: `firewall/nftables-p2p-a.conf` |
| p2p-b | 2.28.8.89 | Fedora Server (current) | `shear-node` (:30303) | firewalld: `firewall/firewalld-p2p-b.sh` |

Each host's firewall uses its own OS's tool. All three are inbound TCP 22,
80, 443, 1111, 8080 and 30303 only, IPv4 and IPv6. The Hetzner firewall is
not managed from here, so the host firewall is the one that counts.

Order: p2p-b first, then p2p-a, then the pool. p2p-b is the most different
OS and the least central, so it is the safest to learn on, and the pool,
which serves the site and the client downloads, goes last.

## Files

| File | What it does | Changes a host? |
|------|--------------|-----------------|
| `scripts/inventory.sh` | Lists OS, disk, users, services, timers, cron, listeners, firewall, test paths, shear units | No, read-only |
| `scripts/teardown.sh` | Removes everything testing left behind | Dry run by default. `--apply` also needs `SHEAR_TEARDOWN_GO=<hostname>` |
| `scripts/check_host.sh <role>` | Verify, don't paint: fails on a wrong OS, an extra public port, test leftovers, or a unit that restarts itself, copies files or names an IP | No, read-only |
| `firewall/*` | The three firewalls | The two scripts are dry runs without `--apply`. The nft file is checked with `nft -c` first |
| `units/*.service` | Mainnet units: `Restart=no`, a `shear` user, sandboxed, seeds by DNS name | Only when installed |

## The unit rules

- **No silent recovery.** Every unit has `Restart=no` and no `OnFailure=`. A
  stopped node or pool stays stopped until an operator looks. `check_host.sh`
  and `systemctl status` show it. A quiet restart that hides a fault is what
  the standing rule forbids.
- **No phone-home.** A unit reaches nothing but its seeds, by DNS name
  (`p2p.shear.digital`, `r2r.shear.digital`). No telemetry, no update check.
- **No datadir or tip.json copies.** No `ExecStartPre` seeds a datadir. Every
  node syncs from genesis and verifies every block itself.
- **The pool is never consensus.** `shear-pool` takes verified blocks from
  its own `shear-p2p` node on loopback; that node owns the tip.
- Each process has its own datadir under `/var/lib/shear/`, the only path it
  may write (`ProtectSystem=strict`).

## Before the rebuild (one host at a time)

1. **Prerequisites (R18a in the roadmap):**
   - CI has Debian stable and Fedora build-and-run jobs.
   - A short live shear-dev session has run on each target OS, with the results recorded.
2. **GO** from Russell for this host's inventory.
3. **Inventory:** run `scripts/inventory.sh > inventory-<role>-before.txt`.
   Save it in the launch log. Note what must be kept:
   - SSH keys;
   - TLS certificates (`/etc/letsencrypt`);
   - nginx site configs;
   - on the host that serves it, the live site webroot `/var/www/shear.digital`. The live webroot is the source of the site, and `index.html` is `chattr +i`.
4. **Back up only what step 3 says to keep**, off the host. Never a testnet
   datadir, `tip.json`, wallet, test key or lane output.
5. **IP independence:**
   - Check that no client, wallet, miner config, seed list or doc names a host IP; everything uses DNS names.
   - Check whether Hetzner's Rebuild keeps the IP. If it doesn't, keep a Primary IP.
   - If an IP must change: lower the DNS TTL 48 hours ahead, then update the DNS records.

## Rebuild (each step needs the host's GO)

6. **Reinstall** the host from a fresh image of its OS (table above).
7. **Firewall:**
   - pool: run `firewall/ufw-pool.sh`, read the plan, then run it with `--apply`.
   - p2p-a: `nft -c -f firewall/nftables-p2p-a.conf`, then install it as `/etc/nftables.conf` and `systemctl enable --now nftables`.
   - p2p-b: run `firewall/firewalld-p2p-b.sh`, read the plan, then run it with `--apply`.

   Port 22 is opened first in each, so an apply over SSH cannot lock the session out.
8. **Install:**
   - Node.js from the OS packages, at the version the release pins.
   - A `shear` system user.
   - The release tree at `/opt/shear`, from a tagged commit only.
   - Copy the role's units from `units/` to `/etc/systemd/system/`, then run `systemctl daemon-reload`.
   - Starting the units is its own GO.
9. **Update routine:** write it down per host.
   - Unattended upgrades are limited to security updates: `unattended-upgrades` on Ubuntu and Debian, `dnf-automatic` with `upgrade_type = security` on Fedora.
   - Kernel reboots are done by hand and logged.
10. **Verify, don't paint:**
    - Run `scripts/check_host.sh <role>`; it must print PASS.
    - Run `scripts/inventory.sh > inventory-<role>-after.txt`.
    - Record both in the launch log.

## Teardown checklist (R18b, 18–21 Dec, and any host leaving testing)

`scripts/teardown.sh` covers items 1–6. Run it as a dry run first, read the
list, then apply it on the host's GO.

1. Every `shear*` and `sheark*` service, timer and unit file from testing, including `*.wants` links.
2. `/root/claude-ci`: build trees, lane scripts, bundles, tars, logs.
3. Every datadir under `/var/lib/shear`: testnet, stressnet, shear-dev and any mainnet-magic test run. Nothing is kept or copied.
4. Old release trees: `/opt/shear-v4` and `/opt/shear-v*`.
5. Cron jobs that name shear, the lanes or `claude-ci`. Lines in user crontabs are listed for removal by hand and logged; files in `/etc/cron.d` are removed.
6. Test wallets, keys and logs: `*.shewall` in home directories, `/tmp/shear*` and `/var/log/shear*`.
7. **By hand:**
   - VM or container images from testing.
   - Test-only nginx sites.
   - Test DNS records.
   - Any test SSH key in `authorized_keys`. Keep Russell's.
8. **Verify:** `check_host.sh <role>` prints PASS and the inventory shows nothing from testing. Record it in the launch log with the release SHA.

Kept on purpose: SSH access, TLS certificates, DNS, and the live site webroot
(backed up in step 4).

## Open points for Russell

- **Port 8080.** It is on the allowed list, but nothing in the repo listens on it today, so `check_host.sh` will not see a listener there. Say what it serves, or close it.
- **The bootstrap publisher.** The old `deploy/shear-bootstrap-publish.service` publishes a datadir snapshot. That sits close to "no datadir or tip.json copies", so no mainnet unit for it is included. Rule on it before R18b.
- **The old units in `deploy/`.** `shear-node`, `shear-p2p`, `shear-pool`, `shear-pool-v4`, `shear-ibd-v4-mine`, `sheark-v4-afk` and `shear-bootstrap-publish` still name testnet-v4 or v10 and use `Restart=always` or `on-failure`. They are left untouched here, because no deployed host may depend on a file changing under it. Their removal from the repo is its own small PR once the mainnet units are live.
