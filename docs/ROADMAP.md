# Shear roadmap

The one shared roadmap for every agent working on this repo (Claude, Grok,
GPT or any other), and the source of truth for the plan.

Last updated: 2026-10-29 by Grok (PR 144: main merged, review fixes).

## Who is working now

| Agent  | State                     | Items it may work on |
|--------|---------------------------|----------------------|
| Claude | active                    | rows it owns, one at a time; when otherwise idle, Grok-owned rows R03, R04, R11, R13, R14a (rule 14) |
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
7. **Review (Russell 2026-10-26, 18:47 GMT).** Cross-review applies only to
   consensus rows.
   - **Consensus (`Y`) rows:** the other side reviews the row (Grok reviews
     Claude's, Claude reviews Grok's), on top of the row's review lanes and
     Russell's sign-off on the exact diff and pins. That review comes before
     any merge ask. PR 130 (R01) is the one dated waiver, recorded in its
     Review.
   - **Non-consensus (`N`) rows:** the side doing the work is trusted. Its
     own evaluator lanes review the row, and no cross-review is needed. The
     Reviewer cell names those lanes.
   - **An `N` row that turns out to need a consensus change** becomes `Y`
     and needs cross-review.
   - The Review section rule (rule 10) still applies to every PR.
8. **Consensus.** A row marked `Y` moves consensus or pins. A `Y` row stops
   for Russell's sign-off on the exact diff and the pins before it is
   committed.
   - **Before mainnet (Russell 2026-10-29):** shear-dev may start before
     every consensus row lands; late rows land by the 30 Nov freeze and go
     onto shear-dev.
   - **After mainnet (Russell 2026-10-26):** a post-mainnet `Y` row (R09 and
     R10, and any later ones) lands as its own mainnet activation. It needs
     all of these:
     - a named activation height, set in advance;
     - the rules both before and after that height tested;
     - Russell's sign-off on the diff and the pins;
     - a stressnet or shear-dev run of the activation before it goes live.
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
12. **Bootstrap (Russell 2026-10-26, 20:18 GMT).** The old raw-datadir
    bootstrap is retired, for our own nodes and for users.
    - Mainnet ships no datadir snapshot publisher, and no client fetches a
      snapshot. Every node syncs and verifies from genesis itself.
    - Until R21 lands, users who don't run a node use light wallet mode
      against a node they choose, and node runners rely on pruning.
    - Light wallet mode is the privacy risk, not the snapshot. R21's light
      wallet conditions (local scan, no view key or note queries to a node,
      own node by default, a plain warning in remote-node mode, the privacy
      review first) are in its row.
    - The old bootstrap is removed in one small PR before the v12 cut
      (R16), owned by Claude (Russell 26 Oct, 20:30 GMT). It covers the
      node's automatic snapshot write every 200 blocks, the `--bootstrap`
      flag, the help text, the wallet's dead URL constant, the boot site
      pages and the deploy files. The places are listed in the Review of the
      PR that recorded this rule.
    - Today's light and remote-node wallet is checked against R21's privacy
      conditions now. Any place it sends a view key or asks a node about
      specific notes is a pre-mainnet bug: a root-cause fix with a test
      before v12.
13. **Real-path end-to-end test (Russell 2026-10-27).** Every row's merge
    ask includes at least one end-to-end test that runs a real wallet
    against a real node, and the pool too where the row touches it, on a
    server.
    - Nothing on the path under test is a fake: no mock HTTP client, stub
      route, fake pool or hand-built chain state in place of the real one.
    - The Review records the run ID, the host and the head it ran on.
    - The in-process two-holder test (`test_dart_withdraw_queue_v12`) does not
      meet this rule (Russell 27 Oct); it is a labelled unit test. The model is
      R01b's multi-process e2e (real node, pool and miner processes, the real
      wallet library over HTTP). The in-process test, for reference:
      Dart-built locks for two holders are mined by a real store. The
      wallet reads the frozen lists from the node's real RPC and checks
      them against its own synced blocks. Its claim and vote are mined.

14. **Idle pick-up of Grok rows (Russell 2026-10-27).** Claude may take a
    Grok-owned row (R03, R04, R11, R13, R14a) whenever it would otherwise be
    idle.
    - The owner change is written in the row here and in the workbook when
      the row is taken.
    - A consensus (Y) row Claude does is cross-reviewed by Grok, as rule 7
      requires.
    - Grok is reassigned to other rows or to reviews.

15. **Genesis readiness (Russell 2026-10-27).**
    - **Consensus freeze 30 Nov.** No new consensus (Y) row after that; only
      fixes to Y rows already open.
    - **Batched consensus reviews:** R01a with R02, and R25 with R05. Each
      batch gets one Grok cross-review and one pin move.
    - **R27 first.** Its shared multi-process harness lands first, in early
      November, and gates every later merge ask (rule 13).
    - **Stressnet keeps its full 7 days.** If anything slips, its start
      moves; it is never shortened. Genesis stays Mon 21 Dec 2026 14:00 UK,
      and any move needs Russell's sign-off.
    - **R18a:** check this week whether the provider keeps each IP across a
      rebuild; write and container-test the rebuild scripts in November.
16. **Reviews are done on the code, not the concept (Russell 2026-10-27,
    22:29 GMT).**
    - Once a row has a design note (and rulings, where they are needed),
      Claude may start coding it at once on its own branch as a draft PR.
      There is no wait for a concept review.
    - The Grok team reviews the code and the tests, with the design note as
      context. Holes they find are fixed in the code, then Claude reviews
      the team's fixes.
    - Unchanged: Y rows still need cross-review. Merges, pin sign-offs (as
      an exact diff), cuts, tags, deploys and live-site changes still need
      Russell's GO, one at a time.
    - R28 BluNotes is the first row under this rule.

## Rows

Target dates are from the work plan, starting 25 Oct 2026: expected finish,
with the best-to-worst range in brackets. Every day spent waiting for a GO
moves the later rows by a day.

**The public table** below is the only part of a row that reaches the public page
(site/roadmap, built by `scripts/build_roadmap_page.mjs`), and it carries exactly six
columns: Priority, ID, Public title, Type (Y moves a consensus pin, N does not), Status
and Ref. Any other column, or a row with more cells, fails the build. Every row
needs a Public title: plain ASCII, neutral, what the row delivers, never the name of a
finding, a severity, an internal label (PR, Goal, lane), a host, a person, an email or a
file path; the build fails without one. An ID is `R` plus two digits and an optional
lower-case letter. Status is one vocabulary word (rule 5, plus `ruled`, `coding`,
`shipped`, `deployed`); any other status fails the build, and a done, closed, merged,
shipped or deployed row drops off the page. A `|` inside a cell is written `\|`.

**Row detail.** Every row keeps its detail (item, consensus note, status note, owner,
reviewer, claim, PR, head SHA, target) in the maintainers' tracker `docs/ROADMAP.tracker.md`,
which is gitignored and never committed; the Ref cell names the row there. Every row carries a
Ref, so the column says nothing about what a row is. Rules 1, 3, 5 and 7 apply through the
tracker, where each row's Owner, Reviewer, Working now and PR cells live; a claim on a row is
made there. Host details (names, addresses, providers, OS plans) live there too, never here.

| Priority | ID | Public title | Type | Status | Ref |
|----------|----|--------------|------|--------|-----|
| 2 | R01b | Vault claim post from the wallet | Y | planned | rf-5177b4af1d |
| 3 | R29 | Pool share payee checks | Y | planned | rf-d0839ef12a |
| 4 | R01a | Coinbase payout key binding | Y | planned | rf-2e557d9aba |
| 5 | R02 | Vault lock-note binding | Y | planned | rf-b7b9fc3e07 |
| 6 | R26 | Reserve wallet sync checks | N | planned | rf-943b6598c6 |
| 7 | R07 | Spend proof update | Y | planned | rf-11afbe39d8 |
| 8 | R06 | Wire decode and share commitment rules | Y | planned | rf-1bf8b8f04c |
| 9 | R28 | BluNotes: hidden share payees and payouts | Y | coding | rf-9086c200d6 |
| 9 | R33 | Share batch encoding | Y | planned | rf-e22ce34431 |
| 9 | R35 | Share header window | Y | planned | rf-e309e4cfe5 |
| 9 | R36 | Hash-bonus record root | Y | planned | rf-09460ee09b |
| 10 | R01c | Wallet light mode scan | N | planned | rf-71f06e541f |
| 13 | R05 | Book magic on every path | Y | planned | rf-2562fe081f |
| 14 | R30 | Share selection limits | N | planned | rf-6520f48d0e |
| 14 | R32 | Owed ledger bounds | Y | planned | rf-066a8681d1 |
| 14 | R34 | Idle hash-note rule | Y | planned | rf-c15dc8021f |
| 15 | R39 | Share verify cost | N | planned | rf-04cbd0beae |
| 16 | R04 | Native hash threading | N | planned | rf-7ccf14ebc7 |
| 17 | R24 | Test chain fixtures | N | planned | rf-55b80c2d78 |
| 17 | R27 | Real-path money scenarios | N | planned | rf-dbcfdd6f44 |
| 18 | R14a | Public supply audit tool | N | planned | rf-b9bfcba500 |
| 19 | R31 | Pool owed rows across a restart | N | planned | rf-dc88d73b77 |
| 21 | R37 | Miner-side coinbase template check | N | planned | rf-10ef63d6a8 |
| 22 | R08 | Real-data fixtures: consensus paths | N | planned | rf-2a19c49185 |
| 22 | R11 | Real-data fixtures: the CI guard | N | planned | rf-36bb34d706 |
| 22 | R12 | Reserve epoch, withdraw and claim follow-ups | Y | planned | rf-17df7210ac |
| 22 | R23 | Wallet test failures | N | planned | rf-acc0e3a1ee |
| 22 | R38 | Site tests in CI | N | planned | rf-71a44c4a8a |
| 23 | R03 | CLI reserve lock | N | planned | rf-838af1db41 |
| 23 | R13 | Wallet copy | N | planned | rf-ffe325a026 |
| 23 | R14 | Dev-network pin move | Y | planned | rf-cba38bb5a1 |
| 24 | R15 | Dev-network deploy and bug hunt | N | planned | rf-f99b57fe35 |
| 24 | R18a | Host rebuild for the mainnet OS split | N | planned | rf-1ab7050b44 |
| 24 | R16 | v12 cut | N | planned | rf-d41c894997 |
| 24 | R17 | Stressnet (7-day floor) | N | planned | rf-ae4e9bc994 |
| 24 | R18b | Mainnet release deploy | N | planned | rf-7fe4eb4baa |
| 24 | R19 | Mainnet genesis | N | planned | rf-8179034073 |
|  | R01 | Transaction digest update | Y | merged | rf-df416a59c8 |
|  | R09 | Token spec | N | planned | rf-5dc8f51c56 |
|  | R10 | Confidential tokens build | Y | planned | rf-8659713d91 |
|  | R20 | Android ABIs beyond arm64-v8a | N | planned | rf-1443e24717 |
|  | R21 | Pinned note-set snapshot | Y | planned | rf-390798bf2a |
|  | R25 | Epoch rate row | Y | planned | rf-4b8c69dd2a |
|  | R40 | Hash key derivation | Y | ruled | rf-f11557d2f7 |
|  | R41 | ShearK-Miner optimisation | N | coding | rf-04db6c04b3 |

**Float (26 Oct, first estimate; superseded by the current float in the agent split note below).** With R09 and R10 after mainnet, the rows from R11 on can run about 6 days (5 to 8) sooner than their targets above. That puts the mainnet release ready around 8–9 Dec on target and 14–18 Dec if every row runs to the late end of its window, against the fixed genesis of 21 Dec 14:00 UK. Without the move it was 14–15 Dec on target, and a late run missed 21 Dec by 1–2 days. The target dates above are unchanged, and the float is not a new date. Plan against it, report any slip that uses it, and an earlier genesis needs Russell's consensus sign-off (rule 8).

**Priority column (Russell, 30 Oct 2026).** Russell's priority order over the rows on `main`; hard dependencies stand (R02 after R01b, R05 after R04, R24 then R27, R37 after R01a). Rows with no number were not in that order and keep their place after the numbered rows, in their previous order: R01 (merged), R09, R10, R20, R21 (post-mainnet), R25, R40, R41. Items in the order that have no row here (#0 roadmap page, FS-1 round 5, the #163 fix round, exact π per lock, the test spread, full Dandelion++) wait for Russell's rows (rule 6). The public page at shear.digital/roadmap is generated from this table by `scripts/build_roadmap_page.mjs`.

**Agent split (Russell 26 Oct, 19:05 GMT).** R03, R04, R11 and R13 are Grok's, and R14a is Grok's under rule 14 (Russell 27 Oct). Each falls back to Claude at the slot in its Target cell if Grok's credits run short, so the split can move with credits; it is not fixed. The heaviest rows stay with Claude: R01–R02, R05, R06, R07, R08, R12, R14 and R15–R19. Grok cross-reviews every `Y` row (rule 7), including R07. A Grok row starts only after the Claude row whose files it shares has merged (rule 4). **Current float (26 Oct, recalculated):** the mainnet release is ready around **8–11 Dec on target** and **14–18 Dec at the late end**, against the fixed genesis of 21 Dec 14:00 UK. That is 10–13 days of float on target and 3–7 days at the late end. This counts R01b (1–2 days) and R01a (2–3 days with the design GO) on Claude's path, which the earlier figure missed. It also counts R04 landing on its own server by about 2 Nov, so R05 most likely does not wait for it. **The main risk is R15**, the shear-dev bug hunt: if it runs long it eats most of the float, so watch it closely once shear-dev starts. These are estimates. The target dates above are unchanged.

R01a and R14a were added by Russell on 26 Oct; their detail is in the maintainers' tracker.

R03 (CLI reserve lock) stays where it is (Russell, 25 Oct). R09 (token
spec) and R10 (confidential tokens build, a vort1 vortice) moved to after mainnet
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
5. **Wallet Dart suite (R23, Russell 27 Oct).** Every wallet test file
   passes on the servers, with the vortice-scope skip the only exception.
   The R23 list is empty, or each entry left has a dated ruling.
6. **Painted-number sweep (Russell 27 Oct).** Report what is found before
   fixing anything.
   1. Grep the wallet, node and pool for every fallback that turns missing
      data into a number that is shown or used. Missing data means a 404,
      403, timeout, null or unscanned state. Each one either fails closed
      or shows "syncing".
   2. The 35 pre-existing Dart test failures are R23's work (item 5); the
      sweep only checks that none stays silently unwired.
   3. Find every test that uses a fake HTTP client on a money or Spendable
      path, and give each one a real-path counterpart (rule 13).

## R18a and R18b: mainnet hosts and OS split

Each wipe or reinstall needs Russell's GO, one host at a time. Which host runs which OS is
kept in the maintainers' tracker.

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
   the provider's rebuild keeps each IP (if not, reserve the IP). If an IP does
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

1. Remove everything testing left behind: `<server-ci-dir>`, lane scripts
   and tars, testnet and stressnet datadirs, test services, timers, cron
   jobs, wallets, keys, logs, and VM or container images.
2. Deploy only the mainnet release build from a tagged commit. No silent
   automatic systemctl recoveries.
3. Verify, don't paint: a check on each host lists its services, ports and
   files, and shows nothing from testing. Record it in the launch log with
   the release SHA.
