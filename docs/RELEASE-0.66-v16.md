# Continuum 0.66 and Shear Sentinel v16

Book `shear-testnet-v10`. Continuum store `0.66.0+91`. Displayed wallet and CLI pins `0.66`. Node product `16.0`, display Shear Sentinel v16, GitHub tag `v16`. ShearK-Miner stays **2.6**. Datadir leaf `testnet-v10`. Previous tags `0.65` and `v15` stay. Do not clobber them.

PR #44 is `3dc91baf881fd570cfcfb94539cc956389655e0f`. That commit is not `6054186` (`6054186` is a quarantine label). The release commit on top of it adds the Continuum 0.66 pending-lands tree, the v16 product pin, and the credits-frozen removal. Advertised gitHead is `git rev-parse HEAD` of that release commit.

1. Continuum 0.66 lists every immature mined land from the node (local RPC and public node seeds), including a just-landed land, on Bare, p2P, and Full Node `--solo`. Pool HTTP is not the ledger, not Pending, and not confirmation authority. Spendable still opens at 9 confirmations.

2. Addendum D. An admitted lock, vote, or send enters the mempool and the ongoing miner template. Packaging stays lean. This is not a second fee market.

3. Addendum E. While the tip is stalled and the open header can still seal, the pool keeps that job. It restamps or reissues only when the open job cannot seal. A sealable header is not shredded on a 10 second restamp. `restart` stays false. `tip_stall_restamp` is not a paid levy.

4. Reserve V10 pin. `SHEAR_TESTNET_V10` is in `contracts/Reserve.sol` and in recompiled `contracts/Reserve.json` (PR #43, `decf455`). Lock-bearing seals boot the EVM. Without this pin, `bootReserveEvm` returns `reserve_deploy: revert` and the seal fails.

Every empty-book or MAGIC cut fails Ready unless all three move together:

1. `MAGIC_TESTNET` and the datadir book leaf.
2. The allowlist constant and the `_assertShear` arm in `contracts/Reserve.sol`, and a recompiled `contracts/Reserve.json`.
3. `bootReserveEvm()` and `bootReserveEvm({network: MAGIC_TESTNET})` succeed. An unknown magic still throws `reserve_deploy: revert`.

Do not repeat `40c917b`, which set the v10 magic and left the Reserve allowlist behind.

5. PR #44 (`3dc91ba`). Chunked IPC backfill: `IPC_BACKFILL_MAX` is a batch window and does not refuse a large gap. IPC apply repairs a missing prev or unsigned parent. Soft-fail TTL is 60 seconds and clears on boot for `unsigned`, `evm`, and `admit_membership`. `merkle`, `pow`, and `bits` stay permanent. getblock prefers the tallest peer. Status and help print `peerMaxHeight` and peerHash beside want and ibd. The pool logs `job_hold` with reason `sidecar_ahead` while the sidecar tip is ahead. The pool is not consensus authority. `crypto/spend.js` `verifyReservePortalOpen` accepts a sealed compact with commit and valueProof when spendPub is absent. A rangeProof-only check is not enough (H101 classed that body `unsigned`).

6. Credits frozen (`h_ratio`) is removed. A low hash ratio does not hold pool credits and does not raise confirmation depth. Blockfound stays instant and non-custodial. Reorg signals (`d_max`, `side_lead`) stay. They are not a credit ledger.

7. Deferred. Admit preflight when Reserve boot fails, splitting `evm_deploy_*` from `evm_execute_*` and from header `sealReject`, a Continuum Pending substatus for a seal-failed lock, and a Continuum tip chip are not in this cut. They need new Continuum and suite surfaces past download pins. Node status and help already print `peerMaxHeight`. https://shear.digital/sync/ stays a direct URL. The suite navbar has no SYNC link.

8. Miners, `--solo`, and a self-pool should upgrade to v16. A follow-only node may lag.

No chain reset. No ASERT retune. No auto-bounce. Nodes own the tip and confirmations. The pool does not override next-work.
