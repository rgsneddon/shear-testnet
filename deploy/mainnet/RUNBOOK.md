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
80, 443, 1111 and 30303 only, IPv4 and IPv6, with ICMP and ICMPv6 allowed.
The Hetzner firewall is not managed from here, so the host firewall is the
one that counts.

**Port 8080 is closed** (Russell 26 Oct). A read-only check that
evening (`ss -ltnp` on all three hosts) found nothing listening on TCP 8080.
It was thought to be the old Beam pool or a VPN tunnel. Either way, nothing
uses it now, and nothing in the repo listens on it, so the mainnet
firewalls leave it closed.

Order: p2p-b first, then p2p-a, then the pool. p2p-b is the most different
OS and the least central, so it is the safest to learn on, and the pool,
which serves the site and the client downloads, goes last.

## Files

| File | What it does | Changes a host? |
|------|--------------|-----------------|
| `scripts/inventory.sh` | Lists OS, disk, users, services, timers, cron, listeners, firewall, test paths, shear units | No, read-only |
| `scripts/teardown.sh` | Removes everything testing left behind | Dry run by default. `--apply` also needs `SHEAR_TEARDOWN_GO=<hostname>` |
| `scripts/check_host.sh <role>` | Verify, don't paint. Fails on a wrong OS, a firewall that is not on, an extra public TCP or UDP listener, test leftovers, or a unit that restarts itself (drop-ins included), copies or fetches files, or names an IP | No, read-only |
| `firewall/*` | The three firewalls | The two scripts are dry runs without `--apply`. The nft file is checked with `nft -c` first |
| `units/*.service` | Mainnet units | Only when installed |

## The unit rules

- **No silent recovery.** Every unit has `Restart=no` and no `OnFailure=`. A
  stopped node or pool stays stopped until an operator looks. `check_host.sh`
  and `systemctl status` show it. A quiet restart that hides a fault is what
  the standing rule forbids.
- **No phone-home.** A unit reaches nothing but its seeds, by DNS name
  (`p2p.shear.digital`, `r2r.shear.digital`). No telemetry, no update check.
- **No datadir or tip.json copies, and no bootstrap.** No step before or
  after the node seeds its datadir. Every node syncs from genesis and
  verifies every block itself. The old bootstrap publisher is left out of
  mainnet (Russell 26 Oct, roadmap rule 12): nodes own the tip, and a pinned
  snapshot comes later as R21.
- **The pool is never consensus.** `shear-pool` takes verified blocks from
  its own `shear-p2p` node on loopback; that node owns the tip. The pool
  unit is `Requisite=` and `PartOf=` the node:
  - it refuses to start unless the node is already running, and starting
    the pool never starts the node (each start is its own GO);
  - if the node stops, the pool stops with it, so it never serves work
    without its own verified tip.
- **State.** `StateDirectory=` creates each unit's datadir and book seal key
  directory under `/var/lib/shear/`, owned by the `shear` user, and those
  are its only writable paths (`ProtectSystem=strict`, `ProtectHome=yes`).
  `SHEAR_SEAL_KEY_DIR` keeps the seal keys out of `~/.shear`.
- **No memory caps yet.** The testnet `MemoryMax` values have no measured
  basis for mainnet, so they are left out. They will be set from the memory
  stressnet (R17) measures.

## Pool settings that are not in the repo

The pool refuses to start without these. They are host settings, not code,
and no secret ever goes in the repo:

- **`/etc/shear/pool.env`**, `root:shear`, mode `0640`, which
  `check_host.sh` checks. It holds `SHEAR_STRATUM_AUTH_PUB`, without which
  no miner can log in, and `SHEAR_FEE_DEST` / `SHEAR_ADMIN_SPEND_DEST` only
  if they differ from the shipped pin.
- **The spend seed** is the file `pool-spend.seed` in
  `/var/lib/shear/mainnet-pool`, owned by `shear`, mode `0600`, placed by
  Russell. It never goes in `pool.env`, a unit, the repo or a log.
- **The stratum TLS pair** `/etc/shear/stratum-tls/{fullchain,privkey}.pem`,
  readable by the `shear` group. A certbot deploy hook copies it from
  `/etc/letsencrypt/live/<name>/` on each renewal. Let's Encrypt keys are
  root-only, so the pool cannot read them in place. A public stratum bind
  without TLS is refused by the pool (`pool/src/posture.js`), and the unit
  sets `SHEAR_STRATUM_REQUIRE_TLS=1`, so it never falls back to cleartext.

## Before the rebuild (one host at a time)

1. **Prerequisites (R18a in the roadmap):**
   - CI has Debian stable and Fedora build-and-run jobs.
   - A short live shear-dev session has run on each target OS, with the results recorded.
2. **GO** from Russell for this host's inventory.
3. **Inventory:** run `scripts/inventory.sh > inventory-<role>-before.txt`.
   Save it in the launch log. Note what must be kept:
   - SSH keys;
   - TLS certificates and their renewal hooks (`/etc/letsencrypt`);
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
   - pool: check `/etc/default/ufw` says `IPV6=yes`, run `firewall/ufw-pool.sh`, read the plan, then run it with `--apply`. It resets ufw first, so no rule from the image survives.
   - p2p-a: `nft -c -f firewall/nftables-p2p-a.conf`, then install it as `/etc/nftables.conf` and `systemctl enable --now nftables`.
   - p2p-b: run `firewall/firewalld-p2p-b.sh`, read the plan, then run it with `--apply`. It moves every interface into the default zone and removes every other service, port, source port, protocol and rich rule.

   Port 22 is opened first in each, so an apply over SSH cannot lock the session out.
8. **Install:**
   - Node.js from the OS packages, at the version the release pins.
   - A `shear` system user and group.
   - The release tree at `/opt/shear`, from a tagged commit only.
   - Copy the role's units from `units/` to `/etc/systemd/system/`, then run `systemctl daemon-reload`.
   - On the pool host also: `/etc/shear/pool.env`, the stratum TLS pair and its certbot deploy hook, and Russell's `pool-spend.seed`, all as described above.
   - Starting the units is its own GO. On the pool host, start `shear-p2p` first, then `shear-pool`.
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
3. Every datadir: all of `/var/lib/shear` (testnet, stressnet, shear-dev and any mainnet-magic test run), plus the default `~/.shear` of anything run without `SHEAR_DATA` (`/root/.shear`, `/home/*/.shear`; it also holds book seal keys). Nothing is kept or copied.
4. Release trees from testing: `/opt/shear` (the v12 testnet tree) and `/opt/shear-v*`. The mainnet release is installed fresh from its tag.
5. Cron:
   - A file in `/etc/cron.d` that names `claude-ci` or a lane is removed.
   - A file there that only names shear is listed for a hand check, not removed, because certbot and other renewal hooks for shear.digital must stay.
   - Lines in user crontabs are listed for removal by hand and logged.
6. Test wallets, keys and logs: `*.shewall` in home directories, `/tmp/shear*` and `/var/log/shear*`.
7. **By hand:**
   - VM or container images from testing.
   - Test-only nginx sites, including `boot.shear.digital` (the retired bootstrap).
   - Test DNS records.
   - Any test SSH key in `authorized_keys`. Keep Russell's.
8. **Verify:** `check_host.sh <role>` prints PASS and the inventory shows nothing from testing. Record it in the launch log with the release SHA.

Kept on purpose: SSH access, TLS certificates and their renewal hooks, DNS,
and the live site webroot (backed up in step 4).

## Settled (Russell 26 Oct)

- **Port 8080:** closed. Nothing listens on it (see above).
- **Bootstrap publisher:** left out. Nodes sync and verify from genesis themselves (roadmap rule 12).
- **The old units in `deploy/`** (`shear-node`, `shear-p2p`, `shear-pool`, `shear-pool-v4`, `shear-ibd-v4-mine`, `sheark-v4-afk`, `shear-bootstrap-publish`, and `nginx-boot.shear.digital.conf`): removed in their own small PR once the mainnet units are live. They still name testnet-v4 or v10 and use `Restart=always` or `on-failure`.

## Open point for Russell

- **Stratum on 1111: TLS or cleartext?** A public stratum bind without TLS is refused by the pool unless the lab flag `SHEAR_STRATUM_LAB_CLEARTEXT=1` is set, and that flag is meant for testing. The unit asks for TLS (`SHEAR_STRATUM_REQUIRE_TLS=1`, with the cert pair above), so miners connect with `stratum+ssl`. If mainnet should also take cleartext stratum, that is a ruling, because it means running a lab flag in production or adding a second listener.
