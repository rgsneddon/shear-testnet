# Wallet 0.18

Public pin `0.18`. Flutter file version `0.18.0+30`. Wallet tree only.

## A0 FlyClient (any live node)

`lib/shear_flyclient.dart`. Quiet node-find:

- Seeds include `https://pool.shear.digital` plus optional user URL.
- One jittered probe, exponential backoff on fail (not a 1s node-scan).
- Logarithmic header samples (`/api/explorer/header?height=` at 1, 2, 4, … tip and `/api/stats`) pick the best proven live node.
- Follow that live base URL. Not a full archive.

`ShearPoolClient` in `lib/shear_ledger.dart` uses FlyClient’s live base in production. Constructor override `baseUrl:` stays for tests.

## A1 Sign lock

Reserve deposit still opens `reserve-sign`. Continuum deducts via `ledger.send`. Lock-in card `reserve-locked-in` stays visible ≥ 6 seconds; Dismiss is disabled until then.

## A2 no flash

`reserve1.png` / `reserve2.png` are forbidden in `lib/` and `assets/`. Brand assets only.

## A3 vote at π

`canVote` when portal nanos ≥ `kPiSheNanos` (314159265358). Vote UI the instant ≥ π. Existing vote keys kept.

## A4 400-day APR

Protocol, not `* 400 / 365`:

- Whole-epoch: `floor(stakedNanos * bps / 10000)` i.e. `(p * bps * days) ~/ (10000 * 400)` when days = 400.
- Accrued: `floor(stakedNanos * bps * e / (10000 * EPOCH_MS))`.
- Idle = 0.

1 SHE at 425 bps whole epoch = **4250000000 nanos = 0.0425 SHE**, not 0.046575342.

UI says **400-day APR**, never “a year”. Source: **median of first-world central banks**. Constructor 425 is **Default** until first valid median (`oracleObservedAtMs == 0`), not “Observed”.

## A5 Continuum hash bonus

Show hash bonus from verified dests, 6-conf. No claim button. Join is dead. Do not add `claim-hashes`.

## A6 epoch-end Withdraw + Sign

`Withdraw to Continuum` opens `reserve-withdraw-sign`, then settles. Every epoch.

## A7 epoch table

Table epochs 1, 2, 3… with start/end local datetime. `ShearReserve` records history when an epoch opens (`startMs`, `endMs` = start + 400d). Printed in the Reserve pane (`reserve-epoch-table`).

## A8 TAP + tests

This file. New 0.18 tests use `skipPoolSync: false` with `_fakePool` so they hit a node.

- `kWalletVersion == '0.18'`
- `reserveInterestNanos(100000000000, 425) == 4250000000`
- no 0.046575342
- lock card still present after pump 6s
- withdraw shows Sign
- epoch table has start/end
- FlyClient picks a live mock node
- no reserve1.png/reserve2.png
- vote appears at π
- no claim-hashes button
