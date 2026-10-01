# Fleet tip stall — RCA and fix

Date: 2026-10-01

## RCA

Lagging fleet nodes (census: p2p-a ~H104, b ~H103, c ~H102, soaks ~H107 while pool + shear-p2p were H125) were not a chain wipe and not a consensus-bits problem. Three sync bugs stacked.

1. **IPC backfill refused gaps wider than 8.** `IPC_BACKFILL_MAX` in `node/src/p2p_ipc.js` was a hard stop: `paceBackfill` returned when `local - from > 8`. A sidecar that fell more than 8 behind the pool on hello never received the missing blocks. Tip-forward only sends the new tip, so a jumped block then failed `prev` and was not walked back. That is the pool-stuck vs peer-tip split. Empty pending and tipStall-with-H are a separate seal symptom; they are not this gossip gap.

2. **Upgradeable ingest failures were permanent.** `isFinalIngestFail` put `unsigned`, `evm`, and `admit_membership` into `rec.failed`. `nextSequentialHeader` then skipped that hash forever, so `want` stayed empty while the peer tip was still ahead. Live H101 `unsigned` was the compact block path (sealed wire drops `spendPub`; `valueProof` was not accepted). That spend check is already patched on the hosts. This change stops the same class of reject from freezing IBD after a pin or native rebuild. `merkle`, `pow`, and `bits` stay permanent.

3. **Getblock followed the short mesh.** A peer at local+1 was asked for that one block even when a taller peer (pool sidecar at H125) was connected. Header wants on the short peer were dropped instead of moved. Catch-up crawled H102→H107 inside the lagging mesh.

Status made a short mesh look finished: `want=0` and `ibd=false` whenever nobody *advertised* a taller tip. Seeds remain `p2p` / `r2r` / `b2b` only. `peerMaxHeight` and `peerHash` are now printed beside `want` and `ibd` so a mesh that is all behind is visible.

Pool jobs are held while the sidecar tip is strictly taller than the pool-local tip, so stratum does not seal an orphan parent. The pool tip is not treated as consensus. There is no datadir wipe, no auto-bounce, no ASERT or `SHEAR_BITS` override, and no Reserve strip.

## What changed

- `node/src/p2p_ipc.js` — `IPC_BACKFILL_MAX` is a chunk size. Hello backfill sends every missing block, 8 per turn. Gap > 8 logs `ipc_backfill` with `refused:false`. `ipc_backfill_refuse` is only when the taller tip has no bodies to send. `ipc_apply` failure `prev` or `unsigned` logs height, block height, and parent, then sends `ipc_getblock` for that parent (ancestor window). Sidecar `ipc_peers` includes tip height and hash.
- `node/src/p2p.js` — `unsigned`, `evm`, and `admit_membership` are soft fails (`SOFT_FAIL_TTL_MS` 60s, cleared on boot and on pin change). Getblock wants hand off to the tallest ahead peer. A local+1 mesh peer is not asked while someone taller is connected.
- `node/src/status.js` — `peerMaxHeight` and `peerHash` on the status JSON and the stderr line, next to `want` and `ibd`.
- `pool/src/pool.js` — `noteSidecarTip`. `issueJob`, header restamp, and block submit hold with `job_hold` / `seal=sidecar_ahead` while the sidecar is ahead. Existing job id is kept. No new template on the stale parent.
- `pool/src/main.js` — wires sidecar hello and `ipc_peers` into `noteSidecarTip`.

## Tests

`node --test` (16 pass, 0 fail):

- `node/tests/test_ipc_backfill.js` — gap 15 is chunked, not refused; hello backfill of height 10 onto an empty sidecar; jumped `ipc_block` asks for the parent.
- `node/tests/test_soft_fail.js` — `unsigned` / `evm` / `admit_membership` are not final; next header is skipped during the TTL and resumed after it; pin change clears `admit_membership`; `merkle` stays failed.
- `node/tests/test_getblock_taller.js` — local H100, mesh H101, tall H125: getblock goes to the tall peer only.
- `node/tests/test_ibd_status.js` — `peerMaxHeight` beside `want=0` / `ibd`.
- `pool/tests/test_sidecar_job_hold.js` — force `issueJob` does not rotate the job while the sidecar is 15 ahead; seal reason `sidecar_ahead`; resumes when heights match.
- `node/tests/test_ibd_unsigned.js` — mempool unsigned is still rejected; it does not ban the peer.
- `node/tests/test_fork_choice.js` — wire round trip still verifies; `admit_membership` is not a permanent fail.

A two-hop handshake test in `test_p2p.js` also fails on unmodified `main` in this environment (no `shearhash.node`). It is not part of this patch.

## Verify

1. Restart is human-only. Do not wipe datadirs.
2. On a sidecar more than 8 behind, journal should show `ipc_backfill` with `refused:false` and `chunks` > 1, then `ipc_apply ok:true` climbing to the pool height. `ipc_backfill_refuse` means the bodies are not in that process.
3. A `prev` apply should be followed by `ipc_getblock` for the parent hash, not silence.
4. `node --status` / the periodic stderr line includes `peerMaxHeight=` and `peerHash=` next to `want=` and `ibd=`.
5. While sidecar height is above the pool, stratum must not rotate onto a new job; log `job_hold` reason `sidecar_ahead`.

## PR

https://github.com/rgsneddon/shear-testnet/pull/44 (draft, branch `cursor/fleet-tip-stall-ipc-5e19`). Not deployed.
