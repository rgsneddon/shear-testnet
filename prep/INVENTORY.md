# Mainnet prep inventory — 7 September 2026

Record of what is actually true. Do not rewind testnet.

## Pins

- Live site wallet pin: **0.27** (`wallet <strong>0.27</strong>`, WALLET `releases/tag/0.27`)
- Miner pin: **ShearK 1.5**
- Public tag `0.27` commit **`4a197e1`** (`feat(wallet): 0.27 remove pasted vortice from this wallet only`)
- Branch tip copied: **`f8dbf2d`** leftover WALLET navbar pin 0.27
- Do not recut **0.26** (dmg `716a0bd01fa7fd5ecaac00bb49773c215ae50c42f41c10285ce04dc16290bd6d`, apk `b7686576490fd5bb7965be0e47da2e709b1d328999440e734ecc10da52cd511f`)

## Live network (leave it)

- Magic: **`shear-testnet-v2`**
- Homepage: **TESTNET** banner; launch is **Friday 11 September 2026**, 21:00 BST (live copy currently omits the weekday; prep docs use Friday, not Thursday)
- Germany **178.105.187.178**: `shear-pool` **active**; `shear-node` inactive
- Datadir: **`SHEAR_DATA=/var/lib/shear/testnet-v2`**
- Live bits in code (copy, do not “fix” to the old 21/14 plan): `GENESIS_BITS=12`, `LIVE_MIN_BITS=4`, `MAX_BITS=256`, `TARGET_BLOCK_INTERVAL_MS=90000`

## Levy (quoted from `crypto/levy.js`)

- `LEVY_CAP_NANOS = Math.floor(0.001 * NANOS_PER_SHE)` → 0.001 SHE hard cap
- `LEVY_FLOOR_UNITS = 100`
- `LEVY_BPS = 2`
- `FEE_SPLIT_FINDER_BPS = 5000` / `FEE_SPLIT_RESERVE_BPS = 5000` (50/50)
- Surge `SURGE_MAX = 3`, `SURGE_REF = 2048`

## Reserve

- Vote kind: `vote`
- Extra mint only `shear-reserve-v1`
- `Reserve.sol`: `SHEAR_MAINNET = keccak256(bytes("shear-v1"))` (kept)
- Remove vortice: this wallet only; Reserve cannot be removed

## Wallet 0.27 FlyClient / seeds

- `kFlyDefaultSeed = 'https://pool.shear.digital'`
- Mainnet profile (this goal): `p2p.shear.digital:30303`, `46.224.132.83:30303`, `178.105.187.178:30303`

## Pool snapshot (before any copy)

- Tag **`snapshot/mainnet-prep-20260907`**
- Commit **`e018d6d93d049b3f63ce825f532e3f11308676d7`**
- Do not deploy a pool to 46.224.132.83

## DNS

- `dig +short A p2p.shear.digital` → **`46.224.132.83`** (already published)
- Agent did not alter any other shear.digital record

## Work repo

- Branch **`prep/mainnet-shear-v1`** from public `rgsneddon/shear-testnet` tip `f8dbf2d`
- Private `rgsneddon/shear` (`frozen-shear`) is an older 0.11 tree — not used as the source pin

## GATE log

- Phase 0: inventory written 2026-09-07. Live pin 0.27, miner 1.5, pool snapshot `e018d6d`, DNS 46.224.132.83.
- Phase 1: `acceptsMagic` + `verifyBlock` foreign_magic + levy cap tests green. Launch weekday **Friday** 11 Sep 2026 (not Thursday).
- Phase 2: unit + seed doc written. SSH to 46.224.132.83: **Permission denied (publickey)** — packages + markdown only; book not started.
- Phase 3–7: mainnet profile, unpublished staged site, packaging notes, unposted announce, cutover HANDOFF, WINDOWS-HANDOFF. Live homepage still TESTNET / 0.27.
- Skeptic fix: `createStore({ magic })` threads into append/verifyFork; genesis timestamp `1789156800000` = 2026-09-11T20:00:00.000Z; wallet `network: 'mainnet'` wires FlyClient; `make -C sheark-miner mainnet` print-config is shear-v1.
