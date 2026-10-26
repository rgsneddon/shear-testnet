# Shear roadmap

The one shared roadmap for every agent working on this repo (Claude, Grok,
GPT or any other), and the source of truth for the plan.

Last updated: 2026-10-26 by Claude.

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
10. **Review section (standing rule, Russell 2026-10-25).** Every PR keeps
    a Review section in its body, updated as work happens and complete
    before any merge ask. It records:
    1. Bugs found: what it was, the root cause, the commit or version it
       came from, severity, the fix commit SHA, and the test that proves
       it. Pre-existing bugs are labelled as such.
    2. Verdict changes: any block or tx that is now refused, accepted, or
       refused for a different reason, before and after.
    3. Consensus and pin moves: all pins before and after, and the sign-off
       reference.
    4. Rulings applied: which of Russell's rulings, with its date, and how
       it was applied.
    5. Test fixes: harness bugs, stale tests rewritten and why, and any test
       that couldn't be built honestly (say so; don't fake it).
    6. Void runs: any lane result that doesn't count, and why.
    7. Process slips, and the guard added so they don't happen again.
    8. Lane verdicts: which lanes reviewed it, each verdict, and the SHA
       reviewed.
    9. Final head SHA, with the full re-run results on that exact head.

    Nothing is left as a known issue unless Russell has made a deliberate
    ruling to keep it, recorded with its date.
11. **Vortice scope (Russell 2026-10-26).** Only the Vault/Reserve vortice
    is in scope for now. The other vortices are paused remnants, kept for
    dedicated sessions, probably after mainnet. Skip them in every test
    lane, CI dispatch and fix, and do not touch their code, even if a
    reviewer flags it.
    - A skip is explicit and named, never a silent pass. In the PR shards
      it is a `SCOPE` row in `tests/ci_pending.txt` that cites this ruling.
    - A test that keeps other vortices off the chain or away from the
      Reserve guards the Vault/Reserve, so it stays in. Examples are
      `test_vort1_register.js` and `crypto/vortex.test.js`.

## Rows

Target dates are from the work plan, starting 25 Oct 2026: expected finish,
with the best-to-worst range in brackets. Every day spent waiting for a GO
moves the later rows by a day.

| ID | Item | Consensus? | Status | Owner | Reviewer | Working now | PR | Head SHA | Target |
|----|------|------------|--------|-------|----------|-------------|----|----------|--------|
| R01 | PR 130: digestTx and bundled fixes | Y: `TX_DIGEST=body-v2`, `COINBASE_V=opens`, `COINBASE_NC=dest-bound`, the memo binding (`FS1_MEMO=bound`) and the new mainnet genesis move the testnet, mainnet and mainnetFP pins | active | Claude | Grok + Protocol, Vault Security, Pool Share, Codebase, Privacy, pins | Claude, cursor/v12-followups-3daf, since 2026-10-23 | [#130](https://github.com/rgsneddon/shear-testnet/pull/130) | 83ea4352 (pushed; rebuilt chain local, awaiting the fresh consensus sign-off) | 28 Oct (28–29 Oct) |
| R01a | Coinbase spend-key binding: a coinbase payout's admitPub bound to its payee | Y: a coinbase row's spend key must derive from the payee's admit base; the design says how that base is on chain or derivable after pruning | planned (design to Russell first) | Claude | Grok + Protocol, Privacy, pins | | | | after R01, before R02 (date set on the design GO) |
| R02 | Vault F1 lock-note binding | Y: binds the owner key point into the signed lock digest; new vectors | planned | Claude | Grok + Vault Security, Protocol, Wallet Hardening, pins | | | | 30 Oct (29–31 Oct) |
| R03 | CLI reserve lock | N: Dart CLI wiring only | planned | Claude | Grok + Wallet Hardening, pins | | | | 31 Oct (30 Oct–1 Nov) |
| R04 | Hash-safety | N: native ShearHash thread and key safety; digests stay byte-identical | planned | Claude | Grok + Codebase, pins | | | | 2 Nov (31 Oct–3 Nov) |
| R05 | PR 2: book magic everywhere | Y: changes behaviour on the mainnet, regtest and shear-dev books (testnet byte-identical; pins must not move) | planned | Claude | Grok + Protocol, Vault Security, pins | | | | 4 Nov (3–6 Nov) |
| R06 | Goals 6–9 (register signing, strict wire decode, 018e share commitment, T21 hidden payout) | Y: each changes what a block may hold | planned | Claude | Grok + Protocol, Pool Share, Privacy, pins | | | | 9 Nov (7–11 Nov) |
| R07 | Goal 10 F: FCMP++ hardening | Y: spend proof checks | planned | Claude | Grok + Privacy, Protocol, pins | | | | 10 Nov (8–12 Nov) |
| R08 | PR 3a: real-data fixtures, consensus paths | N: tests only | planned | Claude | Grok + Codebase | | | | 13 Nov (10–15 Nov) |
| R11 | PR 3b: remaining real-data fixtures and CI guard | N: tests and CI only | planned | Claude | Grok + Codebase | | | | 21 Nov (17–26 Nov) |
| R12 | Goal 10 A–D: four PR updates (A #117, B #111, C #93, D #107). B stays before mainnet for the Vault claim mint-once test cover. D is trimmed to what PR 116's hidden-claim API does not already cover, and D1 (a matured lock is never Spendable) and D2 (the Withdraw button stays visible) must land. E (#98) is folded into R16 (Russell 26 Oct) | Y: A (epoch-end gas) and C (withdraw policy) change consensus | planned | Claude | Grok + Protocol, Vault Security, pins | | | | 25 Nov (20–30 Nov) |
| R13 | Wallet copy | N: wallet text and errors only | planned | Claude | Grok + Wallet Hardening | | | | 27 Nov (22 Nov–2 Dec) |
| R14 | PR 128 M3: shear-dev pin move | Y: moves the shear-dev pin only; every other pin must equal main | planned | Claude | Grok + Protocol, pins | | | | 27 Nov (22 Nov–3 Dec) |
| R14a | Public supply audit tool: a CLI that reads one's own node and checks, genesis to tip, that emission plus mints minus burns equals the commitment sum with every range proof valid; prints the public supply figure and pass, or fail at the exact height. No phone-home, no pool reliance | N, unless the design needs a consensus change (then Y, with the reason) | planned (lane idle until Thu 29 Oct; spec first, no code before Russell approves it) | TBD (Thu 29 Oct 15:00 alignment) | Public Supply Audit lane (Claude side) and Supply Auditor (Grok side) | | | | before R15, so it runs on shear-dev and stressnet before genesis |
| R15 | shear-dev deploy GO and live bug hunt | N: operational; fixes found there are their own PRs | planned | Claude | Grok | | | | 2 Dec (25 Nov–10 Dec) |
| R18a | Host rebuild on the mainnet OS split (pool Ubuntu LTS, p2p-a Debian stable, p2p-b Fedora Server), so stressnet runs on the mainnet OSes | N: hosts only | planned | Claude | Grok | | | | after R15, before R16 (estimate 1–2 days; the later rows move by that) |
| R16 | v12 cut (onto the rebuilt hosts), run from the R16 cut checklist below (folded in from #98, Russell 26 Oct) | N: operational; pins checked at the cut | planned | Claude | Grok + pins | | | | 3 Dec (26 Nov–11 Dec) |
| R17 | Stressnet (7-day floor) | N: live testnet | planned | Claude | Grok | | | | 10 Dec (3–18 Dec) |
| R18b | Final wipe of testing leftovers and mainnet release deploy | N: hosts only | planned | Claude | Grok + pins | | | | 18–21 Dec |
| R19 | Mainnet genesis | N: date fixed by R01 | planned | Claude | Grok + pins | | | | Mon 21 Dec 2026 14:00 UK (fixed) |
| R09 | Token spec (mint.shear.digital), spec only: the first half of the R09–R10 vortice session under rule 11 | N: a spec, no code | planned (post-mainnet) | Claude | Grok + all lanes | | | | after R19; no date until Russell sets one |
| R10 | Private tokens build (a vort1 vortice): the second half of the R09–R10 vortice session under rule 11, after the R09 spec is signed off | Y: new tx kind and consensus rules | planned (post-mainnet) | Claude | Grok + all lanes, pins | | | | after R19; no date until Russell sets one |

R01a and R14a were added by Russell on 26 Oct. R01a is the coinbase
spend-key binding found by the PR 130 lanes: its own PR straight after R01,
design first. R14a is the public supply audit tool with its own review lane
(Public Supply Audit on the Claude side, Supply Auditor on the Grok side), idle until Thu 29
Oct after the credit reset; its owner is set at that day's 15:00 alignment.

R03 (CLI reserve lock) stays where it is (Russell, 25 Oct). R09 (token
spec) and R10 (private tokens build, a vort1 vortice) moved to after mainnet
genesis as one dedicated vortice session under rule 11, with no date until
Russell sets one. The other rows did not move (Russell, 26 Oct). This file is the source of truth; the xlsx is not kept in
step.

## R16 cut checklist (folded in from #98, Russell 26 Oct)

Facts from `feat/shear-testnet-v12` at dc1422ed. Re-read each one from the
tree at the cut; none of these steps has run. Every step needs Russell's GO.

1. **Genesis pin.** `node/src/chain.js` still has
   `V12_GENESIS_BLOCK_HASH = ''` and
   `V12_BOOTSTRAP_CHECKPOINT = { height: 0, hash: '' }`. A pin is 64
   lowercase hex characters; a non-hex pin fails closed, and height 0 means
   the checkpoint is unset.
   1. Run `node scripts/v12-genesis-cut.mjs --root <empty dir>`. It refuses
      a root inside the checkout, a live node datadir, `~/.shear` or
      `%APPDATA%\Shear`.
   2. Read `block1.hash` and `block1.height` from its `V12_GENESIS_CUT`
      JSON line.
   3. Set `V12_GENESIS_BLOCK_HASH` to that hash, and the checkpoint to the
      cut checkpoint's height and hash (block 1 if the cut book is only
      height 1). Never invent a hash.
   4. This is a pin move: stop for Russell's sign-off on the diff and the
      pins (rule 8).
2. **Tags.** The display pins in the tree are Continuum `0.72`
   (`wallet/pubspec.yaml` 0.72.0+97), Shear Sentinel `v19`
   (`PRODUCT_VERSION` 19.0 in `crypto/asert.js`) and ShearK `2.9`. None of
   those tags exists yet; the newest Continuum tag is `0.71`. Tag
   `<cut-tip>`, the commit Russell names after the pin is filled:
   `0.72`, `v19`, `ShearK-2.9`. Never move an existing tag.
3. **Version alignment.** `wallet/pack/archlinux/PKGBUILD` says
   `pkgver=0.71` while `wallet/pubspec.yaml` says 0.72. The wallet pack
   dispatches take their pin from the PKGBUILD (PR 130, d8 and d9), so the
   two must agree before the release builds.
4. **Launch list** (from the work queue): seeds listening on 30303; every
   service unit sets `SHEAR_NETWORK` or holds `book.magic`, with no stale v4
   units; release artefacts at the x86-64 baseline (`isa_scan` clean);
   shear-dev parameters must not leak into v12; the v12 and mainnet pins
   are checked again at the cut.

## R18a and R18b detail: mainnet hosts and OS split

Each wipe or reinstall needs Russell's GO, one host at a time.

| Host | IP | OS |
|------|----|----|
| pool | 77.42.91.84 | Ubuntu Server LTS (current release) |
| p2p-a | 157.180.70.110 | Debian stable |
| p2p-b | 2.28.8.89 | Fedora Server (current release) |

Why: OS diversity. One distro's bad update, kernel bug or package compromise
cannot take down all three hosts. A clean start means users mine, download
clients and connect to nodes with no testing leftovers.

When: R18a rebuilds the hosts on their mainnet OSes after shear-dev and
before the v12 cut, so the v12 testnet and stressnet run on the OSes mainnet
will use. R18b, 18–21 Dec, removes everything testing left behind and
deploys the mainnet release.

### R18a: rebuild before stressnet

Before the rebuild:

1. CI gains Debian stable and Fedora build-and-run jobs alongside Ubuntu,
   covering the node, the pool where relevant, and the release binaries.
2. A short live shear-dev session on each target OS (Debian and Fedora nodes
   peering with the Ubuntu pool), with the results recorded.
3. An inventory of each host: services, timers, cron jobs, users, ports,
   disk. Record what must be kept (SSH access, TLS certs, DNS, firewall
   rules).
4. Back up only what is needed. No testnet datadir or `tip.json` copies.
5. IP independence: no client, wallet, miner config, seed list or doc
   hardcodes a host IP; everything points to DNS names. Check whether
   Hetzner's Rebuild keeps each IP (if not, keep a Primary IP). If an IP does
   change, lower the DNS TTL 48 hours ahead, then update the DNS records and
   the firewall allowlists.

Rebuild:

6. Reinstall each host from a fresh image of its OS.
7. Firewall on each OS (ufw on Ubuntu, nftables on Debian, firewalld on
   Fedora): ports 22, 80, 443, 1111, 8080 and 30303 only.
8. Write down each host's update routine. Unattended upgrades are limited to
   security updates; kernel reboots are done by hand and logged.
9. Verify, don't paint: a post-rebuild check on each host lists its services,
   ports and files. Record it in the launch log.

### R18b: final wipe and mainnet deploy, 18–21 Dec

1. Remove everything testing left behind: `/root/claude-ci`, lane scripts
   and tars, testnet and stressnet datadirs, test services, timers, cron
   jobs, wallets, keys, logs, and VM or container images.
2. Deploy only the mainnet release build from a tagged commit. No silent
   automatic systemctl recoveries.
3. Verify, don't paint: a check on each host lists its services, ports and
   files, and shows nothing from testing. Record it in the launch log with
   the release SHA.
