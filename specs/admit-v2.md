# ADMITv2 — Anonymous Destination Membership Integer Transactions

**ADMIT** = **A**nonymous **D**estination **M**embership **I**nteger **T**ransactions.
This book is **ADMITv2** (small v). Prior book: **ADMITv1** (full-fluxset LSAG on `shear-testnet-v3`).

Do not write AdmitV2, ADMITV2, Admit v2, or ADMIT-V2. Membership, not Multiple.
Do not brand the product FCMP++. Curve Trees (Campanelli, Hall-Andersen, Kamp, USENIX Security 23 / ePrint 2022/756) is the accumulator; cite that paper. Helios/Selene is not used.

Network magic: **`shear-testnet-v4`**. Empty genesis on this magic. Mainnet `shear-v1` waits; do not invent a genesis datetime here.

## Statement

```
leaf = H_to_field("shear-admit-leaf-v2" || P)   in the Pallas base field
tree = Curve Trees on the Pasta 2-cycle (Pallas–Vesta)
circuit = membership of that leaf only
```

- **P** is the ristretto `admitPub` already on the sealed vout (`P = x·G`).
- **spendTag** and spend-key stay **outside** the membership circuit.
- **Bulletproofs+** range proofs stay **outside** the membership circuit (`RANGE=bpplus`).
- **J** = every sealed `admitPub` in appearance order. Spent notes stay in J. Double-spend = reused `spendTag`. Reorg rebuilds J from the sealed chain.
- **ssa** payload is `dest20 || B` (52 bytes). Copy dest enters J.

ADMITv1 blobs (`proof.r.length === |J|`, DST `shear-admit-v1`) fail `admit_membership`.

## Cycle and arity

| Pin | Value |
|-----|--------|
| Cycle | Pasta / Pallas–Vesta (`pallas-vesta-pasta`) |
| Helios/Selene | **not used**. No faster-proof write-up; expected: no. |
| Arity `D` | **32** (wide / shallow) |
| Pad | `pad_to_arity`: each D-ary level is padded with identity children to a **multiple of 32**, never to the next power of D (that expanded \|J\|=100k to 1_048_576 dummy leaves). Height `h = ceil(log_D max(\|J\|, 1))` after per-level pad. |
| Leaf DST | `shear-admit-leaf-v2` |
| `H_to_field` | SHA-512 of `DST || P` (32-byte ristretto), little-endian reduce into Pallas `Fp` |
| Leaf point | `L = leaf · G_pallas` |
| jroot | 32-byte commitment: SHA-256(`shear-jroot-v2` \|\| pasta_root \|\| c_root) |
| Reference root | height−**k** with **k = 1** (prove against the live J as of the parent plus earlier body notes in this block) |
| Curve Forests | inputs ≥ 2 share one forest proof against the same jroot (same path-bit commitment) |
| Max proof size | **32768** bytes. Larger → `admit_membership` |
| Native | `admit_prove` / `admit_verify` / `admit_verify_batch` in `crypto/native`. JS is glue. `verifyBlock` must not be JS-only. Verify **returns false**, never throws. |

Internal nodes: Pedersen vector commitments of arity D, alternating Pallas / Vesta so child coordinates are native to the parent’s scalar field (Curve Trees on a 2-cycle, not a tower over Ed25519).

## Conservation tree (outside the membership circuit)

Sealed compact Flow **must not name the spent dest/note**. These vin fields are a privacy leak (unique match onto a vout) and must not appear on the sealed body, P2P, `chain.bin`, or public RPC:

`prev`, `index`, `commit` (the **original** vout C), `noteCommit`, `dest20`, `address`.

Today’s ADMITv1 `commit_sum` looked up `vin.prev`/`index` to bind `C_in`. That bind is gone.

Replacement, **outside** the membership circuit:

- A parallel **ristretto** D-ary vector-commitment tree of every sealed note **C** (same appearance order as J, same index).
- `c_root` is mixed into `jroot` as above.
- Spend **select-and-rerandomizes** C: public `C̃ = C + t·H` with fresh `t ≠ 0`. `C̃` is not equal to any vout C.
- Sealed vin carries **only** `{ commit: C̃ }` (and coinbase marker if any).
- C-tree leaves are the ristretto C encodings. Membership is D-ary CDS select-and-rerandomize (dest Vesta + C ristretto share one wrap-around so mixed indices fail). Slot `d0` and the dest_leaf of the spent note are **not** on the wire. Intermediate parents are opened from the previous layer’s Q (32-bucket, not the spent leaf).
- At the leaf, the arity-32 dest P encodings (admitPub) and C encodings may appear as sibling buckets (32-anonymity). `p_com = P_j + w·U` and `C̃ = C_j + t·H` are 1-of-D at the **same** hidden slot. `dest_parent` must equal the Vesta commit of `H_to_field` of those P’s (zero-pad slots stay the identity child). An attacker x with a victim path / self-minted `C̃` fails `admit_membership`.
- Kernel: `Σ C_out + C_fee = Σ C̃_in + excess·H`. `C_fee` is Pedersen of the weight-levy. Amount sent is not an input to the fee. `v` is not on the body.

Wallet openings (`r`, `t`, original C, dest) never leave the wallet. `compactTx` is the privacy boundary.

## Range (`RANGE=bpplus`)

Every money C: `v ∈ [0, 2^64)`. Dummy proves 0. Coinbase `Σ C = T·G + excess·H`. Native `proveRange` / `verifyRange`. v3 bit-OR proofs fail `range_proof` on this magic.

## Levy (`LEVY=weight`)

```
weight = sealed Flow body bytes the node stores and verifies
fee    = max(FLOOR, ceil(weight × RATE_NUM / RATE_DEN))
fee    ≤ CAP
```

| Pin | Integer |
|-----|---------|
| `FLOOR` | `100` protocol units |
| `RATE_NUM` | `1` |
| `RATE_DEN` | `2048` (1 unit per 2048 weight-bytes) |
| `CAP` | `100_000_000` = `0.001 SHE` |

Same weight ⇒ same required fee for amounts 1 and `10^9`. A spend that sets fee from 2 bps of `v` is invalid. Default wallet feerate = this RATE (relay minimum). Paid levy splits 50/50 finder / Reserve vault. Mempool orders by `fee / weight`.

## Reject reasons

Unchanged names: `admit_membership`, `admit_link_tag`, `range_proof`, `commit_sum`, `silent_id_on_chain`.

## Reorg

Rebuild J, both trees, and spent tags from the sealed chain. Do not delete spent leaves. `jroot` on coinbase `txs[0]` only — not in the 128-byte ShearK job.

## Fingerprint pins

`ADMIT=ADMITv2`, `RANGE=bpplus`, `LEVY=weight`, `NETWORK=shear-testnet-v4`, cycle `pallas-vesta-pasta`, `ADMIT_ARITY=32`, `ADMIT_K=1`, `ADMIT_LEAF=shear-admit-leaf-v2`.

## Performance bar

| \|J\| | prove | verify | batch |
|------|-------|--------|-------|
| 1k | ms | ms | ms |
| 10k | one spinner / tens of ms | tens of ms | few ms |
| 100k | still one spinner / tens of ms, not hundreds | tens of ms | block inside 90s |

Proof: few KB (≤ 32768). Node RAM: tens of MB, not ~1 GB. Miss 100k → fix cycle / arity / native code, not hash bonus.

## P0 (unchanged law, this book)

`HASH_TX_LIVE=1`, 1 unit per proven floor-share lag-1, no clientHashes, no finder-only, 1 SHE pot PROP, pool 100 bps of the **pot**, ShearK job 128 bytes. Reserve lock/vote/withdraw/claim, 400-day floor APR, 14-bank oracle default 264 bps, EVM, `shear-reserve-v1`. Vortex `vort1` pin, `gateVorticeRegister`, no third-party mint.
