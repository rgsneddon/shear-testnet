# Vault Y rows: the leaf-vote root, the live-leaf cap, and the old tranche path

Design note (rule 16), 28 Oct 2026. Owner: Claude. Russell's GO: 28 Oct.
Base: `feat/shear-testnet-v12` at `b3efdc26`. Branch: `claude/vault-y-rows`.
Both rows are consensus (`Y`) and need Grok's cross-review (rule 7).

Russell's intent: a user may make **unlimited** separate locks of exactly
one π, at any time, several per epoch. Each lock stakes and votes on its own.

Line numbers below are at `b3efdc26` unless a line says otherwise.

---

## Row (a): the leaf-vote root is keyed by the wrong unit

### The bug (confirmed from the code)

`applyLeafVote` (crypto/reserve_vault.js:4499) reads one integer,
`epoch = tx.earnEpoch ?? tx.rootEpoch` (:4509), and uses it in two places:

- `censusOf(state, epoch)` (:4512). The census is keyed by the **epoch**
  index: `ensureEpochCensus` (:2514) writes `state.currentEpoch`, the
  chain-time epoch.
- `state.epochStartRoots[String(epoch)]` (:4519). That map is keyed by the
  **period** index. `snapshotPeriodRoot` (:2532-2547) writes
  `floor(h / vaultPeriodBlocks)` at the end of the first block of each
  period. On testnet a period is 240 blocks and an epoch is 16 periods
  (3,840 blocks).

So an epoch-e vote proves against the root frozen at block 240·e. It should
prove against the root frozen when epoch e opened (about block 3,840·e on
the 90 s schedule). From epoch 1 on, that has three effects:

1. **A lock made after block 240·e cannot vote in epoch e.** That covers
   every lock made in epoch 1 or later, so they cannot vote in epoch 2.
2. **A leaf withdrawn between block 240·e and epoch e's start can still
   vote in epoch e.** Its leaf is still in the period-e root.
3. **Epoch 0 cannot vote at all.** The census of epoch 0 is taken at the
   first lock (`ensureEpochCensus` at :4843, right after the append). The
   key `"0"` was already frozen as the empty root, at block 0 by
   `snapshotPeriodRoot`, or before the lock by `applyEpochOpen`. So no
   leaf can prove membership, and the vote is refused as `unsigned`.

There is a second writer to the same map. `applyEpochOpen`
(:2422-2427) writes `epochStartRoots[epochIndex]`, the live root when the
chain-time epoch opens. Each key is set by whichever writer comes first.
On the 90 s schedule the period writer always wins for keys of 1 and up.
But on any stretch where the chain runs slow enough that epoch e opens
before block 240·e, the epoch writer takes the slot, and the **claim root**
of period e becomes the epoch-open root. That is the same root cause: one
map holding two units.

The EVM has the same bug. `castVote` (contracts/Reserve.sol:1147) and
`_voteCode` (:1315) read `epochStartRootOf[epoch]`, the mapping the claim
path fills per period (`commitEpochStartRoot` :1113, `_vaultCode` :1369).
The coinbase carries the roots and the census (node/src/store.js:6651-6682,
node/src/chain.js:3369-3392). For a leaf vote it sends
`epochStartRoots[earnEpoch]`, which is the period root.

Things that do **not** need changing:

- `verifyLeafVote` (crypto/vault_reward_fs1.js:1570-1612) takes the root
  and the epoch as inputs. It binds the epoch into the proof (byte 1) and
  into the vote tag. It has no notion of a period.
- The quorum, `ballotDirection` (crypto/leaf_vote.js), is 20% of the
  census `leafCount`. That count is already taken at epoch open.
- The claim path (`consensusClaim` :1536-1558, `vaultClaimRejected`
  :1570-1600) treats `earnEpoch` as a period and reads `epochStartRoots`
  by period. That stays as it is.
- The Dart builder (wallet/lib/shear_reserve.dart:1877-1997) already uses
  `reserve.currentEpoch`, an epoch index, for the census, the proof and the
  wire. The wire does not change.

### The fix

- **Vote root = census root.** `ensureEpochCensus` now freezes the vote
  root at the same moment, and from the same live set, as the leaf count.
  `commitCensus` stores `{known, leafCount, openHeight, root}` in the
  census row, keyed by epoch. `censusRoot(state, e)` reads it back. If a
  withdraw earlier in the same block left the tree dirty, the root is
  rebuilt on a scratch handle (`liveVaultRootHex`). That keeps the root
  consistent with the count, and it does not change when the period
  snapshot sees the root.
- **`applyLeafVote` reads `censusRoot`**, never `epochStartRoots`.
  `epochStartRoots` is now the period-keyed claim root only.
  `applyEpochOpen` no longer writes to it, which closes the collision.
- **Wire: no new field.** A leaf vote's `earnEpoch` is the epoch the vote
  proof binds (byte 1). A mismatch is already refused as `stake_reward`
  by `verifyLeafVote`. So the integer is unambiguous on the vote; the
  ambiguity was in the state key. A new field would also change the signed
  body key set (crypto/spend.js `BODY_KEYS`), the compact wire
  (crypto/chronoflux.js `COMPACT_TX_KEYS`), the pool and the Dart builder,
  for no gain. **The Dart wallet is unchanged.**
- **Coinbase and EVM.** The census row on the coinbase now carries the
  root: `epochCensusCommit: [{epoch, leafCount, openHeight, root}]`
  (store.js, chain.js, chronoflux.js `compactEpochCensus`). A leaf vote no
  longer adds a period root to `epochStartCommits`. In Reserve.sol,
  `commitEpochCensus(epoch, leafCount, openHeight, root)` stores
  `voteRootOf[epoch]`; a zero root, or a second commit with a different
  root, reverts `BadAmount`. `castVote` and `_voteCode` read `voteRootOf`.
  `reserve_evm.js` binds the root in the coinbase cross-check (`vaultBind`)
  and in the call.
- **Fingerprint.** A new line, `VOTE_ROOT=census-epoch`
  (crypto/asert.js), so a node on the old rule cannot pass as one on the
  new rule.

### Migration

None. v12 is not cut, so the rule is in effect from height 0 of the v12
chain. A pre-cut soak datadir has census rows with no root. Every vote
against such a row is refused as `not_voter`. That datadir is reset at the
cut anyway (R16).

### Tests

- `node/tests/test_vault_vote_root_epochs_v12.js` is the real chain:
  regtest at bits 4, every header mined under ShearHash, real FS-1 π locks,
  votes, a claim and a withdraw, across three epochs. It covers:
  - epoch 0: the first lock votes;
  - a claim of period 1 against the period-1 root;
  - L2 locks in epoch 1, after block 480 froze period 2, and L1 withdraws;
  - in epoch 2, L2 votes, and L1 (withdrawn before epoch 2 began) is
    refused, even with a proof against the period-2 root.

  **It cannot pass on the base yet.** On regtest a lock's block fails
  `supply` at h=101, on `b3efdc26` before this change too. That is the
  known PR 2 (R05) gap: supply.js `lockNotePrincipal` and
  `vaultAfterBlock` default to testnet magic. It has a `PR2` row in
  `tests/ci_pending.txt`.

  There is one more thing for PR 2. The regtest JS vault proves votes and
  claims under `shear-regtest`, but the Reserve's `VAULT_ZK` call uses
  `_magicBook()`, which is `shear-testnet-v12` on every non-mainnet book.
  PR 2's ruling (B) (regtest uses the testnet Reserve identity in JS)
  closes that gap. Until it lands, no regtest vault vote or claim can pass
  both JS and the EVM.
- The before/after evidence comes from a twin of that file. It is the same
  scenario on a testnet store with `trustedPowHash`, the pattern
  `test_vault_sync_restart_v12.js` uses. It is a scratch file and not
  committed. On `b3efdc26` it gives 1 pass and 5 fails:
  - the epoch-0 vote is refused as `unsigned`;
  - L2's epoch-2 vote is refused as `unsigned`;
  - L1's withdrawn-leaf vote is **accepted**;
  - the claim passes.

  With this change it gives 6 of 6. The logs are in the PR Review.
- `crypto/leaf_vote.test.js`, EVM leg. A period-1 claim root alone does not
  open the epoch-1 ballot (`NotVoter`). A census commit with no root, or
  with a second root, is refused. The JS/EVM parity runs pass the census
  root.
- `crypto/chronoflux.test.js`: the compact census row keeps its root, and
  a row with no root is dropped.
- These tests asserted the old key and now read `censusRoot`:
  `test_vault_sync_restart_v12.js`, `test_p2p.js` and
  `test_admit_v3_fund_v12.js`. Their scenarios vote in epoch 1 with one
  epoch-0 lock, so the two roots are equal there and the old assertion
  passed by accident.

### Pins

All five move: testnet, mainnet and mainnetFP through the new fingerprint
line, and Reserve.json and the deployed bytecode through the contract. The
before and after table is in
`Desktop\PR130-review\vault-y-rows-pins.txt`. The pin-moving commit is
**local only** until Russell signs the exact diff
(`Desktop\PR130-review\vault-y-rows-exact.diff`).

---

## Row (b): `MAX_LIVE_VAULT_LEAVES = 4096`

### What the cap does today

`MAX_LIVE_VAULT_LEAVES = 4096` is at crypto/asert.js:296 and in the
fingerprint as `VAULT_LIVE_CAP` (:582). `appendVaultLockNote`
(reserve_vault.js:1128) returns null at the cap, and the block's lock is
then refused as `stake_reward` (:4836-4840). 4,096 × π is about 12,868 SHE
chain-wide. Any one holder can fill it, and every later lock by anyone is
refused until a leaf withdraws. There was no test of the cap.
`crypto/vault_live_cap.test.js` now pins it: 4,096 real leaves from one
holder, and a second holder's real leaf refused.

### Measured

Host: **agent-box** (`agent-test`, 5.78.209.86), AMD EPYC-Milan, 8 vCPU.
It is shared: an R41 miner soak and other CI ran beside these, and every
run was at nice 19. Runs were pinned to 3 cores (`taskset -c 5-7`), plus a
2-core run (`taskset -c 0,1`) to stand in for the p2p-a and p2p-b class.

- Tool: `scripts/vault_scale_bench.mjs`. It makes real ristretto notes and
  one real π leaf, then times the shipped native FS-1 calls and the
  shipped JS vault functions (`cloneVault`, `commitVaultLockRoot`).
- Dart: the wallet's own FFI path (`Fs1Native.treeAppend`,
  `proveUnlinked`), on the same notes, through a scratch flutter test.

| Measure | 4,096 | 65,536 | 1,048,576 (extrapolated, see below) | 16,777,216 (extrapolated) |
|---|---|---|---|---|
| FS-1 vault tree depth (fixed) | 7 layers | 7 | 7 | 7 (capacity 12,160,513,152) |
| Census row size | 1 row/epoch (count + open height + 32 B root) | same | same | same |
| Tree build / `rebuildVaultLockRoot`, 3 cores | 2.79 s / 2.72 s | 42.8 s / 49.2 s (0.65–0.75 ms/leaf) | ≈ 11–13 min | ≈ 3.0–3.4 h |
| Tree build, 2 cores (p2p-a/b class stand-in) | 4.13 s | 63.3 s (0.97 ms/leaf) | ≈ 17 min | ≈ 4.5 h |
| Tree build, Dart wallet FFI, 2 cores | 3.91 s | 57.2 s | ≈ 15 min | ≈ 4.1 h |
| Append 16 leaves (one lock) on a live handle | 14 ms | 14 ms | ≈ 14 ms (O(depth)) | ≈ 14 ms |
| Unlinked FS-1 prove (vote/claim core), JS 3c / Dart 2c | 0.98 s / 1.18 s | 1.03 s / 1.23 s | ≈ 1 s | ≈ 1 s (+ path read) |
| Unlinked verify (vote/claim), JS | 34 ms (2c: 44 ms) | 35 ms (2c: 37 ms) | same | same |
| Proof bytes: unlinked (vote/claim core) / FS-1 spend (lock input) | 6,660 / 6,564 | 6,660 / 6,564 | same | same |
| FS-1 spend (lock) prove / verify, 3c | 1.13 s / 40 ms | 1.03 s / 36 ms | same | same |
| Native tree RSS | 4 MB | 32 MB (~500 B/leaf) | ≈ 510 MB | ≈ 8 GB |
| JS vault heap (per-leaf maps) | 2 MB | 27 MB (~430 B/leaf) | ≈ 430 MB | ≈ 7 GB |
| Vault JSON (snapshot / `cloneVault` payload) | 2.9 MB | 45.8 MB (~730 B/leaf) | ≈ 730 MB: **over V8's max string, `JSON.stringify` throws** (observed: `RangeError: Invalid string length` in the first 1M run) | impossible |
| `cloneVault` (every trial) | 24 ms | 462 ms (~7 µs/leaf) | **throws** (same limit; breaks at ≈ 0.7M leaves) | throws |
| Live-list filter per appended leaf | 0.33 ms | 8.8 ms | ≈ 140 ms (×512 leaves/block ≈ 72 s) | ≈ 2.3 s |
| Worst-case block (2 rebuilds: verify clone + live withdraw), 3c | ≈ 5.5 s | ≈ 92 s | ≈ 23 min (and the clone throws) | n/a |
| Cold start / IBD tree load | 1 build | 1 build | 1 build + replay | 1 build + replay |
| Wallet download for a full-set proof (64 B/leaf) | 256 KiB | 4 MiB | 64 MiB | 1 GiB |

Method for 1M and 16M: every N-dependent cost is linear between 4k and 64k
(per-leaf figures in the table), so 1M and 16M are the 64k per-leaf cost
times N. A 1M native-only run was still in progress on agent-box when this
note was written (`/root/claude-ci/results/vault-y/bench1m.jsonl`); its
first attempt measured the JSON limit above before it stopped. 16M was not
run: the JS state alone would be about 7 GB on a shared box.

The things that do **not** grow with N:

- FS-1 is a fixed-depth FCMP++ tree (`DEPTH = 7`,
  vendor/.../shear-fs1/src/membership.rs:55). Its capacity is
  38⁴·18³ = 12,160,513,152 leaves.
- So the depth, the proof size, the vote, claim and lock proof bytes, and
  verify time are the same at every N in the table.
- The prover is about 1 s at every N, because only its path read is
  linear, and that part is small.

### What grows with N, per block or per tx, today

Each item gives the code location and what it costs at N:

1. **Withdraw → full tree rebuild.** `retireVaultLeaf` marks the leaf
   dirty, and `flushVaultLockRoot` → `rebuildVaultLockRoot`
   (:1081-1112, :4946) rebuilds the whole FS-1 tree. The root is over the
   compacted live list, so one removal moves every later leaf. Cost:
   `treeBuild(N)`.
2. **Trial on a clone → full tree rebuild.** `cloneVault` (:1882) does a
   JSON round trip of the whole vault, and the clone has no native handle.
   Its first `appendVaultLockNote` rebuilds the tree (:1130-1137). That
   happens:
   - in block verify (node/src/chain.js:3265), once per block that holds
     a lock;
   - in mempool admission (crypto/mempool.js:415), once per lock;
   - in the template trial (node/src/store.js:4154).

   Cost: `clone(N) + treeBuild(N)` each time.
3. **A failed in-place trial → full tree rebuild.** `restoreTrial`
   (:2386). `snapTrial` (:2262) also copies five per-leaf maps on every
   in-place trial.
4. **A live-list filter per appended leaf.** `appendVaultLockNote`
   (:1127-1128) runs `notes.filter` over every note ever, retired ones
   included. A block may append up to 512 leaves (32 reserve txs × 16).
5. **Wallet.** To prove a vote or a claim, the wallet needs the whole live
   set in chain order (64 B per leaf) and builds the tree itself.
   - Today the JS and Dart provers (`proveLeafVote`,
     `proveVaultLockReward`) build the tree from the caller's own locks
     only. They match the chain root only when one wallet holds every
     leaf.
   - That is a separate, pre-existing gap. It is listed in the Review,
     not fixed here.

Worst-case node CPU per block at N is about 2 × `treeBuild(N)`. That is
one rebuild in verify on the clone and one in the live apply, for a block
with a withdraw and a lock. Each lock admitted to the mempool adds one
more `treeBuild(N)`.

- At **today's cap**, that is 2 × 2.8 s ≈ 5.6 s per block on this box, and
  2.8 s per lock admitted.
- At 64k it is about 86 s per block, nearly a whole 90 s block.

So the cap is what protects nodes today, and 4,096 is already close to the
limit of the current design. The claim budget comment at asert.js:291 is
not the binding reason.

### Other things that assume a bound

- **Not leaf bounds:**
  - `RESERVE_ACTION_CAP = 4096` (reserve_vault.js:106) bounds reserve
    actions in the mempool and the template, not leaves.
  - These are verify-result caches, not leaf bounds: `LEAF_CACHE_MAX`
    (fs1_leaf.js:89), `VERIFY_CACHE_MAX` (fs1_spend.js:350),
    `PRINCIPAL_OPEN_MAX` (:1483), `RETIRE_VERIFY_MAX`
    (vault_reward_fs1.js:607), `VALUE_OPEN_MAX` and `RANGE_OPEN_MAX`
    (note.js).
- **Census:** the leaf count is packed into a uint64 in Reserve.sol
  (`commitEpochCensus`), so there is no practical bound.
- **Votes per epoch.** A leaf vote is a reserve action (`txIsReserveAction`
  :4165), so it counts against `MAX_BLOCK_RESERVE_TXS = 32`
  (block_budget.js:40). `MAX_BLOCK_LEAF_VOTES = 64` (leaf_vote.js:26) never
  binds. The vote window is `voteCloseDay` × 960 blocks: 2,880 on testnet,
  288,960 on mainnet. The 20% quorum is therefore unreachable above:
  - testnet: N > 5 × 32 × 2,880 = **460,800 leaves**;
  - mainnet: N > **46.2M leaves**.
- **Claims per epoch.** `MAX_BLOCK_VAULT_CLAIMS = 455` (asert.js:309). Each
  leaf claims once per period, 16 times per epoch. Every leaf can claim
  every period only up to:
  - testnet: N ≤ 455 × 3,840 / 16 = **109,200**;
  - mainnet: N ≤ 455 × 384,000 / 16 = **10.9M**.

  Above that, claims compete on fee and the unclaimed ones expire after
  the window. That is a UX limit, not a node limit.
- **Growth.** A block appends at most 32 × `MAX_LOCK_LEAVES` 16 = 512
  leaves.
- **Wallet scans.** There is no fixed array. The wallet downloads 64 B per
  leaf and builds the tree locally at the per-leaf cost in the table. A
  phone is slower.

### Proposal

Removing the stock cap is right: any global cap lets one holder exclude
everyone, and locking is yield-bearing, so filling the cap is not even
costly. But the cap can only go once every N-dependent per-block cost is
gone. Otherwise the next bound that protects nodes is "how long a 90 s
block takes to verify", and that is reached at a few thousand leaves. So:

**Stage 1 (this branch): keep `MAX_LIVE_VAULT_LEAVES = 4096`. No pin moves
for row (b).**

- Pin today's behaviour with `crypto/vault_live_cap.test.js`:
  - the boundary: 4,096 appends from one holder, and the 4,097th (another
    holder's) refused with the root unchanged;
  - an incremental root that equals a full rebuild;
  - a real leaf vote proved at depth over all 4,096 leaves and verified
    against the vault root, and refused against a root without the leaf.
- That gives Stage 2 a test it must flip on purpose.

**Stage 2 (proposed new Y row, needs Russell's GO, Grok's cross-review and
its own pin move): remove the stock cap.** Its parts, each removing a
measured O(N) term:

| Part | Change | Removes |
|---|---|---|
| S2a | Positional vault tree: a withdraw sets its leaf's slot to the FS-1 empty leaf in place (`ChainTree` is linear, T-3, so this is the same delta as `truncate` for one slot, cost O(depth)). The root is over every slot in lock order, retired slots empty. New native call `shear_fs1_tree_set(handle, index, note \| empty)`, with napi, JS and Dart bindings. Consensus: the root definition changes when any leaf is retired | item 1 (rebuild per withdraw) |
| S2b | Trials do not rebuild: `cloneVault` carries a native tree copy (`shear_fs1_tree_clone`, a memcpy), and `restoreTrial` undoes by journal (truncate the appends, un-set the retires) | items 2–3 (rebuild per trial) |
| S2c | Per-leaf state out of the cloned object: an append-only leaf store with a journal, so `cloneVault` and `snapTrial` copy O(changes), not O(N) | item 2 and 3 copies (`clone(N)`, measured) |
| S2d | Live count kept, not filtered | item 4 |
| S2e | Provers take the full chain-ordered set with retired slots, from public `/sync` data, and the wallet keeps its tree on disk and appends per block (≤ 512 leaves ≈ the table's append cost) instead of rebuilding per proof | item 5 |
| S2f | Governance at scale: count leaf votes against `MAX_BLOCK_LEAF_VOTES` and not the 32 reserve-tx cap, so the quorum stays reachable past 460,800 testnet leaves | vote ceiling |

**The bounds that then protect nodes, with their exact constants:**

- per block: `MAX_BLOCK_RESERVE_TXS = 32` × `MAX_LOCK_LEAVES = 16` = 512
  new leaves, `MAX_BLOCK_RETIRE_DLEQS = 64`, `MAX_BLOCK_VAULT_CLAIMS = 455`
  and `MAX_BLOCK_VERIFY_WEIGHT = 36,000`, all existing;
- the tree: FS-1 capacity 12,160,513,152 leaves (fixed depth 7), a hard
  refusal by the native tree (`TreeSize`);
- per leaf: π locked, and the lock's levy.

**The trade-offs that stay linear in N, from the table:**

- node RAM and disk: tree RSS + JS heap + snapshot bytes per leaf;
- cold start and IBD: one `treeBuild(N)` on load, or the replay of every
  append at the append cost;
- the wallet's first sync: 64 B per leaf, plus one build.

At 1M leaves those are the figures in the 1M column (S2c also removes the
JSON limit), paid once, not per block.

Stage 2 is not started here. It touches the vendored FS-1 crate, the
native library builds for every platform, the vault root definition, the
JS trial model and both provers, and it needs its own design GO first.

---

## Item 4 (read-only): the old tranche/portal reward path is dead

**Verdict: DEAD for compact FS-1 locks, and no double pay is possible.** It
still runs every block, but it always computes zero rows, the empty root
and zero interest. Two blockers, and either one alone is enough:

**(A) Every tranche has amount 0.**

- The only place JS creates a tranche is `noteCredit`
  (reserve_vault.js:2656-2670). It pushes
  `{commit, epoch, remainMs, fullFrom, partialPaid, qualifies}` and no
  `amount`. `asBig(undefined)` is 0n (:177-189), so `partialInterest`
  (:2673-2681) and `epochInterestBig` (:204-210) are 0.
- The legacy synthetic credit in `balanceCredits` (:3200-3216) uses
  `staked + idle`. No block path credits either one: they are clamped on
  restore (:1891-1892) and decremented in withdraw (:5575-5582).
  `trancheDue` (:3139-3160) returns 0 on it anyway (`remainMs 0`,
  `partialPaid true`).
- The contract does the same. Its only tranche push is
  `Tranche({amount: 0, ...})` (Reserve.sol:693-694). `p.active` and
  `p.idle` are only decremented (:1569-1573).
- Existing tests already assert `tranches[0].amount === undefined`:
  reserve_autocredit.test.js:301 and :824,
  reserve_oracle_activation.test.js:1986, reserve_oracle_security.test.js:166
  and reserve_roll.test.js:139.

**(B) No portal can carry a payout or dest address.**

- `rewardDest` (:362-366) needs `portal.payout` or `portal.dest` to pass
  `isDestAddress` (an `ssa1` address; crypto/address.js:160-165).
- On a lock, `reserveAction` takes `payout = tx.from || vin[0].address`
  and `dest = tx.to || out.address` (:3971-3986).
- `compactLockLeakRejected` (:4404-4416) refuses any lock with `to`,
  `from`, `payer` or `payoutPortalId`, or with `ssa1`, `she1` or `shear1`
  anywhere in it (`valueHasAddrLeak` :4383-4397). It runs:
  - in block validation (node/src/chain.js:2462, `earlyRowsRejected`
    :2447);
  - in the store (node/src/store.js:4209);
  - in the mempool (crypto/mempool.js:205);
  - in arrival_fields.js:225.
- `applyReserveBlock` also refuses `payoutPortalId` on a lock (:4767-4771),
  and any lock without a `vaultLockNote` (:4730-4734).
- So `deposit` (:2860-2918) never sets `p.payout`, `p.payoutPortalId` or
  `p.dest` (:2878-2885), and `stakeRewardsDue` skips every row at :421
  (`!dest`).

**Who still reaches it:**

- `stakeRewardsDue` (:385-436) is called only by `rewardCommitment`
  (:717). That feeds:
  - `stakeRewardRejected` (:822; chain.js:3261, `require: true`);
  - `coinbaseRewardRoot` (:873; store.js:6652, chain.js:3423);
  - `applyStakeRewards` (:886; applyReserveBlock :4638; supply.js:819 via
    `stakeRewardSupply` :5796).
- With zero rows the root is the empty root:
  - a `stake-reward` coinbase output is refused (:819);
  - any other non-empty root is refused (:823-826);
  - the EVM's `commitRewards` (Reserve.sol:1079-1096) does not store the
    empty marker;
  - reserve_evm.js:1278 refuses a non-empty root when JS expected none.
- Claims: a JS `reward-claim` must be FS-1 (`vaultClaimRejected`
  :1630-1637). A legacy merkle claim reverts `ClaimUnavailable` in the
  contract (Reserve.sol:1395, which needs proof byte 0xab).
- Withdraw pays principal plus the arrival stub, with `interest = 0n`
  (:5532), and the contract's `_withdraw` has `reward = 0` (:1562). The
  only reward mint is the per-leaf FS-1 claim, once per nullifier
  (:1639-1661, :4890-4914).

**Retirement proposal (Russell decides; not in the exact diff as code):**

Remove these from reserve_vault.js:

- `rewardDest` (:362-366), `rewardEpochArchived` (:373-383),
  `stakeRewardsDue` (:385-436), `rewardCommitment` (:716-733),
  `rewardClaimProof` (:737-746), `planStakeRewards` (:765-782),
  `withdrawPortalIds` (:785-793);
- `rewardAlreadyMinted`, `releaseMaturedPrincipal` and
  `ensureRewardMaps` (:845-866), and the archive half of
  `applyStakeRewards` (:903-943);
- `rewardReserved` (:1795-1802) and `hiddenRewardDue` (:1704-1716), with
  `p.hiddenRewardOpen` (:5541);
- `earnsStakeReward`, `stakeRemain`, `preCutoffStake`, `qualifyingStake`,
  `epochQualifies` and `stakeQualified` (:3088-3136); `trancheDue` and
  `dueRewardEpochs` (:3139-3191); `settlePortal` (:3307-3332);
  `withdrawPaysInterest` and `portalEpochInterest` (:3337-3355);
  `partialInterest` (:2673-2681);
- the `rewardRoots`, `rewardBook` and `rewardSets` fields, and the dead
  pieces of withdraw (:5452-5453, :5529-5532, :5544-5545).

What remains:

- `stakeRewardRejected` and `applyStakeRewards` collapse to one refusal:
  no `stake-reward` coinbase output, and no non-empty `rewardRoot`.
- `coinbaseRewardRoot` goes. In reserve_evm.js the `owedRoot` legs
  (:1254, :1266-1281, :1329-1340) and the legacy claim branch
  (:1117-1121) go too.
- The cutoff exports in pot_sched.js stay, because Reserve.sol mirrors
  them and `canJoin` still uses them for the idle flag.

Refusal test (to write with the retirement):

1. Make a real FS-1 lock through `applyReserveBlock`.
2. Assert the tranche has no amount and the portal has no `payout` or
   `dest`.
3. Then each of these is refused, with `mintBankNanos`,
   `rewardPermittedNanos` and `rewardRoots` unchanged:
   - a coinbase `stake-reward` output;
   - a non-empty `rewardRoot`;
   - a merkle-proof `reward-claim` with no `vaultProof`.
4. A withdraw of that portal pays principal plus the stub, with interest 0.
5. On the EVM side, `commitRewards` with a non-empty root is refused before
   the call.

Pins:

- **JS-only retirement: no fingerprint line names these functions**, so
  testnet, mainnet and mainnetFP stay. Two notes:
  - `RESERVE_REWARD_CLAIM=root-claim-principal-kept` (asert.js:233, :555)
    describes the retired law. Renaming it would move those three pins.
  - Refusing the empty-root coinbase that is accepted today tightens
    consensus with no string change. That is a STOP/GO point even though
    no pin moves.
- **Contract cleanup moves Reserve.json and the bytecode.** The dead parts
  are `_settle`, `_partial`, `_stakeSeries`, `_rewardTaken`,
  `_portalAccrual`, the archive helpers, `commitRewards` and
  `accruedReward`. Recommendation: do the JS retirement first, and fold the
  contract cleanup into a planned Reserve pin move, which could be this
  batch's, since row (a) already moves Reserve.json.
