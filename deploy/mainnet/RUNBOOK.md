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
| pool | 77.42.91.84 | Ubuntu Server LTS (current) | `shear-p2p` (owns :30303), `shear-pool` (stratum :1111, HTTP :8088 on loopback), nginx (80/443); before genesis their `shear-v12-*` twins | ufw: `firewall/ufw-pool.sh` |
| p2p-a | 157.180.70.110 | Debian stable | `shear-node` (:30303); before genesis `shear-v12-node` | nftables: `firewall/nftables-p2p-a.conf` |
| p2p-b | 2.28.8.89 | Fedora Server (current) | `shear-node` (:30303); before genesis `shear-v12-node` | firewalld: `firewall/firewalld-p2p-b.sh` |

`agent-box` (the explorer node) is not one of these hosts: nothing here runs
on it, and `teardown.sh` refuses it by name.

Each host's firewall uses its own OS's tool, IPv4 and IPv6, with ICMP and
ICMPv6 allowed, and opens only what its role serves:

- pool: inbound TCP 22, 80, 443, 1111 and 30303;
- p2p-a and p2p-b: inbound TCP 22 and 30303 (no site, no stratum).

SSH (22) is rate limited on all three: `ufw limit` on the pool, an nft meter
on p2p-a (over 10 new connections a minute per address are dropped), and
rate-limited firewalld rich rules on p2p-b. `check_host.sh` checks the limit
is there and that `sshd -T` says `passwordauthentication no`. The Hetzner
firewall is not managed from here, so the host firewall is the one that
counts.

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
| `scripts/teardown.sh` | Removes everything testing left behind; never touches mainnet state | Dry run by default. Needs `SHEAR_ROLE=<pool\|p2p-a\|p2p-b>`; `--apply` also needs `SHEAR_TEARDOWN_GO=<hostname>` and, where `pool-spend.seed` exists, `SHEAR_SEED_BACKUP_SHA256` |
| `scripts/check_host.sh <role> --phase pre-genesis\|live` | Verify, don't paint. Fails on a wrong OS, a firewall that is not on, SSH without a rate limit or with password logins, a public TCP or UDP listener outside the role's ports, test leftovers, a unit that restarts itself (drop-ins included), copies or fetches files, or names an IP, or a unit whose effective environment is on the wrong book or sets a test switch. Then the phase: before genesis, mainnet installed but off with no emit gate set and the v12 net up; live, mainnet up on the release tree's book and tag with its tip rising | No, read-only |
| `firewall/*` | The three firewalls | The two scripts are dry runs without `--apply`. The nft file is checked with `nft -c` first |
| `units/shear-{node,p2p,pool}.service` | Mainnet units | Only when installed |
| `units/shear-v12-{node,p2p,pool}.service` | v12 public testnet units, the same rules on the v12 book | Only when installed |

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
  directory under `/var/lib/shear/`, owned by the `shear` user, mode 0700
  (`StateDirectoryMode=0700`, `UMask=0077`), and those are its only
  writable paths (`ProtectSystem=strict`, `ProtectHome=yes`).
  `SHEAR_SEAL_KEY_DIR` keeps the seal keys out of `~/.shear`.
- **Hardening.** No capabilities, private /tmp and /dev, the kernel, clock,
  hostname, cgroups and other processes protected, IPv4, IPv6 and Unix
  sockets only, no namespaces, realtime or SUID, native syscalls in the
  `@system-service` set. No `MemoryDenyWriteExecute`: node's JIT needs it
  off.
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
   - **Offline backup of `pool-spend.seed`** (pool host, once Russell has placed it), before any teardown or rebuild touches that host: Russell copies `/var/lib/shear/mainnet-pool/pool-spend.seed` to offline media he holds, then checks the copy with `sha256sum` against `sha256sum` of the file on the host. The matching sha256 is recorded in the launch log (the hash only, never the seed) and given to `teardown.sh` as `SHEAR_SEED_BACKUP_SHA256`; without it, or if it does not match, `teardown.sh --apply` refuses on that host. Teardown never deletes the seed, but nothing that could go wrong on the host should be the only copy.
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
   - A `shear` system user and group, and `/etc/shear/role` holding the host's role (`pool`, `p2p-a` or `p2p-b`), which `teardown.sh` checks against `SHEAR_ROLE`.
   - Two release trees, each from a tagged commit only: the v12 testnet tree at `/opt/shear-v12`, and the mainnet tree at `/opt/shear`.
   - Copy the role's units from `units/` to `/etc/systemd/system/`, then run `systemctl daemon-reload`. Each role has a v12 testnet set and a mainnet set:

     | Role | v12 testnet (before genesis) | mainnet (from genesis) |
     |------|------------------------------|------------------------|
     | pool | `shear-v12-p2p`, `shear-v12-pool` | `shear-p2p`, `shear-pool` |
     | p2p-a, p2p-b | `shear-v12-node` | `shear-node` |

     The two sets have the same hardening and rules and share the role's ports (:30303, the RPC port, and on the pool :1111 and loopback :8088 and :30313), so only one set runs at a time. The v12 set runs `SHEAR_NETWORK=shear-testnet-v12` from `/opt/shear-v12` with its own state (`/var/lib/shear/testnet-v12*`, `/var/lib/shear/seal-keys-v12`); the mainnet set runs `SHEAR_NETWORK=shear-v1` from `/opt/shear` with `/var/lib/shear/mainnet*` and `/var/lib/shear/seal-keys`.
   - On the pool host also: `/etc/shear/pool.env` (and `/etc/shear/pool-v12.env` for the v12 pool), the stratum TLS pair and its certbot deploy hook, and Russell's `pool-spend.seed`, all as described above.
   - Starting units is its own GO. Before genesis only the v12 set is enabled and started: `systemctl enable --now shear-v12-node.service` (p2p-a, p2p-b), or `systemctl enable --now shear-v12-p2p.service`, then `systemctl enable --now shear-v12-pool.service` (pool). The mainnet units are installed but stay disabled and stopped; nothing sets `SHEAR_MAINNET_EMIT` before the genesis GO. `check_host.sh <role> --phase pre-genesis` checks this.
   - **At genesis** (its own GO, one host at a time): stop and disable the v12 set, then enable and start the mainnet set (on the pool host `shear-p2p` first, then `shear-pool`), then run `check_host.sh <role> --phase live`.
9. **Update routine:** write it down per host.
   - Unattended upgrades are limited to security updates: `unattended-upgrades` on Ubuntu and Debian, `dnf-automatic` with `upgrade_type = security` on Fedora.
   - Kernel reboots are done by hand and logged.
10. **Verify, don't paint:**
    - Before genesis run `scripts/check_host.sh <role> --phase pre-genesis`; after the genesis GO run `scripts/check_host.sh <role> --phase live` with `SHEAR_RELEASE_TAG=<tag>` (and `SHEAR_GENESIS_HASH` from the first host checked, so all three agree). It must print PASS.
    - Run `scripts/inventory.sh > inventory-<role>-after.txt`.
    - Record both in the launch log.

## Teardown checklist (R18b, 18–21 Dec, and any host leaving testing)

`scripts/teardown.sh` covers items 1–6. Run it as a dry run first with
`SHEAR_ROLE=<pool|p2p-a|p2p-b>`, read the list, then apply it on the host's
GO. It runs only on those three roles and refuses `agent-box` by name.

It never touches mainnet state: `/var/lib/shear/{mainnet,mainnet-p2p,mainnet-pool,seal-keys}`
(and `pool-spend.seed` in it), every unit that runs `SHEAR_NETWORK=shear-v1`
and its `*.wants` link, and `/opt/shear` while any of those is present. Each
is listed as `keep (mainnet)`. The same script is the later v12 teardown:
the `shear-v12-*` units, `/var/lib/shear/testnet-v12*`,
`/var/lib/shear/seal-keys-v12` and `/opt/shear-v12` go, mainnet stays. On a
host that holds `pool-spend.seed`, `--apply` also needs step 4's
`SHEAR_SEED_BACKUP_SHA256`.

1. Every `shear*` and `sheark*` service, timer and unit file from testing, including `*.wants` links. Mainnet units (`SHEAR_NETWORK=shear-v1`) are kept.
2. `/root/claude-ci`: build trees, lane scripts, bundles, tars, logs.
3. Every testing datadir under `/var/lib/shear` (testnet including v12, stressnet, shear-dev, and any mainnet-magic test run outside the mainnet datadirs), plus the default `~/.shear` of anything run without `SHEAR_DATA` (`/root/.shear`, `/home/*/.shear`; it also holds book seal keys). No testing datadir is copied. The mainnet datadirs, the mainnet seal keys and `pool-spend.seed` are kept.
4. Release trees from testing: `/opt/shear-v*` (`/opt/shear-v12` included), and `/opt/shear` only on a host with no mainnet state yet (there it is an old testnet tree). Where mainnet is installed, `/opt/shear` is the mainnet release and is kept.
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
8. **Verify:** `check_host.sh <role> --phase <pre-genesis|live>` prints PASS and the inventory shows nothing from testing. Record it in the launch log with the release SHA.

Kept on purpose: SSH access, TLS certificates and their renewal hooks, DNS,
the live site webroot (backed up in step 4), and all mainnet state.

## Settled (Russell 26 Oct)

- **Port 8080:** closed. Nothing listens on it (see above).
- **Stratum on 1111:** TLS only (`stratum+ssl`), Russell 26 Oct, 20:30 GMT. No cleartext listener, and the testing-only `SHEAR_STRATUM_LAB_CLEARTEXT` flag never runs in production. The pool unit sets `SHEAR_STRATUM_REQUIRE_TLS=1`.
- **Bootstrap publisher:** left out. Nodes sync and verify from genesis themselves (roadmap rule 12).
- **The old units in `deploy/`** (`shear-node`, `shear-p2p`, `shear-pool`, `shear-pool-v4`, `shear-ibd-v4-mine`, `sheark-v4-afk`, `shear-bootstrap-publish`, and `nginx-boot.shear.digital.conf`): removed in their own small PR once the mainnet units are live. They still name testnet-v4 or v10 and use `Restart=always` or `on-failure`.
