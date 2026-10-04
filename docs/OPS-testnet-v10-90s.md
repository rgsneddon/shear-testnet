# shear-testnet-v10 — 90s tempo, no silent floor freeze

Live book magic is `shear-testnet-v10`. A v8 or v9 datadir does not load. There is no soft-merge. Quarantine v8/v9-wrong packs and git head `6054186` (`6054186b9b5689656b2fa1000e01b08ee67a01f5`). Advertised gitHead is this tree's `git rev-parse HEAD`. `SHEAR_GIT_HEAD` does not label the book. `SHEAR_BITS` is not consensus next-work.

## Tempo

Difficulty is network-wide. Block bits come from the sealed chain every node already has. Pool hashrate, shareBits, and `SHEAR_BITS` are not that target.

Hashrate fluctuates. It is not constant and it is not linear. Do not bake a hashrate, `log2(H·90)`, or 288 blocks into law or into a Ready flag.

- Step: `median11(log2(T/seen))*(T/tau)` on sealed header gaps only. `T=90000`.
- `τ=32T` (`ASERT_TAU_MS=2880000`). That choice is the fingerprint. The pool cannot edit τ mid-chain.
- `GENESIS_BITS=15` is a day-0 seed only. After genesis, bits follow real sealed gaps toward ~90s.
- Testnet lid is ±1 (`ASERT_HARDEN=1`, `ASERT_EASE=1`). Mainnet harden stays 6 and mainnet ease stays 1.
- Floor policy `ASERT_FLOOR=above-min-until-8tau`: a gap under 8τ cannot pack onto `LIVE_MIN_BITS`. An 8τ stall may sit on the floor.
- Template voids caller bits. Verify requires exact median11 next-work. `bitsForBlock` is not that path.
- Share vardiff (`shareBits`) is not a retarget. Consensus `blockBits` is the header next-work.
- The pool card "Average block time (sealed, all blocks)" is genesis→tip `networkAvgBlockTimeMs`. The explorer card "Avg block time" (`#ex-avg-block`) is that same sealed mean. The find-time EWMA is observational only. While sealed samples n < 288 the pool, explorer, and tip page say soaking and do not claim ~90s certified. 288 is not a Ready bar.
- invent-must-not-return stands. This cut does not relax it.

## Seal path

tipAge is how long the sealed tip has stood. lastFoundAt is the last time the pool recorded a find. A long tipAge under thin hashrate (about 640 H/s, one miner or fewer) is low-H: seals are still possible. That is not a dead tip and it is not a fleet getblock stall.

Low-H does not restamp and does not restart. A true freeze is no seal progress, peerMax stuck, and IBD dead. Reissue only when the live job cannot seal (parent, consensus bits, or stamp). A header that can still seal stays up — a new job every 10s abandons a multi-minute search while hashrate stays online. Empty `/api/mempool` `pending` is not that stall. The path does not restart the pool or the node, and it does not change ASERT next-work. There is no auto-bounce and no unattended tip_stall_restamp.

Manual bounce of a pool or node process is a human last resort only. It is not the freeze fix. Do not auto-bounce.

## Operator empty-cut order

Do this by hand on the fleet. This note is not a wipe command.

1. Land the v10 law, magic, and fail-closed datadir check on every host before any process opens a book.
2. Stop v9 miners. Do not point them at the new book.
3. Start Shear Sentinel v17 on an empty `testnet-v10` datadir. Do not open a v9 or v8 chaindir.
4. Start the pool on that empty book.
5. Point ShearK-Miner 2.8 at the public pool with `stratum+ssl://pool.shear.digital:443`. The pool process still listens for TLS on 1113; that port does not receive public SYNs. 443 ssl_preread forwards a no-ALPN ClientHello to it. Localhost solo may stay `stratum+tcp://127.0.0.1:1111`. Do not label a 2.6 rebuild as TLS-done. The Windows zip must include the OpenSSL DLLs beside the exe.
6. Continuum 0.70: same book `shear-testnet-v10`. A version bump does not wipe. Wipe only when magic changes.

Product versions are not part of `consensusFingerprint()`.

## Fee dest and stratum auth

The shipped fee ssa1 is the Russell pin `ssa1qzcru37269cx30t7pdsmujwrxhc76km6ctzhwggxnyr9f0ld85wc4zvluktldtcnke7mr524ngqqvfr3sd5qsh6kkuk` at 1 percent. `SHEAR_FEE_DEST` and `SHEAR_ADMIN_SPEND_DEST` default to that same address. A mismatch fails closed at boot and on the seal path. `SHEAR_FEE_IDENTITY_LAB=1` is the only lab bypass. There is no silent default swap on deploy.

`SHEAR_STRATUM_AUTH=1` rejects a login whose pubkey is not `SHEAR_STRATUM_AUTH_PUB` (64 hex). An unbound auth pub cannot satisfy AUTH.

Public bind (not loopback) refuses to listen unless a TLS cert is configured or `SHEAR_STRATUM_LAB_CLEARTEXT=1`. Loopback solo may stay cleartext. Dual-listen (cleartext plus TLS) is the migrate default when a cert is present.

## What /stats shows

Casual `GET /stats` does not list full worker pubs, the fluxset, or the full fee dest. It may show a fee-dest tail and counts. Wallet fluxset RPC stays available to the wallet that asked. Operator admin views stay off the public page.
