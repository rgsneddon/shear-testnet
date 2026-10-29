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
      own node by default, a plain warning in remote-node mode, Privacy
      Auditor first) are in its row.
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
    - **R18a:** check this week whether Hetzner keeps each IP across a
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

| ID | Item | Consensus? | Status | Owner | Reviewer | Working now | PR | Head SHA | Target |
|----|------|------------|--------|-------|----------|-------------|----|----------|--------|
| R01 | PR 130: digestTx and bundled fixes | Y: `TX_DIGEST=body-v2`, `COINBASE_V=opens`, `COINBASE_NC=dest-bound`, the memo binding (`FS1_MEMO=bound`) and the new mainnet genesis move the testnet, mainnet and mainnetFP pins | active | Claude | Grok + Protocol, Vault Security, Pool Share, Codebase, Privacy, pins | Claude, cursor/v12-followups-3daf, since 2026-10-23 | [#130](https://github.com/rgsneddon/shear-testnet/pull/130) | 83ea4352 (pushed; rebuilt chain local, awaiting the fresh consensus sign-off) | 28 Oct (28–29 Oct) |
| R01b | Vault claim post: pool `queuedRewardClaim` takes the FS-1 claim body the wallet sends (found in the PR 107 coverage report: it still expects the old `to` and `proof` shape, so an in-app Vault claim likely fails with `bad_send`). A reproducing test comes first; if confirmed, the fix, a wallet → pool → mempool test and a `double_mint` refusal. **Russell 27 Oct:** the node-side `vaultProof` revive in the block-decode path (`reviveTx`, also the P2P decode) and the wallet prover's epoch-root and period fix (build from the full on-chain epoch tree, not only the wallet's own locks; pass a period, not an epoch) go in this same PR. **Moved here from R01c (Russell 27 Oct):** the wallet's own claimable figure from chain data (lock leaves, closed periods' freeze rows, minus nullifiers minted on chain; never the pool's `claimable`). A launch blocker | Y: the block-decode revive of `vaultProof` (Russell 27 Oct) | planned | Claude | Grok + Vault Security, Pool Share, Wallet, Protocol, pins; exact-diff sign-off | | | | straight after R01, ahead of R01c, R01a and R02 (Russell 26 Oct) |
| R01c | Wallet remote-node privacy leak: the wallet sends each owned dest with a view-key-derived opening (`notes()`, `balance()`, `history()`) and the Reserve portal dest (`reservePortal()`) to any node that is not the pool host: public seeds after consent, and any own-node URL. Fix: remove the three remote calls (the local scan already supplies notes, Spendable and history, and nodes answer them 404); read the portal from downloaded Reserve state or the whole-book `reserveTrancheBook`; **early in R01c (Russell 27 Oct): the pool's `staked`/`idle` figure that reaches `setReserveHeldNanos` and so changes Spendable and the send pool (painted sweep HIGH);** correct the warning copy and stop skipping it for an own node that is not on the same machine. Tests: a guard that no request to a non-loopback host carries a dest, `open`/`X-Shear-Open`, a view key or a portal id; a mutation check for each removed call; Spendable after login unchanged and still only from the local scan. **Moved to R01b (Russell 27 Oct):** the wallet's own claimable figure from chain data (lock leaves, closed periods' freeze rows, minus nullifiers minted on chain; never the pool's `claimable`), so R01c does not redo it. A launch blocker | N: wallet only | planned | Claude | Owner's lanes: Privacy Auditor, Wallet Hardening | | | | straight after R01b, ahead of R01a and R02 (Russell 26 Oct, 20:40 GMT) |
| R01a | Coinbase spend-key binding: a coinbase payout's admitPub bound to its payee **Russell 27 Oct: option B (the mining-base registry: the first payout carries a one-time certificate, later payouts are checked against `mineBase[dest20]`), mining addresses required from the start with no unregistered window (privacy first); the miner-side template check is its own row (R37). Design: Desktop R01a-coinbase-binding-design.md.** | Y: a coinbase row's spend key must derive from the payee's admit base; the design says how that base is on chain or derivable after pruning | planned (design to Russell first) | Claude | Grok + Protocol, Privacy, pins; Grok bot evaluators read the design from Thu 29 Oct | | | | after R01, before R02 (date set on the design GO); batched with R02: one Grok review, one pin move (rule 15); before the 30 Nov freeze |
| R02 | Vault F1 lock-note binding | Y: binds the owner key point into the signed lock digest; new vectors | planned | Claude | Grok + Vault Security, Protocol, Wallet Hardening, pins | | | | 9 Nov (Russell 27 Oct; was 30 Oct); after R01b merges (Reserve.sol); one review and pin move batched with R01a (rule 15) |
| R03 | CLI reserve lock | N: Dart CLI wiring only | planned | Grok | Owner's lanes: Wallet Hardening, pins | | | | TBD (CoS), no earlier than R02's 9 Nov: starts after R02 merges (it builds on the new lock digest; was 31 Oct when R02 was 30 Oct). Fallback: Claude, after R05 |
| R04 | Hash-safety | N: native ShearHash thread and key safety; digests stay byte-identical | planned | Grok | Owner's lanes: Codebase, pins | | | | 2 Nov (31 Oct–3 Nov); Grok starts Fri 30 Oct, after the credit reset. Fallback: Claude, straight after R02 (so no earlier than 9 Nov; date TBD (CoS)) |
| R05 | PR 2: book magic everywhere | Y: changes behaviour on the mainnet, regtest and shear-dev books (testnet byte-identical; pins must not move) | planned | Claude | Grok + Protocol, Vault Security, pins | | | | 4 Nov (3–6 Nov); waits for R04 to merge, since both touch `node/src/chain.js`, `pool/src/pool.js`, `crypto/shear_hash.test.js`, `node/tests/test_hash_bonus_cap.js` and `tests/ci_pending.txt` (rule 4); batched with R25: one Grok review, one pin move (rule 15); before the 30 Nov freeze |
| R06 | Goals 6–9 (register signing, strict wire decode, 018e share commitment, T21 hidden payout) | Y: each changes what a block may hold | planned | Claude | Grok + Protocol, Pool Share, Privacy, pins | | | | 9 Nov (7–11 Nov); before the 30 Nov consensus freeze (rule 15) |
| R07 | Goal 10 F: FCMP++ hardening | Y: spend proof checks | planned | Claude | Grok + Privacy, Protocol, pins | | | | 10 Nov (8–12 Nov); before the 30 Nov consensus freeze (rule 15) |
| R08 | PR 3a: real-data fixtures, consensus paths | N: tests only | planned | Claude | Owner's lanes: Codebase | | | | 13 Nov (10–15 Nov) |
| R11 | PR 3b: remaining real-data fixtures and CI guard | N: tests and CI only | planned | Grok | Owner's lanes: Codebase | | | | 21 Nov (17–26 Nov); starts after R08 merges (the shared mining module). Fallback: Claude, after R12 |
| R12 | Goal 10 A–D: four PR updates (A #117, B #111, C #93, D #107). B stays before mainnet for the Vault claim mint-once test cover. D is trimmed (Russell 26 Oct, approved) to what PR 116's hidden-claim API does not already cover: pool fee-quote stubs and a rewritten `claim_fee_quote_test`; D2, a per-row "Principal unlocked" label with a Withdraw button that stays visible, plus a widget test; D5, `shear_wallet_test` and the claim-fee test in CI; SHA-256 pins on `libshear_v3.so`, checked in CI. D1 is already covered on base. 107's reward-set scan and its RPC, `publishedRewardSets`, `portalClaimableNanos`, `reserveWireBody`, the libshearhash builds, the wallet ASERT copy, the epoch-end unlock clock and `releaseTimeLockPrincipal` are dropped; the last would break D1 and the never-painted rule. The claim post fix is R01b. Android stays arm64-only for launch. E (#98) is folded into R16 (Russell 26 Oct) | Y: A (epoch-end gas) and C (withdraw policy) change consensus | planned | Claude | Grok + Protocol, Vault Security, pins | | | | 25 Nov (20–30 Nov); before the 30 Nov consensus freeze (rule 15) |
| R13 | Wallet copy | N: wallet text and errors only | planned | Grok | Owner's lanes: Wallet Hardening | | | | 27 Nov (22 Nov–2 Dec); starts after R12 merges (D touches `main.dart`). Fallback: Claude, beside R14 |
| R14 | PR 128 M3: shear-dev pin move | Y: moves the shear-dev pin only; every other pin must equal main | planned | Claude | Grok + Protocol, pins | | | | 27 Nov (22 Nov–3 Dec); before the 30 Nov consensus freeze (rule 15) |
| R14a | Public supply audit tool: a CLI that reads one's own node and checks, genesis to tip, that emission plus mints minus burns equals the commitment sum with every range proof valid; prints the public supply figure and pass, or fail at the exact height. No phone-home, no pool reliance | N, unless the design needs a consensus change (then Y, with the reason) | planned (lane idle until Thu 29 Oct; spec first, no code before Russell approves it) | Grok (rule 14, Russell 27 Oct; Claude may take it when idle) | Public Supply Audit lane (Claude side) and Supply Auditor (Grok side) | | | | before R15, so it runs on shear-dev and stressnet before genesis |
| R15 | shear-dev deploy GO and live bug hunt | N: operational; fixes found there are their own PRs | planned | Claude | Owner's evaluator lanes; Grok is a second live bug hunter, reporting through the review docs | | | | about 27 Nov (range TBD (CoS)), ahead of the v12 cut around 3 Dec, so R15, then R18a (1–2 days), then R16 fit (was 2 Dec) |
| R18a | Host rebuild on the mainnet OS split (pool Ubuntu LTS, p2p-a Debian stable, p2p-b Fedora Server), so stressnet runs on the mainnet OSes | N: hosts only; agent-box is now the explorer node (Russell 29 Oct, 10:46): whether R18a rebuilds it, and on which OS, is TBD (CoS) | planned | Claude | Owner's evaluator lanes | | | | after R15, before R16 (estimate 1–2 days; the later rows move by that); Hetzner IP persistence checked this week; rebuild scripts written and container-tested in November (rule 15) |
| R23 | The pre-existing wallet Dart failures: 35 test files that fail the same way on feat `dc1422ed` and on PR 130 (native108 and the feat baseline, listed in the PR 130 Review). Each gets a root-cause fix with real data, or a dated ruling; none is left "known" | N: wallet tests and the code they find | planned | Claude | Owner's lanes: Wallet Hardening | | | | before R16; its gate is item 5 of the R16 cut checklist (Russell 27 Oct) |
| R16 | v12 cut (onto the rebuilt hosts), run from the R16 cut checklist below (folded in from #98, Russell 26 Oct) | N: operational; pins checked at the cut | planned | Claude | Owner's lanes: pins | | | | 3 Dec (26 Nov–11 Dec) |
| R17 | Stressnet (7-day floor) | N: live testnet | planned | Claude | Owner's evaluator lanes; Grok is a second live bug hunter, reporting through the review docs | | | | 10 Dec (3–18 Dec); the full 7 days always; on a slip its start moves, never its length (rule 15) |
| R18b | Final wipe of testing leftovers and mainnet release deploy (pool, p2p-a, p2p-b; agent-box, the explorer node since Russell 29 Oct 10:46, is in scope or not: TBD (CoS)) | N: hosts only | planned | Claude | Owner's lanes: pins | | | | 18–21 Dec |
| R19 | Mainnet genesis | N: date fixed by R01 | planned | Claude | Owner's lanes: pins | | | | Mon 21 Dec 2026 14:00 UK (fixed); any move needs Russell's sign-off (rule 15) |
| R09 | Token spec (mint.shear.digital), spec only: the first half of the R09–R10 vortice session under rule 11 | N: a spec, no code | planned (post-mainnet) | Claude | Owner's lanes: all lanes | | | | after R19; no date until Russell sets one |
| R10 | Private tokens build (a vort1 vortice): the second half of the R09–R10 vortice session under rule 11, after the R09 spec is signed off | Y: new tx kind and consensus rules | planned (post-mainnet) | Claude | Grok + all lanes, pins | | | | after R19; no date until Russell sets one |
| R20 | Android ABIs beyond arm64-v8a | N: wallet packaging only | planned (post-mainnet) | Claude | Owner's lanes: Wallet | | | | after R19; no date until Russell sets one (Russell 26 Oct: arm64-only for launch) |
| R21 | Pinned note-set snapshot (assumeutxo style): a node may load a UTXO/note-set snapshot whose hash is pinned in the release binary, becomes usable quickly, and still re-verifies from genesis in the background, refusing the snapshot if the result differs. The snapshot can come from anywhere, because the pin is trusted, not the source. No phone-home. Replaces the retired raw-datadir bootstrap (rule 12). **Light wallet privacy (Russell 26 Oct, 20:21 GMT):** the snapshot is public chain data and leaks nothing; light wallet mode is the risk, so it must meet all of these: the wallet downloads every block or output and scans locally, never sends a view key to a node, and never asks a node about specific notes or outputs; it defaults to the user's own node; when it uses someone else's node, remote-node mode shows a plain warning of what that node can still see (IP address and online times); and the Privacy Auditor reviews the design before any code and proposes any network-privacy measure there. **Wallet node setting (Russell 26 Oct, 20:30 GMT):** the user enters their own node's host or IP and port, defaulting to a local node; the wallet checks the node is on the right chain (genesis and pins) before using it; an optional pinned node-key fingerprint keeps a home node reached over the internet from being impersonated; and the remote-node warning shows whenever the node is not on the same machine. The Privacy Auditor reviews it with the rest of R21. No Tor | Y: a pinned snapshot hash in the release binary, and the rule that refuses a snapshot whose background re-verify differs | planned (post-mainnet) | Claude | Grok + Protocol, Privacy Auditor (the light-wallet design, before any code), pins | | | | after R19; no date until Russell sets one (Russell 26 Oct) |
| R24 | Test chains refused as duplicates (found in R01b, 27 Oct): `test_vault_fs1_funding_v12` fails its before-hook with `append not_heavier` (11 tests cancelled), the same before R01b (0c0f6dc7). **Root cause:** 7ed95f25 (23 Oct, "Reject a lied block hash before it is stored") made `appendProven` take the trusted pow hash as the block id and refuse an id already in the book as `not_heavier` (node/src/store.js). The test's `mine()` passes the same `trustedPowHash: Buffer.alloc(32)` for every block, so its second block is a duplicate. Eight more node tests pass the same constant hash (test_admit_anchor_v12, test_admit_byte_v12, test_fs1_send_gate_v12, test_gate_evm, test_merkle_duplicate_v12, test_reserve_mint, test_typed_inflation_v12, test_work_prop_v12); run nh1 (p2p-b, feat 2f6e9962): all eight pass, since none mines a second block with that hash; only test_vault_fs1_funding_v12 fails. **Fix:** each test gives every block its own hash (as test_dart_withdraw_queue_v12's `nextPow()` does), real data, the store check unchanged; plus a guard that no node test mines two blocks with one trusted hash, and the runs that hid it named in the Review. **Done locally (27 Oct, branch claude/r24-test-block-hashes, 03af0680, unpushed):** helper node/tests/trusted_pow.js `freshPowHash()`; the funding test and test_fs1_send_gate_v12 use it; guard test_trusted_pow_unique_v12 (a real store refuses a reused hash; no node test passes a literal constant to an append) fails at feat (r24g) and passes after (r24f, guard 3/3, send gate 11/11). With its setup unblocked, the funding test shows older drift, 8/19: its non-π lock rows are refused `unsigned`, likely missing `lockAuth` since 325b50f5, and its π twin is refused `duplicate_tx` (5ad292a6) before `admit_link_tag`. It stays on tests/ci_pending.txt under PR 2 with those reasons recorded. test_genesis_pool_seal.js has the same not_heavier class (its PR 3 pending row) and is left until retire-credits lands, since that PR edits it. Not in R01b: neither store.js nor these tests are R01b files. The FS-1 mainnet unlock test that mined withdraw blocks at 17 after claim blocks was folded into R01b instead, since that file is an R01b file (Russell 27 Oct) | N: tests only; store.js and consensus unchanged | planned | Claude | Owner's lanes: Codebase Auditor (test quality, every test file in CI), Protocol Assailant (block validity) | | | | after R01b; before the R16 checklist (Russell 27 Oct) |
| R25 | Epoch rate row (R01c P1, option B; Russell 27 Oct): the block that opens each epoch carries a checked coinbase row `{epoch, bps, hashBonusNanos, rr and hb ballot results, leafCount}`, refused by verify when it differs from state (the R01b `freezeCommits` pattern), so the wallet reads each epoch's rate, hash bonus and enacted steps from chain data instead of the pool. Live vote counts stay hidden until a per-block or per-epoch chain row exists (no Dart re-tally); the mint bank and arrival stubs stay hidden until a chain row exists. Design: Desktop R01c-P1-design-note.md. Also in R25 (Russell 27 Oct): the painted-number sweep of crypto/reserve_vault.js (`publicVaultView`, `portalRewards`), crypto/pot_sched.js and crypto/levy.js. Tests: row equals state, forged and missing rows refused, reorg across an epoch open, the wallet shows the scanned rate and "syncing" before it, pool figures ignored, restart and restore keep the rows, the claim amount equals the mined reward; plus the rule-13 e2e | Y: a new coinbase row and verify rule; fingerprint and pins move | planned (design and tests only until R01b is signed) | Claude | Grok cross-review; Vault Security, Wallet Hardening, Protocol Assailant, Public Supply Audit, pins | | | | after R01b sign-off; no consensus edits before (Russell 27 Oct); batched with R05: one Grok review, one pin move (rule 15); before the 30 Nov freeze |
| R26 | Reserve fail-closed wallet fixes (painted sweep H1, H2; Russell 27 Oct): a Reserve lock with no chain epoch is refused with "waiting for header sync" instead of being signed with epoch 0 (wallet/lib/shear_ledger.dart:13028, shear_reserve.dart:1656, and `canJoin` at :1158 that allows a lock while the epoch is unknown); a tranche row without an epoch is dropped instead of counting as matured (shear_reserve.dart:522, 541). Tests for each; the node-side check ran first and **found no consensus issue** (27 Oct, run r26e on p2p-b, head ca5f80c2, test_lock_epoch_stale_v12 1/1): at epoch 1 a real store refuses every epoch-0 lock at the queue, at block verify and at append (stamped epoch 0: lock_unlock; epoch-0 leaf: commit_sum or stake_reward; the app's actual H1 lock, unstamped with an epoch-0 leaf: commit_sum or stake_reward), while the control lock is mined; so H1 is a wallet bug that loses the user's lock attempt, not a chain risk | N: wallet only, unless the node accepts a stale-epoch lock (then STOP: a consensus finding) | planned | Claude | Owner's lanes: Vault Security, Wallet Hardening | | | | straight after R01b (Russell 27 Oct) |
| R27 | Real-path money scenarios (painted sweep part 3, rule 13; Russell 27 Oct): one shared multi-process harness (real node, pool and miner processes on loopback, the real wallet library driven by a Dart program; R01b builds it) and eight scenarios, one per money path: Spendable and receive (0-conf Pending, confirmations, restart, restore); send/Flow (change as Spendable, refused-send copy, 504 or timeout gives "syncing"); lock/deposit; vote with its fee note; vault claim (R01b's); withdraw (matured, multi-portal, refused); restore and receipt spend; pool payouts on chain. Each fake-HTTP test on that path then stays as a labelled unit test or is deleted; the painted servers go once nothing needs them. 234 tests with fakes on money paths, 43 with a partial counterpart, none meeting rule 13 today (Desktop R16-item5-painted-sweep-report.md) | N: tests and harness | planned | Claude | Owner's lanes: Codebase Auditor, Wallet Hardening, FUX | | | | first, early November (Russell 27 Oct, rule 15): the harness gates every later merge ask; scenarios before the R16 cut |
| R28 | BluNotes: private share payees and payouts, plus pruning (Russell 27 Oct: privacy not negotiable; payees and amounts fully hidden in shares and coinbase payouts; lean, measured). Design: one-time key (R, P) per share, bound into 48 nonce bits with the job key so each RandomX hash credits one payee (fixes H1 with no RandomX or header change); exactly-once work IDs on the proven header with a one-block lookback (fixes H2-H4); a per-block draw of k=16 shares by weight from the block's PoW hash, paid by every node as implicit FS-1 notes (no payee rows, no range proofs, pool learns no address); share bytes in the block budget (H7); compact per-block record (about 1.2 KB, 94% smaller) committed in continuityRoot, with supply checkable from genesis. Retires the owed ledger and spill (closes R31, R32, R36 by removal; R30 moot; R33 folded; R35 reviewed). Renames the two DAG fingerprint labels and removes the unused share_dag parent field in the same pin move. Design note: Desktop PR130-review/R28-private-share-payees-design.md (27 Oct), measured on agent-box. **Russell 27 Oct (provisional, final sign-off by 3 Nov after the Grok team review on 29 Oct):** D1 accepted (payees and earnings hidden; per-winner amount public from PoW; Privacy Auditor to confirm); D2 yes (owed ledger and spill retired, shares scaled within the block; closes R31, R32, R36); D3 k=16 provisional (Mining Economics to say whether 32 is worth the bytes); D4 yes ("this wallet mines" switch, off by default, asks on restore); D5 yes (pruned draws rest on PoW burial; archive nodes keep everything); D6 yes (2 MiB share cap). **Hash bonus (Russell 22 Oct; floor per the PR 116 rulings, 23 Oct): not retired.** R28 retires the owed ledger and spill only. The hash bonus starts at 1 rho per hash unit and moves only by passed governance votes, 1 rho per vote; it has no ceiling, and its total grows with hashrate. Its floor is 0: a governance-set 0 switches the bonus off, and it stays 0 until a vote moves it. `FLOOR 1` is only the clamp for a malformed unit. D2's scaling within the block and D6's 2 MiB share cap bound share bytes and how a block splits its bonus between shares; neither is a per-block ceiling on the hash bonus. If either would bound the total bonus a block pays, that is a ceiling and needs Russell's ruling before R28's pin move | Y: share PoW rule, payout, record commitment; one pin move (testnet, mainnet, mainnetFP, Reserve.json) | coding (rule 16; Russell's GO 27 Oct; draft PR on claude/r28-blunotes; Grok reviews the code from Thu 29 Oct) | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant, Privacy, Public Supply Audit, Wallet UX; Grok cross-review (Y row) | | | | sign-off by 3 Nov to land before the 30 Nov freeze; fallback R28a (H1-H4 only) if not signed by 15 Nov (Russell 27 Oct) |
| R29 | Hash-note admitPub not bound to the miner (share research H5, **medium, suspected**): the credit row's admitBase and the hash vout's admitPub are never checked against the miner (crypto/hash_owed.js:381-426; node/src/chain.js:1931-1957), so an author could give a miner's hash note a junk admitPub, leaving it unfindable or unspendable (griefing). A reproducing test first. Source: Desktop PR130-review/hash-bonus-share-structure-research.md (27 Oct) | Y: a verify rule | planned (filed, not fixed; Russell 27 Oct) | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant | | | | before the 30 Nov freeze (rule 15; v12 is the final testnet): batched with R01a/R02 (9 Nov) if ready, else its own pin move before 30 Nov, date TBD (CoS); R01a's coinbase binding covers the same family |
| R30 | Share selection does not cap distinct payees (H6, **medium, suspected**): consensus allows 65,536 distinct noteCommits but the payee cap is 171 (block_budget.js:285, 323), and neither buildTemplate nor selectBlockShares caps distinct payees (chain.js:1499), so about 90+ cheap floor-share dests make the pool's block fail `payee_cap` (denial of service). Source: Desktop PR130-review/hash-bonus-share-structure-research.md (27 Oct) | N: pool selection | planned (filed, not fixed; Russell 27 Oct) | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant | | | | after R28 (R28 changes the payee model) |
| R31 | Pool owed rows outlive their share bodies across a restart (H8, **low**): window-owed.json survives a restart but pendingSpill does not (pool/src/pool.js:2199-2247), so windowOwedUnits stays inflated. Source: Desktop PR130-review/hash-bonus-share-structure-research.md (27 Oct) | N: pool | planned (filed, not fixed; Russell 27 Oct) | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant | | | | after R28 |
| R32 | Owed ledger grows without bound (H9, **low to medium**): `owedRest` is uncapped and owed rows never expire (crypto/hash_owed.js:1021), so sybil floor shares grow node state. Source: Desktop PR130-review/hash-bonus-share-structure-research.md (27 Oct) **Russell 27 Oct: fix before the freeze; an uncapped ledger is a supply risk.** | Y: an expiry or cap is a consensus rule | planned (filed, not fixed; Russell 27 Oct) | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant | | | | after R28; before the 30 Nov freeze (Russell 27 Oct) |
| R33 | Share frame `lz` and frame order not canonical in shareSlotRoot (H10, **low**, malleability without credit impact; share_batch.js:1204-1217, pack.js:254-278). Source: Desktop PR130-review/hash-bonus-share-structure-research.md (27 Oct) | Y: a canonical-form rule | planned (filed, not fixed; Russell 27 Oct) | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant | | | | before the 30 Nov freeze (rule 15): folded into R28 if R28 re-specifies the frame, else its own small Y row before 30 Nov, date TBD (CoS) |
| R34 | Hash note minted with no share (H11, **low**, a design question): an idle ledger plus an empty batch mints a 2^8 × unit finder-floor hash note (chain.js:2749-2769). Russell to rule whether it stays. Source: Desktop PR130-review/hash-bonus-share-structure-research.md (27 Oct) **Russell 27 Oct: no. An idle block with no shares must not mint the hash note (nothing to pay for); remove it and pin that with a test.** | Y if changed | planned (filed, not fixed; Russell 27 Oct) | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant | | | | ruling first; ruled 27 Oct: a Y row (consensus), before the 30 Nov freeze |
| R35 | Grinding on post-round issuedJobKeys headers (H12, **low**): an author can credit work on any header it lists from the parent's round family, including ones made after that round ended (share_batch.js:398-519). Source: Desktop PR130-review/hash-bonus-share-structure-research.md (27 Oct) | Y: an issued-header rule | planned (filed, not fixed; Russell 27 Oct) | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant | | | | before the 30 Nov freeze (rule 15): reviewed with R28 (tip-binding rule), and any fix lands with R28's pin move or its own before 30 Nov, date TBD (CoS) |
| R36 | Spill credits have no root of their own (H13, **low**): `hashSpillCredits` is bound only through hashOwedRoot (hash_owed.js:486-505); a producer that did not stamp it leaves pruned rebuilds with an empty list. Source: Desktop PR130-review/hash-bonus-share-structure-research.md (27 Oct) | Y: a commitment | planned (filed, not fixed; Russell 27 Oct) | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant | | | | fold into R28 (R28 touches spill and pruning) |
| R37 | Miner-side coinbase template check (from R01a, Russell 27 Oct: its own row): ShearK-Miner checks its own payout in each stratum job (P == B_m + δ·G against its registered mining base) and stops with a clear error on a mismatch, as defence in depth beside R01a's consensus rule | N: miner only | planned | Claude | Owner's lanes: Pool Share Auditor, FUX | | | | after R01a's design is signed |
| R38 | Site tests are not in CI, and one is stale (found 27 Oct, PR #143): no site/tests/*.js file is in any CI list (tests/ci_shard.js or ci_timings.json), so site/tests/test_mempool.js "paints kind and (pending) for mempool lock/vote" fails unseen on feat 2f6e9962: it expects the copy "Reserve lock and vote appear from mempool", which mempool/index.html no longer has. Fix: wire site/tests into CI, and update the test or the page copy to whichever is right, by root cause | N: tests and CI | planned | Claude | Owner's lanes: Codebase Auditor, Website Analyst | | | | with R23, before the R16 cut |
| R39 | Share verify cost (found measuring R28; Russell 27 Oct: re-measure idle, then file with the cost per block and a fix plan before the freeze): the node verifies every share with the RandomX light **interpreter** (crypto/native/shearhash.c:56 forces it). Measured idle on agent-box (AMD EPYC-Milan, one thread, 28 Oct 00:00 UK, before agent-box became the explorer node on 29 Oct; any re-measure there needs a stated window that leaves the explorer unaffected, TBD (CoS)): interpreter 80 ms per share, so 17.5 s of CPU for a 219-share block (v10 mean) and 165 s for 2,060 (v10 max); JIT light 22 ms (4.9 s / 46 s); JIT with the 2 GiB dataset 2.1 ms (0.46 s / 4.3 s). Today every node spends tens of seconds to minutes of CPU per block on shares, against a 90 s block. **Fix plan:** (1) verify shares on the JIT light backend where the platform allows W^X JIT, with the interpreter as the fallback (same digest; a test pins JIT == interpreter on real headers); (2) verify a block's shares in parallel across cores (shares are independent; hash_offloop already has workers); (3) an opt-in full-dataset mode for nodes with 2+ GiB to spare; (4) re-measure per block at the v10 mean and max, and set the R28 share cap (D6) and share floor so a block's share verify stays well under one block interval on the smallest supported node. The cap bounds share bytes and verify cost only; it is not a ceiling on the hash bonus, which has none (see R28). Source: Desktop PR130-review/R28-private-share-payees-design.md (F1) | N: same digest, backend and scheduling only (no consensus change) | planned (filed 28 Oct) | Claude | Owner's lanes: Codebase Auditor, Performance | | | | before the 30 Nov freeze (Russell 27 Oct) |
| R40 | The miner and node "SHA-512" is not standard SHA-512 (found 28 Oct by R28's C/JS key-vector test): sheark-miner/src/sha512.c gives 2a0fbfd8… for "abc" where SHA-512 gives ddaf35a1…. It derives the RandomX key (`shear_key`, sheark-miner/src/shear_hash.c:149), and crypto/native/shearhash.node builds the same file, so today's chain agrees with itself, but any implementation that uses a real SHA-512 (a second client, a phone build, a refactor) computes different RandomX keys: a consensus split. R28 no longer uses it (libsodium SHA-512; 32 vectors match). **Decision for Russell:** fix it (standard SHA-512; the RandomX key and every pin move, best inside R28's single pin move, before genesis) or keep it and document it as a named non-standard hash with test vectors. **Root cause (28 Oct):** one round constant is mistyped: `K[53]` (zero-based; first written as K[49]) is `0x4ed8aa4ae256485b`, FIPS 180-4 has `0x4ed8aa4ae3418acb`; every other constant, the IVs and the rotations match, and with that one constant corrected the file matches SHA-512 ("abc" and a 54-byte input, checked on agent-box). The fix is one line plus test vectors; its consensus effect is the RandomX key | Y if fixed (the RandomX key changes) | **Ruled 28 Oct (ruling 1): fix it inside R28's single pin move, applying only from the v12/mainnet genesis (the running testnet v11 code, 250bded, is not rebuilt or redeployed).** Fixed on R28 in 68510296 with FIPS 180-4 vectors and C-vs-JS `shear_key` vectors (test_sha512_fips_v12, green on agent-box); selftest K 55111f02… → 5a09106f…, digest 98818c31… → e9e9dee1…; the label `KEY_SHA512=fips180-4` is in the pin move | Claude | Owner's lanes: Codebase Auditor, Protocol Assailant | | | | before the 30 Nov freeze if fixed (with R28's pin move) |
| R41 | ShearK-Miner full optimisation (Russell 28 Oct): the fastest, most stable miner for ShearHash-v3 on every shipped platform. **Hard rules:** byte-identical output (every hash, digest, one-time key and nonce binding matches the reference; golden vectors, including the R40 FIPS 180-4 SHA-512 and the R28 C-vs-JS key vectors, run on every build); no algorithm, pin or share-format change (if a speed-up needs one, stop and propose it); privacy unchanged (the --blu flow intact, no telemetry or phone-home, nothing new sent to the pool). **Do:** (1) baseline on agent-box (the explorer node since 29 Oct: run only in a stated window that leaves the explorer unaffected, TBD (CoS)), pool, p2p-a, p2p-b and the Windows pack: H/s per thread, core and watt where possible, plus share-accept rate and latency, with CPU model, flags and OS; (2) profile the hot path (RandomX VM, dataset init, SHA-512 key, nonce binding, stratum I/O), then optimise in order of measured gain: JIT on every arch with an interpreter fallback; huge/large pages with a clean fallback and message; NUMA- and L3-aware placement with auto thread count; runtime CPU-feature dispatch (AES-NI, AVX2, AVX-512, NEON/crypto); hardware AES; lock-free job switching and fast stale drop; compiler flags, LTO and PGO per platform; (3) tests: the full miner suite and vectors on every build; a 12 h+ soak on the active servers (pool, p2p-a or p2p-b; the old soak hosts are retired; which host and window: TBD (CoS)) (H/s stability, memory, accept/reject/stale, no crashes, clean restart); pool and solo end to end with --blu on regtest, including need_key, need_blu and exit 2; a before/after table per host; (4) keep only changes with a measured gain and no failed vector, each reported with its gain, risk and proof; (5) the Windows pack ships the libsodium DLL (R28 269a0893); Apple is a Desktop HANDOFF only (no Mac soak) | N: no consensus, pin or share-format change by rule | coding (rule 16; draft PR on claude/miner-opt, based on R28) | Claude | Owner's lanes: Codebase Auditor, Performance, Privacy (nothing new to the pool) | | | | no merge, release or site change without GO |

**Float (26 Oct, first estimate; superseded by the current float in the agent split note below).** With R09 and R10 after mainnet, the rows from R11 on can run about 6 days (5 to 8) sooner than their targets above. That puts the mainnet release ready around 8–9 Dec on target and 14–18 Dec if every row runs to the late end of its window, against the fixed genesis of 21 Dec 14:00 UK. Without the move it was 14–15 Dec on target, and a late run missed 21 Dec by 1–2 days. The target dates above are unchanged, and the float is not a new date. Plan against it, report any slip that uses it, and an earlier genesis needs Russell's consensus sign-off (rule 8).

**Agent split (Russell 26 Oct, 19:05 GMT).** R03, R04, R11 and R13 are Grok's, and R14a is Grok's under rule 14 (Russell 27 Oct). Each falls back to Claude at the slot in its Target cell if Grok's credits run short, so the split can move with credits; it is not fixed. The heaviest rows stay with Claude: R01–R02, R05, R06, R07, R08, R12, R14 and R15–R19. Grok cross-reviews every `Y` row (rule 7), including R07. A Grok row starts only after the Claude row whose files it shares has merged (rule 4). **Current float (26 Oct, recalculated):** the mainnet release is ready around **8–11 Dec on target** and **14–18 Dec at the late end**, against the fixed genesis of 21 Dec 14:00 UK. That is 10–13 days of float on target and 3–7 days at the late end. This counts R01b (1–2 days) and R01a (2–3 days with the design GO) on Claude's path, which the earlier figure missed. It also counts R04 landing on Grok's own VPS by about 2 Nov, so R05 most likely does not wait for it. **The main risk is R15**, the shear-dev bug hunt: if it runs long it eats most of the float, so watch it closely once shear-dev starts. These are estimates. The target dates above are unchanged.

R01a and R14a were added by Russell on 26 Oct. R01a is the coinbase
spend-key binding found by the PR 130 lanes: its own PR straight after R01,
design first. R14a is the public supply audit tool with its own review lane
(Public Supply Audit on the Claude side, Supply Auditor on the Grok side), idle until Thu 29
Oct after the credit reset. Its owner is Grok (rule 14, Russell 27 Oct);
any change made at the 29 Oct 15:00 alignment is TBD (CoS).

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

## R18a and R18b detail: mainnet hosts and OS split

Each wipe or reinstall needs Russell's GO, one host at a time.

| Host | IP | OS |
|------|----|----|
| pool | 77.42.91.84 | Ubuntu Server LTS (current release) |
| p2p-a | 157.180.70.110 | Debian stable |
| p2p-b | 2.28.8.89 | Fedora Server (current release) |
| agent-box (explorer node, Russell 29 Oct, 10:46) | TBD (CoS) | TBD (CoS); whether R18a and R18b cover it is TBD (CoS) |

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
