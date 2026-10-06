# Shear book law

Frozen numbers. `consensusFingerprint()` pins every line. A later flip is a new book.

Network: `shear-testnet-v11` (privacy-class). Frozen `shear-testnet-v9`, `shear-testnet-v8`, `shear-testnet-v6`, `shear-testnet-v5`, `shear-testnet-v4`, and `shear-testnet-v2` are different books. v8 and v9 do not soft-merge. Mainnet `shear-v1` genesis is `2026-09-18T21:00:00+01:00` (BST; `2026-09-18T20:00:00Z`). Do not invent a different datetime. Do not emit before that instant. invent-must-not-return is unchanged by the v10 cut.

## Numbers

| Pin | Value |
|-----|--------|
| `T` | `90_000` ms |
| `BLOCK_SUBSIDY_NANOS` | `100_000_000_000` (1 SHE, 11 decimals) |
| `HASH_BONUS_NANOS` | `1` (10⁻¹¹ SHE). Kill every 10⁻¹⁰ line. |
| `HASH_BONUS_VOTE_DELTA_NANOS` | `1` |
| `HASH_BONUS_NANOS_FLOOR` | `1` — **the per-hash unit is never 0**. Votes, vault load, coinbase, and verify all clamp through `hashBonusUnitNanos`. A book that pays 0 per proven hash is a different book. |
| `SHE_PUBLIC_DIGITS` | `8` (sealed book still holds 11) |
| `SPENDABLE_CONFIRMATIONS` | `9` |
| `SAMPLE_PRUNE_CONFIRMATIONS` | `1000` |
| Reorg checkpoints | First frozen hash at height **1000** (prune floor), then every **400** blocks (bootstrap cadence). A heavier fork that replaces that hash is `reorg_checkpoint`. |
| Vault seal | Same freeze: first at height **1000**, then every **400**. `vaultSeal` = Reserve commitment + checkpoint hash (optional vault-genesis hash). Forks that diverged before that freeze get no vault (`no_vault`) and cannot unlock the sealed pot. Adopt of a history that lacks seal ancestry is `reorg_vault_seal` (or `reorg_checkpoint` if the hash itself moved). The vault stays on the master chain from genesis; replay never wipes it. Tip **below 1000** has no seal yet. |
| `GENESIS_BITS` | `17` day-0 seed only (match asert.js). v10's closed soak seeded `15`. Not a hashrate equilibrium and not `log2(H×90)`. Packed Q16.16 on the wire. Floor 4, ceiling 256. Ongoing step is `median11(log2(T/seen))*(T/tau)` with `τ=16T` (`ASERT_TAU_MS=1440000`). Testnet lid is ±1 (`ASERT_HARDEN=1`, `ASERT_EASE=1`). A non-stall gap cannot pack onto the floor (`ASERT_FLOOR=above-min-until-8tau`). Mainnet harden stays 6 and mainnet ease stays 1. Child bits use the sealed-header median, not the stamp of the block being mined. Hashrate fluctuates. 288 blocks is not a Ready bar. |
| `LIVE_MIN_BITS` | `4` |
| `MAX_BITS` | `256` |
| `SHARE_FLOOR_BITS` | `8` |
| `MAX_SHARES_PER_BLOCK` | `65536` (v11). Direct from the closed v10 cap of `8192`. The 32768 rung is cancelled. Do not soft-merge 65536 onto v10. |
| `MAX_HASH_UNITS_PER_BLOCK` | `MAX_SHARES_PER_BLOCK * 2^SHARE_FLOOR_BITS` = `16777216`. `HASH_BONUS_NANOS` stays `1`. |
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
NETWORK=shear-testnet-v11
FORK=work-then-lowhash
HASH_FN=ShearHash-v3
HASH_TX_LIVE=1
HASH_UNIT_FLOOR=1
LAG1_SHAREBATCH=1
POT_PROP=shareBatch
POOL_FEE_MAX_BPS=200
POOL_FEE_BPS=100 (this public pool's construction rate; not required of other pools)
DEST_HRP_SSA_ONLY=1
SPEND_SIG_ONLY=1
MEMO_NOT_DEST_KEYED=1
AMOUNT=confidential
DUMMY_OUTS=1
ENC_SHARE=v5
DANDELIONPP=1
VIEW_TAG=1
KDF=argon2id-shewall
RESERVE=shear-reserve-v1
RESERVE_EVM=1
RESERVE_INTEREST=400d-bps-floor
ORACLE=basket-mean-14
VORTEX=vort1-pin
VORTICE_NO_MINT=1
LEVY_CAP=0.001-SHE
LEVY_SPLIT=50-50-finder-reserve
ADMIT=ADMITv2
BITS=q16.16
ASERT_TAU_MS=1440000
ASERT_STEP=median11(log2(T/seen))*(T/tau)
ASERT_HARDEN=1
ASERT_EASE=1
ASERT_FLOOR=above-min-until-8tau
SHARE_FLOOR_BITS=8
MAX_SHARES_PER_BLOCK=65536
SPEND_SIG=ed25519-shear-spend-v1
POOL_WITHDRAW=eip712-spend-bound
```

v12 consensus caps a pool fee at `POOL_FEE_MAX_BPS` (200) of that block's subsidy. Carried pot is not part of the fee base. This public pool still constructs at 100 bps.

Mainnet `shear-v1` uses the same privacy-class law with `NETWORK=shear-v1` and `GENESIS=2026-09-18T21:00:00+01:00` (BST; `2026-09-18T20:00:00Z`). `HASH_TX_LIVE=1`. `HASH_BONUS_NANOS=1`. **Hash bonus never goes to 0** (`HASH_UNIT_FLOOR=1`). Votes cannot zero the unit or move the pot schedule. Clients refuse to emit before that instant.

## Hash unit (proven)

A **hash** is one ShearHash-v3 digest of the frozen 128-byte job header with a unique nonce.

A **unit** is `HASH_BONUS_NANOS = 1`.

Share difficulty binds hasher identity. The floor target is
`meetsTarget(sha256("shear-share-dest-v1" || ShearHash(header) || noteCommit), SHARE_FLOOR_BITS)`.
`noteCommit = sha256("shear-note-commit-v1" || dest20)`. Changing dest or noteCommit
invalidates the share. A third-party pool cannot restamp hasher dest on a stolen nonce.
Block POW stays ShearHash-v3 of the 128-byte header.

A digest that meets `SHARE_FLOOR_BITS` on that dest-bound hash is worth `units(share) = 2^SHARE_FLOOR_BITS`.
Inclusion of a hasher in `shareBatch` is the finder's (like txs). Omitted work is not minted
to the operator; operator `kind:hash` notes still require dest-bound POW on the operator dest.

Forbidden: count from `clientHashes`, banners, thread counts, or a number the template author typed. `applyMinerSelfRate` is not a credit path. `roundActualHashes` has no client-hash branch. After one valid share the bonus may not jump to a reported counter.

Lag-1: ShearHash-v3 key K includes `continuity_root` and `merkle_root`. This-round shares must not write this-round `continuity_root`.

Block N pays the shares proven on the frozen job header of the previous open round (parent sealed header; nonce replaced per share; no restamp).

Body encoding `ENC_SHARE=v5` = `note_commit || nonce_u64le || lz_u8` (optional view tag). Wire and disk store packed frames, not one JSON object per share. `shareBatch` max `MAX_SHARES_PER_BLOCK`. Canonical order is `(noteCommit, nonce)`. Over-cap inclusion keeps higher hash-share weight; equal weight breaks on sha256(noteCommit || nonce), not on a low dest20. Duplicate nonce = `dup_share`. Tree A stays `note_commit+u64count`; count must equal summed units for that dest; mismatch = `hash_bonus`.

`skipFlow` when buried && samplesPruned may skip `shareBatch` bodies. It may not skip hash vouts / `ssa1` checks. IBD of a pruned height is assume-valid after 1000. Full nodes validate `shareBatch` until prune-1000; money vouts forever.

Work of a block: `blockWorkBig(bits) => 2^{bits_fp}` (Q16.16 packed header bits). More work wins, whoever mined it. Equal work follows the lower tip hash (`FORK=work-then-lowhash`).

## Spend

`verifyDestOpening` is not authority. Spend is Ed25519 on the existing spend seed over `SHA256("shear-spend-v1" || packDigest(tx without sig/open))`. Missing/bad sig = `unsigned`. `claim` stays unfunded-off. Backup name is `shewall.bin`.

Miner login is `ssa1.worker`. `she1` login is RAM-only and must resolve to an owned rotating `ssa1`. Payout dest is never `encodeDest(she1.hash20)`. Spend authority is Ed25519 over `shear-spend-v1 || packDigest`; openings are local-only and stripped before chain.bin / P2P / public RPC. Memo is not dest-keyed. Amounts are confidential (Pedersen C + range proof). Dest HRP on chain is `ssa` only (`she` → `silent_id_on_chain`, `shear` → `rest_frame_on_chain`).

## Reserve

`vout.nanos = principal + floor(staked * committedBps / 10000)`. Idle adds 0 interest. Epoch ended. Bonus enacted first. `committedBps` is the last `observeRate` sealed in a prior block. `verifyBlock` does not read `reserve/latest.json`. Default 264 until first sealed observe. Wrong nanos = `mint_amount`. `wrapMintForbidden` stays. Third-party vortice cannot mint. `gateVorticeRegister` `ok: false` fails the block.

Vector: staked = 1 SHE, bps = 425, interest = `4_250_000_000`.

`liveHashBonusNanos` floor = 1. A vote that would set it below 1 is invalid. Votes still ±1 per epoch. Votes never touch the 1 SHE pot.

## Pool money

Coinbase `kind:pot` is PROP across dest20 in `shareBatch`. Hasher dests receive the pot minus pool-fee. Pool dest receives only pool-fee bps (100 bps of 1 SHE). A block that pays the whole pot to the pool dest is invalid. “Pull from pool” is not a mint and not the pot.

## Copy (keep)

- One proven share-hash mints units; user txs are signed Flow.
- Full nodes validate shareBatch until prune-1000; money vouts forever.
- Private dests, confidential amounts. ADMITv2 membership over this book's notes.
- PoW elects the tip. Pot is 1 SHE PROP. Hash units are proven PoW. Reserve interest is the only other mint, amount-bound.
- GPU/ASIC refuse is pool share-gate only, not consensus.
- Admin is TOTP + password. Host header is not authorization.

## Forbid

`setTip`, wrapping SHE, third-party mint, `HASH_TX_LIVE=0`, `shear1` in a vout, recutting Shear-Miner 1.0/1.1, merging v2 into v1, `liveHashBonusNanos < 1`, paying the whole pot to the pool dest.
