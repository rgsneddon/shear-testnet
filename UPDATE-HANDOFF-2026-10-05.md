# UPDATE HANDOFF — 2026-10-05

Continuum 0.71 and Shear Sentinel v18 are for shear-testnet-v11 only. Mac Continuum is parked. This note is not the Desktop mac handoff.

## Opening bits (locked)

- shear-testnet-v10 genesis opening bits = 15. That soak is closed. Do not retune its τ, bits, median, or lid.
- shear-testnet-v11 genesis opening bits = 17. Russell locked 17 as more prudent than 16. v10 was 15, so this is +2.0 bits. Live tip bits are not the genesis open.
- Packed on the wire as `17 * 65536` (Q16.16).
- τ = 16·T = 1,440,000 ms. Median-11 and the testnet ±1 lid are unchanged.
- Magic is `shear-testnet-v11`. v10 payloads do not load. PRODUCT_VERSION 18.0 is display-only and is not in the fingerprint.

## Share cap

- `MAX_SHARES_PER_BLOCK` was 8192 on the closed v10 book. shear-testnet-v11 cuts straight to 65536. The 32768 rung is cancelled.
- `SHARE_FLOOR_BITS` stays 8, so `MAX_HASH_UNITS_PER_BLOCK` is 65536 × 256 = 16777216.
- `HASH_BONUS_NANOS` stays 1. This is headroom for more included shares, not a bonus-unit change.
- The 1 SHE block subsidy stays the pot. Hash bonus is paid on top of that pot, to every miner who proved a share, including when another pool or a solo miner found the block.
- Do not soft-merge 65536 onto live v10. `node/src/store.js` side-hold 8192 is a different cap and was not changed.
- Default `SHEAR_P2P_MAX_FRAME` is 16 MiB so a full packed 65536-share block fits on the JSON line. The old 2 MiB default does not.
- Wire and disk store packed share frames (`sharePacked` / `packShareBatchBytes`), not one JSON object per share. A leading `[` on disk is still read so an older `chain.bin` opens.
- Live blocks sit in `segments/seg-NNNNNN.bin` (400 blocks each). Prune rewrites only the segment that just buried samples. It does not rewrite the whole book. `chain.jsonl` is a slim `{h, hash}` index. A legacy `chain.bin` with no segments still loads, and the first later append moves it aside to `chain.bin.legacy`.
- Over-cap inclusion keeps the higher hash-share weight. Equal weight breaks on sha256(noteCommit || nonce), not on a low dest. A block that arrives already over the cap still fails `share_cap`.
- Grouped encode, difficulty-weighted shares, and a higher `SHARE_FLOOR_BITS` are parked for the next book. Packed v5 plus the 16 MiB frame carries 65536. `SAMPLE_PRUNE_CONFIRMATIONS` stays 1000. `SHARE_PRUNE_CONFIRMATIONS=400` is not in this cut.

## Pool fee dest (v11 only)

- Operator seal pin and admin spend dest are one address, `THIS_POOL_DIRECT_FEE_DEST` in `pool/src/posture.js` (re-exported from `pool/src/pool.js`).
- Full dest (operator note, not a public page): `ssa1q5495s7qwnljwkt2q8896vect0qaj3argt68hvet8t3vkhf9f7tcn0qhsd2q45e4lnay7u98sp22sddc639hqt0d8jj`
- Public tail only: `d8jj`. `/api/stats` keeps `feeDestTail` and does not return the full dest.
- The closed v10 pin ending `kkuk` is `V10_POOL_FEE_DEST`. This tree refuses it (`v10_fee_dest`), including when `SHEAR_FEE_DEST`, `SHEAR_ADMIN_SPEND_DEST`, or `SHEAR_POOL_FEE_PAYOUT_DEST` still names it. A v11 unit must not copy that v10 env.
- `poolFeeDest()` / Continuum `kPoolFeeDest` stays `ssa1q4ke8…` (sha256 of `shear-pool-fee-v1`). That is the levy/hop display dest, not this seal pin. Login does not use it.
- The live v10 pool was not bounced and its datadir was not changed.

## Tip

- `origin/main` and this branch HEAD are still `dd7ae2dbadd5db0135cb78eb21331105120f2c78`. The v11 constants above are in the uncommitted working tree. No new tip SHA until that tree is committed.

## Send path

Default Continuum spend posts to a node (local RPC `127.0.0.1:18332`, or p2p/r2r/b2b). It does not POST `https://pool.shear.digital/api/wallet/send`, and a connection failure does not fall back there. Pool HTTP send exists only when `legacyPoolSend` is set and the configured host is already a pool. The pool is not settlement and is not a balance.

## Flyclient on Connect bare

Connect bare, on Android and on desktop, trusts the tip with a Flyclient-style header sample. The note scan still paints spendable. The sample does not replace it. p2P Node and Full Node are unchanged: they still follow the local node, not this sample.

What the sample proves. It asks a node for a logarithmic set of headers (heights 1, 2, 4, … and the tip, plus the tip's parent). Each header is 128 bytes. The digest the node claims for that header meets the bits target packed in the header. The tip header's previous-hash field equals the parent header's claimed digest. Height 1 is the book genesis. The wallet does not recompute ShearHash-v3 on the device, so this is a header and target check, not a local RandomX proof.

Peers. The sample uses the node seeds only: local RPC `127.0.0.1:18332`, then `p2p.shear.digital`, `r2r.shear.digital`, and `b2b.shear.digital`. It does not use the pool. It does not send an address, and it does not call notes, balance, history, or send.

Failure. If no peer on the pinned book returns a sample that passes, the bar says `sample failed` and does not say CONNECTED. If the note-scan tip and the sample tip are both known and differ by more than one block, or their genesis headers differ, the bar says `tip disagree` and does not say CONNECTED. A one-block gap while a block is landing is not a disagreement. Spendable stays on the opened notes either way. A failed sample does not paint a confident 0.

Mode switch. Connect bare and the local node share the trusted tip and the opened-note cursor. Apply keeps that tip. It does not wipe the cursor and it does not rescan from genesis. A different genesis or a different book magic does both: the tip goes to 0 and the note cursor is dropped so the next read starts clean. The switch itself does not delete coins already opened.

## Not done in this note

- No 0.71 or v18 packs have been published. Do not republish 0.70. Do not build a macOS image here.
- The v11 soak clock has not started. It is 72 hours from the genesis-live stamp, on the soak hosts, in a new `testnet-v11` datadir. Do not wipe or bounce the public v10 pool or the three P2P satellites.
- When that soak starts, the parameter list below is the record. Planned end is start + 72h BST, written here when genesis is stamped. Do not retune mid-soak without a Russell GO. Nothing to flag yet.

## Soak metric — chain size and prune delta

Read-only. No prune-policy change, no datadir wipe, no pool bounce. Measure a representative full node on an authorised soak host. The v11 datadir pin is `/var/lib/shear/testnet-v11`. Do not measure or touch `/var/lib/shear/testnet-v10`.

Law: `SAMPLE_PRUNE_CONFIRMATIONS=1000`. Sample bodies drop after that depth. Sealed money vouts stay.

Record each sample with height, wall time (BST), host, and the node tip SHA.

1. Pre-prune baseline, at a known height before sample prune bites: `du -sh` of the datadir, plus `chain.bin`, `chain.jsonl`, and explorer or sample files if they are present.
2. At or just after the first prune window (height at least about 1000 plus confirmations): the same breakdown.
3. Delta: absolute bytes and percent reduction from prune. Say what dropped (samples) and what remained (money / vouts).
4. Optional spot checks about every 6–12 hours, or about every 400 blocks, so growth in MB per block stays visible.

The series is empty. The v11 soak clock has not started, and that datadir does not exist yet.

## Soak parameters (72h, not started)

Network `shear-testnet-v11`. Continuum 0.71 and node v18, same genesis, params, and magic. `GENESIS_BITS` 17 (v10 was 15). `ASERT_TAU_MS` about 1,440,000. Median-11 and the ±1 lid stay. `MAX_SHARES_PER_BLOCK` 65536 direct from 8192. `SHARE_FLOOR_BITS` 8, 256 units per share, `HASH_BONUS_NANOS` 1. Lean path: 16 MiB P2P frame, packed v5 on wire and disk, segmented prune. Pool fee dest is the d8jj address above. Public stats show `feeDestTail` only. Mining dest changes later, when Russell says so.

Clock is 72 hours from the genesis-live stamp. Prior 48 hour references in this goal are superseded. Judge the from-start mean against 90 seconds after the full 72 hour clock, not from a short window. The early stretch under 17 bits must not replay the v10 ~59 second first-100.

Stamp at genesis live, on ubuntu-soak and fedora-soak only, datadir `/var/lib/shear/testnet-v11`: start BST, planned end (start + 72h BST), genesis and tip SHA, height-0 baseline. Do not SSH to measure before that datadir exists. The series is empty.

Watch timing: rolling, last-hour, last-N, median versus mean, τ close speed, ±1 behaviour.

Watch shares: p50, p90, max, and percent of blocks at cap. Verify milliseconds per block (flag if p99 is many seconds). Body size, relay, orphans. Truncation fairness if the cap binds. `dup_share`, `hash_bonus`, and `seal_failed` spikes. Peak RSS. IBD time per 1k blocks. Bonus versus pot. Small-miner proportion variance. Stall-gap share counts.

Watch disk: datadir `du`, segment files, and any leftover `chain.bin` or `chain.jsonl`. MB per block. Pre- versus post-sample-prune delta around 1000 confirmations. Confirm the prune rewrote a segment, not the whole chain.

Watch privacy, wallet, and send. A bare ssa1 must not return balances, notes, or history. Continuum send goes through a node. Spendable paints SYNCING, then CONNECTED, and does not paint a false empty after unlock.

Watch pool, P2P, and book. `/api/stats` uptime. Pool memory, with no 1 GB freeze class. Multi-host tip agreement. No surprise mint under 65536 shares. `skipFlow` stays 0 percent under the prune floor. Zero hash-vout mismatches.

Hold mid-soak. No τ, bits, max-shares, or encode flip. No pool bounce and no chain reset. No site UI redesign and no fee or emission rewrite without a Russell GO.

Parked. Mac Continuum. Mainnet opening bits 22. Weighted shares and a higher share floor, only if the soak says they are needed.

## Post-soak pack (empty until the 72h clock ends)

Results, anomalies, and a GO/NO-GO list are filled when the soak ends. Do not invent them now.

Results to fill: from-start mean versus 90 seconds, early stretch, rolling and median, τ behaviour. Share p50/p90/max, percent at cap, verify, relay, orphans, IBD, RSS. Disk MB per block, pre/post prune delta, and whether prune stayed segmented. Privacy, wallet, send, pool, and P2P checks from the list above. Stamp start and end BST, genesis and tip SHA, and the height range.

Anomalies to fill: frame rejects, hash-vout issues, freezes, tip splits, a false-empty wallet, a public bare-ssa1 leak. None are known yet because the clock has not started.

Recommended actions to answer then, each as GO or NO-GO: keep 65536 or reduce it on the next book, and to what. Keep, harden, or redo packed encode, the P2P frame, and prune. Weighted shares and/or a higher `SHARE_FLOOR_BITS`: yes, no, or defer. Truncation fairness: done or still needed. τ and genesis bits for the next testnet or mainnet, including the mainnet open-bits working assumption 22. Continuum 0.71 and node v18 follow-ups, plus fee and mining dest notes. Mac Continuum stays parked unless the soak unblocked it.

Next cut seed, to paste after the soak: shear-testnet-v11 ran 72 hours at 65536 packed shares with a 16 MiB frame and segmented prune. Fill the keep-or-change line from the action list above before the next book.
- Russell disconnected the phone on 2026-10-05. Do not expect `adb` until it is back. The installed Continuum is 0.71.0 (versionCode 96), replaced in place with `adb install -r` after the law tests. The session was kept. Do not uninstall it. That would wipe the v11 fee mailbox. The APK check continues when the phone is plugged in again. The APK SHA-256 is `46a136ecc400130a338148a823ae49df96f333f4dd59953958000d629960265c`, the same bytes as the earlier pack, because the wallet sources did not change with the node share cap or the fee pin. At 11:48 BST the screen was responsive: not connected, height dash, light/dark control present, spendable `…`. That is the v11 fee mailbox (tail d8jj). v11 genesis is not up, so this is not a v10 fee-coin read. No ANR dialog.
- A v11 wallet will not show the live v10 fee-wallet coins.
