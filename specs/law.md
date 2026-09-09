# Shear book law

Frozen numbers. `consensusFingerprint()` pins every line. A later flip is a new book.

Network: `shear-testnet-v2` until this fingerprint is green. Mainnet `shear-v1` is a later genesis.

## Numbers

| Pin | Value |
|-----|--------|
| `T` | `90_000` ms |
| `BLOCK_SUBSIDY_NANOS` | `100_000_000_000` (1 SHE, 11 decimals) |
| `HASH_BONUS_NANOS` | `1` (10⁻¹¹ SHE). Kill every 10⁻¹⁰ line. |
| `HASH_BONUS_VOTE_DELTA_NANOS` | `1` |
| `HASH_BONUS_NANOS_FLOOR` | `1` (votes cannot set the unit to 0) |
| `SHE_PUBLIC_DIGITS` | `8` (sealed book still holds 11) |
| `SPENDABLE_CONFIRMATIONS` | `6` |
| `SAMPLE_PRUNE_CONFIRMATIONS` | `1000` |
| `GENESIS_BITS` | `12` (match asert.js) |
| `LIVE_MIN_BITS` | `4` |
| `MAX_BITS` | `256` |
| `SHARE_FLOOR_BITS` | `8` |
| `MAX_SHARES_PER_BLOCK` | `8192` |
| `MAX_HASH_UNITS_PER_BLOCK` | `MAX_SHARES_PER_BLOCK * 2^SHARE_FLOOR_BITS` |
| Interest | 400-day APR: `floor(staked * bps / 10000)`. Not × 400/365. |
| Oracle | unweighted mean of the frozen 14-bank basket. Default **264** bps until first sealed observe. |
| Late 99 days | idle, can vote, no interest |
| Dest HRP | `ssa` on chain only |
| Extra mint | `shear-reserve-v1` withdraw only, amount-bound |
| Pool fee | 100 bps of the 1 SHE pot; rest PROP to hasher dests |
| MTP | last 11 timestamps + 2 hours future |
| Levy cap | 0.001 SHE, 50/50 finder/Reserve |
| Premine | none |
| `setTip` | forbidden |
| `HASH_TX_LIVE` | `1` (forbidden to flip to 0) |

Fingerprint also pins:

```
SHARE_FLOOR_BITS=8
MAX_SHARES_PER_BLOCK=8192
SPEND_SIG=ed25519-shear-spend-v1
INTEREST=400d-bps-floor
ORACLE=basket-mean-14
HASH_UNIT_FLOOR=1
POT_PROP=shareBatch
POOL_WITHDRAW=eip712-spend-bound
```

## Hash unit (proven)

A **hash** is one ShearHash-v3 digest of the frozen 128-byte job header with a unique nonce.

A **unit** is `HASH_BONUS_NANOS = 1`.

A digest that meets `SHARE_FLOOR_BITS` is worth `units(share) = 2^SHARE_FLOOR_BITS`.

Forbidden: count from `clientHashes`, banners, thread counts, or a number the template author typed. `applyMinerSelfRate` is not a credit path. `roundActualHashes` has no client-hash branch. After one valid share the bonus may not jump to a reported counter.

Lag-1: ShearHash-v3 key K includes `continuity_root` and `merkle_root`. This-round shares must not write this-round `continuity_root`.

Block N pays the shares proven on the frozen job header of the previous open round (parent sealed header; nonce replaced per share; no restamp).

Body encoding `ENC_SHARE = 4` = `dest20 || nonce_u64le || lz_u8`. `shareBatch` max `MAX_SHARES_PER_BLOCK`, sorted `(dest20, nonce)`. Duplicate nonce = `dup_share`. Tree A stays `dest20+u64count`; count must equal summed units for that dest; mismatch = `hash_bonus`.

`skipFlow` when buried && samplesPruned may skip `shareBatch` bodies. It may not skip hash vouts / `ssa1` checks. IBD of a pruned height is assume-valid after 1000. Full nodes validate `shareBatch` until prune-1000; money vouts forever.

Work of a block: `blockWorkBig(bits) => 1n << BigInt(bits)`. Heaviest valid chain wins. Spec `2^256/(target+1)` is not used.

## Spend

`verifyDestOpening` is not authority. Spend is Ed25519 on the existing spend seed over `SHA256("shear-spend-v1" || packDigest(tx without sig/open))`. Missing/bad sig = `unsigned`. `claim` stays unfunded-off. Backup name is `shewall.bin`.

Miner login may be `she1` or `ssa1`. Payout dest is a fresh indexed `ssa1`, not `encodeDest(she1.hash20)`. Amounts stay public. Private dests, public amounts.

## Reserve

`vout.nanos = principal + floor(staked * committedBps / 10000)`. Idle adds 0 interest. Epoch ended. Bonus enacted first. `committedBps` is the last `observeRate` sealed in a prior block. `verifyBlock` does not read `reserve/latest.json`. Default 264 until first sealed observe. Wrong nanos = `mint_amount`. `wrapMintForbidden` stays. Third-party vortice cannot mint. `gateVorticeRegister` `ok: false` fails the block.

Vector: staked = 1 SHE, bps = 425, interest = `4_250_000_000`.

`liveHashBonusNanos` floor = 1. A vote that would set it below 1 is invalid. Votes still ±1 per epoch. Votes never touch the 1 SHE pot.

## Pool money

Coinbase `kind:pot` is PROP across dest20 in `shareBatch`. Hasher dests receive the pot minus pool-fee. Pool dest receives only pool-fee bps (100 bps of 1 SHE). A block that pays the whole pot to the pool dest is invalid. “Pull from pool” is not a mint and not the pot.

## Copy (keep)

- One proven share-hash mints units; user txs are signed Flow.
- Full nodes validate shareBatch until prune-1000; money vouts forever.
- Private dests, public amounts.
- PoW elects the tip. Pot is 1 SHE PROP. Hash units are proven PoW. Reserve interest is the only other mint, amount-bound.
- GPU/ASIC refuse is pool share-gate only, not consensus.
- Admin is TOTP + password. Host header is not authorization.

## Forbid

`setTip`, wrapping SHE, third-party mint, `HASH_TX_LIVE=0`, `shear1` in a vout, recutting Shear-Miner 1.0/1.1, merging v2 into v1, `liveHashBonusNanos < 1`, paying the whole pot to the pool dest.
