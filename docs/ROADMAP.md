# Shear roadmap

The one shared roadmap for every agent working on this repo (Claude, Grok,
GPT or any other). Russell's spreadsheet, `Shear-v12-work-plan.xlsx`, is his
view of the same plan and is kept in step with this file.

Last updated: 2026-10-25 by Claude.

## Who is working now

| Agent  | State                     | Items it may work on |
|--------|---------------------------|----------------------|
| Claude | active                    | rows it owns, one at a time |
| Grok   | inactive (credits reset Thu 16:27 BST / 15:27 GMT) | none |
| other  | inactive                  | none |

Until Russell gives a GO on the Claude/Grok split, Claude owns every row.

## Rules for agents

1. **Work only on a row you own.** Owner is exactly one agent. If your name
   is not in a row's Owner cell, do not touch its files or branch.
2. **Start only on a GO.** A row moves from `planned` to `active` only on
   Russell's GO. No agent starts a row on its own, even an idle one.
3. **Claim before you start.** When a row is activated, the owner fills in
   its "Working now" cell (`agent, branch, since <UTC time>`) in a small PR
   that edits only that row. An open PR that edits a row's "Working now"
   cell is a claim. Before starting anything, read this file on `main` and
   every open PR that touches `docs/ROADMAP.md`. Never open a second claim
   on a row that is already claimed.
4. **Never both on the same files or branch at once.** Two rows that would
   touch the same files are not active at the same time with different
   owners.
5. **Status values**, in order: `planned`, `active`, `in review`,
   `awaiting GO`, `merged`, `done`. An owner may change its own row's status,
   "Working now", PR, head SHA and dates-reached. A finished row clears its
   "Working now" cell.
6. **Order, dates and scope need Russell's GO.** That covers adding,
   removing or reordering rows, changing target dates, and changing a row's
   scope. Status updates do not.
7. **Review.** The reviewer is the other side (Grok reviews Claude's rows and
   Claude reviews Grok's), plus the review lanes the change touches. The
   reviewer signs off before any merge ask.
8. **Consensus.** A row marked `Y` moves consensus or pins. Every `Y` row
   must land before shear-dev starts, or it forces a reset. A `Y` row stops
   for Russell's sign-off on the exact diff and the pins before it is
   committed.
9. **Landing.** Every commit is signed off (`git commit -s`). Everything
   lands through a PR. No direct push to `main`. A merge needs Russell's GO,
   one merge at a time, as a normal merge commit.

## Rows

Target dates are from the work plan, starting 25 Oct 2026: expected finish,
with the best-to-worst range in brackets. Every day spent waiting for a GO
moves the later rows by a day.

| ID | Item | Consensus? | Status | Owner | Reviewer | Working now | PR | Head SHA | Target |
|----|------|------------|--------|-------|----------|-------------|----|----------|--------|
| R01 | PR 130: digestTx and bundled fixes | Y: `TX_DIGEST=body-v2` and the new mainnet genesis move the testnet, mainnet and mainnetFP pins | active | Claude | Grok + Protocol, Vault Security, Pool Share, Codebase, Privacy, pins | Claude, cursor/v12-followups-3daf, since 2026-10-23 | [#130](https://github.com/rgsneddon/shear-testnet/pull/130) | 9afd2114 (pushed; local work not yet pushed) | 28 Oct (28–29 Oct) |
| R02 | Vault F1 lock-note binding | Y: binds the owner key point into the signed lock digest; new vectors | planned | Claude | Grok + Vault Security, Protocol, Wallet Hardening, pins | | | | 30 Oct (29–31 Oct) |
| R03 | CLI reserve lock | N: Dart CLI wiring only | planned | Claude | Grok + Wallet Hardening, pins | | | | 31 Oct (30 Oct–1 Nov) |
| R04 | Hash-safety | N: native ShearHash thread and key safety; digests stay byte-identical | planned | Claude | Grok + Codebase, pins | | | | 2 Nov (31 Oct–3 Nov) |
| R05 | PR 2: book magic everywhere | Y: changes behaviour on the mainnet, regtest and shear-dev books (testnet byte-identical; pins must not move) | planned | Claude | Grok + Protocol, Vault Security, pins | | | | 4 Nov (3–6 Nov) |
| R06 | Goals 6–9 (register signing, strict wire decode, 018e share commitment, T21 hidden payout) | Y: each changes what a block may hold | planned | Claude | Grok + Protocol, Pool Share, Privacy, pins | | | | 9 Nov (7–11 Nov) |
| R07 | Goal 10 F: FCMP++ hardening | Y: spend proof checks | planned | Claude | Grok + Privacy, Protocol, pins | | | | 10 Nov (8–12 Nov) |
| R08 | PR 3a: real-data fixtures, consensus paths | N: tests only | planned | Claude | Grok + Codebase | | | | 13 Nov (10–15 Nov) |
| R09 | Token spec (mint.shear.digital), spec only | N: a spec, no code | planned | Claude | Grok + all lanes | | | | 14 Nov (11–17 Nov) |
| R10 | Private tokens build | Y: new tx kind and consensus rules | planned | Claude | Grok + all lanes, pins | | | | 19 Nov (15–23 Nov) |
| R11 | PR 3b: remaining real-data fixtures and CI guard | N: tests and CI only | planned | Claude | Grok + Codebase | | | | 21 Nov (17–26 Nov) |
| R12 | Goal 10 A–E: five PR updates | Y: A (epoch-end gas) and C (withdraw policy) change consensus | planned | Claude | Grok + Protocol, Vault Security, pins | | | | 25 Nov (20–30 Nov) |
| R13 | Wallet copy | N: wallet text and errors only | planned | Claude | Grok + Wallet Hardening | | | | 27 Nov (22 Nov–2 Dec) |
| R14 | PR 128 M3: shear-dev pin move | Y: moves the shear-dev pin only; every other pin must equal main | planned | Claude | Grok + Protocol, pins | | | | 27 Nov (22 Nov–3 Dec) |
| R15 | shear-dev deploy GO and live bug hunt | N: operational; fixes found there are their own PRs | planned | Claude | Grok | | | | 2 Dec (25 Nov–10 Dec) |
| R16 | v12 cut | N: operational; pins checked at the cut | planned | Claude | Grok + pins | | | | 3 Dec (26 Nov–11 Dec) |
| R17 | Stressnet (7-day floor) | N: live testnet | planned | Claude | Grok | | | | 10 Dec (3–18 Dec) |
| R18 | Mainnet host rebuild and OS split | N: hosts only | planned | Claude | Grok | | | | after R17, before R19 |
| R19 | Mainnet genesis | N: date fixed by R01 | planned | Claude | Grok + pins | | | | Mon 21 Dec 2026 14:00 UK (fixed) |

R03 and R10 come from earlier rulings (25 Oct) and keep their ruled places;
Russell to confirm they stay.

## R18 detail: mainnet host rebuild and OS split

This is a record only for now. Each wipe or reinstall needs Russell's GO, one
host at a time.

| Host | IP | OS |
|------|----|----|
| pool | 77.42.91.84 | Ubuntu Server LTS (current release) |
| p2p-a | 157.180.70.110 | Debian stable |
| p2p-b | 2.28.8.89 | Fedora Server (current release) |

Why: OS diversity. One distro's bad update, kernel bug or package compromise
cannot take down all three hosts. A clean start means users mine, download
clients and connect to nodes with no testing leftovers.

When: after testnet and stressnet are over, before mainnet genesis, with
time left for the rebuild and verification. In the worst case the stressnet
floor is met on 18 Dec, leaving three days.

Before the rebuild:

1. CI gains Debian stable and Fedora build-and-run jobs alongside Ubuntu,
   covering the node, the pool where relevant, and the release binaries.
2. A short live shear-dev session on each target OS (Debian and Fedora nodes
   peering with the Ubuntu pool), with the results recorded.
3. An inventory of each host: services, timers, cron jobs, users, ports,
   disk. Record what mainnet must keep (SSH access, TLS certs, DNS, firewall
   rules).
4. Back up only what mainnet needs. No testnet datadir or `tip.json` copies.

Rebuild:

5. Reinstall each host from a fresh image of its OS. Nothing from testing
   survives: no `/root/claude-ci`, lane scripts or tars, test datadirs,
   services, timers, cron jobs, wallets, keys, logs, or VM or container
   images.
6. Firewall on each OS (ufw on Ubuntu, nftables on Debian, firewalld on
   Fedora): ports 22, 80, 443, 1111, 8080 and 30303 only.
7. Deploy only the mainnet release build from a tagged commit. No silent
   automatic systemctl recoveries.
8. Write down each host's update routine. Unattended upgrades are limited to
   security updates; kernel reboots are done by hand and logged.
9. Verify, don't paint: a post-rebuild check on each host lists its services,
   ports and files and shows nothing from testing. Record it in the launch
   log with the release SHA.
10. IP independence: no client, wallet, miner config, seed list or doc
    hardcodes a host IP; everything points to DNS names. Before the rebuild,
    check whether Hetzner's Rebuild keeps each IP (if not, keep a Primary
    IP). If an IP does change, lower the DNS TTL 48 hours ahead, then update
    the DNS records and the firewall allowlists.
