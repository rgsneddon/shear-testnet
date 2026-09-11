# Confidential amounts (shear-testnet-v3)

Fingerprint: `AMOUNT=confidential`. Do not land this on live v2.

## Frozen note math

Group: **ristretto255** (RFC 9496), via `@noble/curves`. Prime order `ℓ` of the ristretto group.

Generators (domain-separated, no trusted setup):

- `G` = ristretto255 base point
- `H` = `ristretto255_hasher.hashToCurve("shear-note-H-v1")` (DST `shear-note-v1`)

Pedersen commitment to value `v ∈ [0, 2^64)` with blinding `r ∈ F_ℓ`:

```
C = v·G + r·H
```

Serialized `C` is 32-byte ristretto encoding. `v` is a uint64 (nanos). Public `vout.nanos` is not a sealed field.

### Range proof (transparent)

Prove `v ∈ [0, 2^64)` for `C = v·G + r·H` without a trusted setup.

Bit decomposition: `v = Σ b_i 2^i` for `i = 0..63`, `b_i ∈ {0,1}`.

1. Bit commitments `B_i = b_i·G + s_i·H`.
2. Each `B_i` is proven 0-or-1 with a Schnorr OR on `{B_i, B_i − G}` relative to `H` (one discrete log is known).
3. Consistency: `C − Σ 2^i B_i` is proven in `⟨H⟩` (Schnorr), so the bits reconstruct `v` and the blindings match `r`.

This is a transparent range proof (same class as Bulletproofs: no ceremony). A later fingerprint may swap the proof bytes for Bulletproofs+ (smaller). The commitment equation does not change.

### Coinbase conservation

Let `T` be the public mint total implied by shareBatch (PROP pot + hash-bonus units × `HASH_BONUS_NANOS`). Coinbase carries `excess` = `Σ r_j` (32-byte scalar). Verifier checks:

```
Σ C_j  =  T·G + excess·H
```

and each `C_j` has a valid range proof. Wrong `T` fails. Finder-only remains illegal because `T` and the per-note openings are bound to collated `note_commit` units.

### Values that stay 1

- Hash-bonus unit = 1 nanos per proven floor unit (`HASH_BONUS_NANOS=1`).
- Block pot = `BLOCK_SUBSIDY_NANOS` (1 SHE) PROP of proven hasher notes; pool note gets 100 bps of the pot only.
- Reserve mint_amount: principal + `floor(staked * committedBps / 10000)`.

### Coinbase split

Lag-1 coinbase emits confidential notes whose committed values sum to (hash-bonus units + PROP pot − pool fee) for those `note_commit`s. Finder-only is illegal.

## Graph privacy — options (dummy outs, ring-sigs, FCMP++)

Amount hiding (Pedersen + range proof) does not hide **which note is spent**. Three options for spend-set privacy:

| Option | What a spend proves | Anonymity set | Size / verify (order of mag.) | Status for this book |
| --- | --- | --- | --- | --- |
| **Dummy outs** | Output graph: every Flow spend adds ≥1 dummy note + fresh change | Breaks change-amount heuristics | Cheap | **Day-one** (`DUMMY_OUTS=1`) |
| **Sampled CLSAG (n=16)** | One of *n* listed notes | Fixed 16 | ~1.5 KB | Not v3 — set too small |
| **FCMP++** | One of every eligible note on the chain (linkable key image, no trusted setup) | Full eligible set | LSAG now; curve-tree later | **Day-one** (`SPEND_MEMBERSHIP=fcmp++`) |

### Ring signatures (CLSAG)

A linkable ring signature proves one-of-*n* ownership and binds a key image so the same note cannot be spent twice. Decoys are sampled from the chain (gamma distribution in Monero). Strength is bounded by *n* and by decoy-selection analysis: an observer always knows the real spend is among *n* listed notes. Raising *n* grows signature size linearly. CLSAG is the current compact form (smaller than MLSAG). Shear would reuse the same Pedersen notes; the ring is extra on the spend, not a replacement for confidential amounts.

### FCMP++

FCMP++ (Monero Research Lab / Cypher Stack / kayabaNerve; curve trees) replaces the fixed ring with a membership proof against an authenticated set of eligible outputs. The spend proves the input is **some** note in that set without naming a decoy list. Anonymity set is the whole eligible pool and grows with the chain. Plumbing is a Bulletproofs-based circuit over a curve tree (not a pairing SNARK, not a trusted setup). 2026 integration work increased proof size ~17% after a generator-sampling fix (Cypher Stack); a 1-in/2-out tx is on the order of 7–8 KB with ~30–40 ms verify on a fast CPU.

FCMP++ does not replace stealth dests, Pedersen amounts, or Dandelion++. It replaces **input linking**. It is the stronger spend-set option. It is also more code and audit surface than dummy outs or CLSAG.

### Choice for shear-testnet-v3 day one

Confidential amounts + dummy outs + Dandelion++ + **FCMP++ full-chain membership** on spends. The membership set is every eligible note, not a sampled ring of 16. Linkable key image prevents double-spend. Linear LSAG is the first implementation; a curve-tree proof can replace it without changing the eligible set. Reserve kinds stay typed; the vault note is not dummy-deleted.

Fingerprint: `SPEND_MEMBERSHIP=fcmp++`. Dummy outs stay (`DUMMY_OUTS=1`). No pairing SNARK.

## Dummy outs (day one)

Every user Flow spend creates at least one dummy note. Change is a fresh note. Reserve lock/vote/withdraw keep typed kinds.

## Explorer

Amounts hidden. Memo is a boolean. Reserve/Vortex rows still list kind + height.
