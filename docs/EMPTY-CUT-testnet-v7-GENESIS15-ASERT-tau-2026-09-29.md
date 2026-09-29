# EMPTY-CUT — shear-testnet-v6 → shear-testnet-v7

**As-of:** 2026-09-29 · Europe/London (BST / UTC+1)  
**Local tip (must redeploy this tip):** `C:\Users\rgsne\shear-pool-node` on DESKTOP-ODTSQ56  
**Do not bounce the live pool until Russell authorizes the cut.**

## Why a new book

Consensus fingerprint changes (book-law), so the prior v6 chain cannot continue:

1. **MAGIC** `shear-testnet-v6` → **`shear-testnet-v7`** (`MAGIC_TESTNET_V7`; `MAGIC_TESTNET = MAGIC_TESTNET_V7`; V6 kept as prior-book constant).
2. **P0-A `GENESIS_BITS`** `12` → **`15`** (sized for live testnet hashrate ~200–400 H/s via ≈ log2(H×90); mid/upper band → 15). Expected genesis interval ≈ 2^15/300 ≈ **109 s**; at 400 H/s ≈ **82 s**.
3. **P0-B `nextBits`** bang-bang `log2(T/seen)` → **τ-damped absolute ASERT** `(T − seen) / ASERT_HALFLIFE_MS`, then existing ± `ASERT_HARDEN_MAX` / `asertEaseMax(magic)` farm lid. Stall clamp still **8 × half-life**. Q16.16 pack/unpack unchanged. Fingerprint `ASERT_STEP` now **`(T-seen)/tau`**.

`TARGET_BLOCK_INTERVAL_MS = 90000` unchanged. Emission / HASH_BONUS / pot / invent-paint UI untouched.

## Wipe → v7 steps (operator)

1. **Build / install this tip** on every node + pool (same commit SHA). Do not mix v6 and v7 binaries.
2. **Stop** pool and all P2P nodes that will join the new book.
3. **Wipe datadirs** for the new magic (do not reuse v6 chain state). Typical paths:
   - Pool / sentinel: wipe `SHEAR_DATA` (or `/var/lib/shear/testnet-*` on VPS) so a fresh genesis seals under `shear-testnet-v7`.
   - Any solo `~/.shear` / configured data dir that still has a v6 `magic` file.
4. **Env / pack:** `SHEAR_NETWORK=shear-testnet-v7` (pack scripts default here). Continuum / wallet pin `kBookMagic = shear-testnet-v7`.
5. **Start** the three P2P nodes, then the pool, on this tip only.
6. **Hasher continuity:** keep ≥1 honest ShearK hasher through the cut so the empty book is not starved while ASERT walks. Share vardiff is not the 90s knob.
7. **Do not** soft-merge, pool-bounce, or invent-paint `avgBlockTimeMs` as a retarget fix.

## Measure (certify ~90 s)

- Prefer **sealed-header mean**: `networkAvgBlockTimeMs` / `avgBlockIntervalMs(blocks)` / explorer header timestamp Δt from genesis→tip.
- **Do not** green off findAt **EWMA** (`avgBlockTimeMs`) alone — that can look ~90 s while sealed mean is blown.
- ASERT settle claim only after **≥ 288** post-cut blocks (half-life) near ~90 s ± agreed band.
- Cross-check tip bits vs ideal `log2(HR × 90)` for the live hashrate band.

## Redeploy checklist

- [ ] Commit SHA on every box matches the cut tip (GENESIS_BITS=15 + τ-damped nextBits + MAGIC=v7)
- [ ] Fingerprint shows `NETWORK=shear-testnet-v7` · `ASERT_STEP=(T-seen)/tau` · genesis pin `:4:15:`
- [ ] Datadirs wiped; no v6 magic file left
- [ ] Hasher online through cut
- [ ] Observe sealed mean (not EWMA alone) for ≥288 blocks before Ready

Russell cuts when ready.
