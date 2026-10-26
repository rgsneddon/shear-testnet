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
   - **Before mainnet:** every pre-mainnet `Y` row must land before
     shear-dev starts, or it forces a reset.
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
      own node by default, Tor to anyone else's, a plain warning in
      remote-node mode, Privacy Auditor first) are in its row.
    - The old bootstrap is removed from the wallet, node and site before
      the v12 cut (R16). The places are listed in the Review of the PR that
      recorded this rule.

## Rows

Target dates are from the work plan, starting 25 Oct 2026: expected finish,
with the best-to-worst range in brackets. Every day spent waiting for a GO
moves the later rows by a day.

| ID | Item | Consensus? | Status | Owner | Reviewer | Working now | PR | Head SHA | Target |
|----|------|------------|--------|-------|----------|-------------|----|----------|--------|
| R01 | PR 130: digestTx and bundled fixes | Y: `TX_DIGEST=body-v2`, `COINBASE_V=opens`, `COINBASE_NC=dest-bound`, the memo binding (`FS1_MEMO=bound`) and the new mainnet genesis move the testnet, mainnet and mainnetFP pins | active | Claude | Grok + Protocol, Vault Security, Pool Share, Codebase, Privacy, pins | Claude, cursor/v12-followups-3daf, since 2026-10-23 | [#130](https://github.com/rgsneddon/shear-testnet/pull/130) | 83ea4352 (pushed; rebuilt chain local, awaiting the fresh consensus sign-off) | 28 Oct (28–29 Oct) |
| R01b | Vault claim post: pool `queuedRewardClaim` takes the FS-1 claim body the wallet sends (found in the PR 107 coverage report: it still expects the old `to` and `proof` shape, so an in-app Vault claim likely fails with `bad_send`). A reproducing test comes first; if confirmed, the fix, a wallet → pool → mempool test and a `double_mint` refusal. A launch blocker | N: pool policy and wallet only; verifyBlock and apply unchanged | planned | Claude | Owner's lanes: Vault Security, Pool Share, Wallet | | | | straight after R01, ahead of R01a and R02 (Russell 26 Oct) |
| R01a | Coinbase spend-key binding: a coinbase payout's admitPub bound to its payee | Y: a coinbase row's spend key must derive from the payee's admit base; the design says how that base is on chain or derivable after pruning | planned (design to Russell first) | Claude | Grok + Protocol, Privacy, pins; Grok bot evaluators read the design from Thu 29 Oct | | | | after R01, before R02 (date set on the design GO) |
| R02 | Vault F1 lock-note binding | Y: binds the owner key point into the signed lock digest; new vectors | planned | Claude | Grok + Vault Security, Protocol, Wallet Hardening, pins | | | | 30 Oct (29–31 Oct) |
| R03 | CLI reserve lock | N: Dart CLI wiring only | planned | Grok | Owner's lanes: Wallet Hardening, pins | | | | 31 Oct (30 Oct–1 Nov); starts after R02 merges (it builds on the new lock digest). Fallback: Claude, after R05 |
| R04 | Hash-safety | N: native ShearHash thread and key safety; digests stay byte-identical | planned | Grok | Owner's lanes: Codebase, pins | | | | 2 Nov (31 Oct–3 Nov); Grok starts Fri 30 Oct, after the credit reset. Fallback: Claude, straight after R02 |
| R05 | PR 2: book magic everywhere | Y: changes behaviour on the mainnet, regtest and shear-dev books (testnet byte-identical; pins must not move) | planned | Claude | Grok + Protocol, Vault Security, pins | | | | 4 Nov (3–6 Nov); waits for R04 to merge, since both touch `node/src/chain.js`, `pool/src/pool.js`, `crypto/shear_hash.test.js`, `node/tests/test_hash_bonus_cap.js` and `tests/ci_pending.txt` (rule 4) |
| R06 | Goals 6–9 (register signing, strict wire decode, 018e share commitment, T21 hidden payout) | Y: each changes what a block may hold | planned | Claude | Grok + Protocol, Pool Share, Privacy, pins | | | | 9 Nov (7–11 Nov) |
| R07 | Goal 10 F: FCMP++ hardening | Y: spend proof checks | planned | Claude | Grok + Privacy, Protocol, pins | | | | 10 Nov (8–12 Nov) |
| R08 | PR 3a: real-data fixtures, consensus paths | N: tests only | planned | Claude | Owner's lanes: Codebase | | | | 13 Nov (10–15 Nov) |
| R11 | PR 3b: remaining real-data fixtures and CI guard | N: tests and CI only | planned | Grok | Owner's lanes: Codebase | | | | 21 Nov (17–26 Nov); starts after R08 merges (the shared mining module). Fallback: Claude, after R12 |
| R12 | Goal 10 A–D: four PR updates (A #117, B #111, C #93, D #107). B stays before mainnet for the Vault claim mint-once test cover. D is trimmed (Russell 26 Oct, approved) to what PR 116's hidden-claim API does not already cover: pool fee-quote stubs and a rewritten `claim_fee_quote_test`; D2, a per-row "Principal unlocked" label with a Withdraw button that stays visible, plus a widget test; D5, `shear_wallet_test` and the claim-fee test in CI; SHA-256 pins on `libshear_v3.so`, checked in CI. D1 is already covered on base. 107's reward-set scan and its RPC, `publishedRewardSets`, `portalClaimableNanos`, `reserveWireBody`, the libshearhash builds, the wallet ASERT copy, the epoch-end unlock clock and `releaseTimeLockPrincipal` are dropped; the last would break D1 and the never-painted rule. The claim post fix is R01b. Android stays arm64-only for launch. E (#98) is folded into R16 (Russell 26 Oct) | Y: A (epoch-end gas) and C (withdraw policy) change consensus | planned | Claude | Grok + Protocol, Vault Security, pins | | | | 25 Nov (20–30 Nov) |
| R13 | Wallet copy | N: wallet text and errors only | planned | Grok | Owner's lanes: Wallet Hardening | | | | 27 Nov (22 Nov–2 Dec); starts after R12 merges (D touches `main.dart`). Fallback: Claude, beside R14 |
| R14 | PR 128 M3: shear-dev pin move | Y: moves the shear-dev pin only; every other pin must equal main | planned | Claude | Grok + Protocol, pins | | | | 27 Nov (22 Nov–3 Dec) |
| R14a | Public supply audit tool: a CLI that reads one's own node and checks, genesis to tip, that emission plus mints minus burns equals the commitment sum with every range proof valid; prints the public supply figure and pass, or fail at the exact height. No phone-home, no pool reliance | N, unless the design needs a consensus change (then Y, with the reason) | planned (lane idle until Thu 29 Oct; spec first, no code before Russell approves it) | TBD (Thu 29 Oct 15:00 alignment) | Public Supply Audit lane (Claude side) and Supply Auditor (Grok side) | | | | before R15, so it runs on shear-dev and stressnet before genesis |
| R15 | shear-dev deploy GO and live bug hunt | N: operational; fixes found there are their own PRs | planned | Claude | Owner's evaluator lanes; Grok is a second live bug hunter, reporting through the review docs | | | | 2 Dec (25 Nov–10 Dec) |
| R18a | Host rebuild on the mainnet OS split (pool Ubuntu LTS, p2p-a Debian stable, p2p-b Fedora Server), so stressnet runs on the mainnet OSes | N: hosts only | planned | Claude | Owner's evaluator lanes | | | | after R15, before R16 (estimate 1–2 days; the later rows move by that) |
| R16 | v12 cut (onto the rebuilt hosts), run from the R16 cut checklist below (folded in from #98, Russell 26 Oct) | N: operational; pins checked at the cut | planned | Claude | Owner's lanes: pins | | | | 3 Dec (26 Nov–11 Dec) |
| R17 | Stressnet (7-day floor) | N: live testnet | planned | Claude | Owner's evaluator lanes; Grok is a second live bug hunter, reporting through the review docs | | | | 10 Dec (3–18 Dec) |
| R18b | Final wipe of testing leftovers and mainnet release deploy | N: hosts only | planned | Claude | Owner's lanes: pins | | | | 18–21 Dec |
| R19 | Mainnet genesis | N: date fixed by R01 | planned | Claude | Owner's lanes: pins | | | | Mon 21 Dec 2026 14:00 UK (fixed) |
| R09 | Token spec (mint.shear.digital), spec only: the first half of the R09–R10 vortice session under rule 11 | N: a spec, no code | planned (post-mainnet) | Claude | Owner's lanes: all lanes | | | | after R19; no date until Russell sets one |
| R10 | Private tokens build (a vort1 vortice): the second half of the R09–R10 vortice session under rule 11, after the R09 spec is signed off | Y: new tx kind and consensus rules | planned (post-mainnet) | Claude | Grok + all lanes, pins | | | | after R19; no date until Russell sets one |
| R20 | Android ABIs beyond arm64-v8a | N: wallet packaging only | planned (post-mainnet) | Claude | Owner's lanes: Wallet | | | | after R19; no date until Russell sets one (Russell 26 Oct: arm64-only for launch) |
| R21 | Pinned note-set snapshot (assumeutxo style): a node may load a UTXO/note-set snapshot whose hash is pinned in the release binary, becomes usable quickly, and still re-verifies from genesis in the background, refusing the snapshot if the result differs. The snapshot can come from anywhere, because the pin is trusted, not the source. No phone-home. Replaces the retired raw-datadir bootstrap (rule 12). **Light wallet privacy (Russell 26 Oct, 20:21 GMT):** the snapshot is public chain data and leaks nothing; light wallet mode is the risk, so it must meet all of these: the wallet downloads every block or output and scans locally, never sends a view key to a node, and never asks a node about specific notes or outputs; it defaults to the user's own node, and uses someone else's node only over Tor; remote-node mode shows a plain warning of what that node can still see (IP address and online times); and the Privacy Auditor reviews the design before any code | Y: a pinned snapshot hash in the release binary, and the rule that refuses a snapshot whose background re-verify differs | planned (post-mainnet) | Claude | Grok + Protocol, Privacy Auditor (the light-wallet design, before any code), pins | | | | after R19; no date until Russell sets one (Russell 26 Oct) |

**Float (26 Oct, first estimate; superseded by the current float in the agent split note below).** With R09 and R10 after mainnet, the rows from R11 on can run about 6 days (5 to 8) sooner than their targets above. That puts the mainnet release ready around 8–9 Dec on target and 14–18 Dec if every row runs to the late end of its window, against the fixed genesis of 21 Dec 14:00 UK. Without the move it was 14–15 Dec on target, and a late run missed 21 Dec by 1–2 days. The target dates above are unchanged, and the float is not a new date. Plan against it, report any slip that uses it, and an earlier genesis needs Russell's consensus sign-off (rule 8).

**Agent split (Russell 26 Oct, 19:05 GMT).** R03, R04, R11 and R13 are Grok's. Each falls back to Claude at the slot in its Target cell if Grok's credits run short, so the split can move with credits; it is not fixed. The heaviest rows stay with Claude: R01–R02, R05, R06, R07, R08, R12, R14 and R15–R19. Grok cross-reviews every `Y` row (rule 7), including R07. A Grok row starts only after the Claude row whose files it shares has merged (rule 4). **Current float (26 Oct, recalculated):** the mainnet release is ready around **8–11 Dec on target** and **14–18 Dec at the late end**, against the fixed genesis of 21 Dec 14:00 UK. That is 10–13 days of float on target and 3–7 days at the late end. This counts R01b (1–2 days) and R01a (2–3 days with the design GO) on Claude's path, which the earlier figure missed. It also counts R04 landing on Grok's own VPS by about 2 Nov, so R05 most likely does not wait for it. **The main risk is R15**, the shear-dev bug hunt: if it runs long it eats most of the float, so watch it closely once shear-dev starts. These are estimates. The target dates above are unchanged.

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
