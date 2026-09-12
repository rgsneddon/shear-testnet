# Admit v1 — Shear admittance proofs

**User:** Admittance hides which output moved.

**Spec:** Admittance proves a spend is an admissible extraction from the committed current J without revealing which flowline carried it.

**Audit:** Admit v1 is a Curve Trees membership proof over Shear's fluxset plus Shear spend-auth. It is not Monero FCMP++ unless the relation and gadgets match.

Does not ship Curve Trees crypto in this book yet. Names the architecture. Day-one `crypto/admit.js` is a full-fluxset linkable ring (LSAG). AdmitV2 may replace the ring with the named accumulator without changing the fluxset.

## Accumulator

Curve Trees (Campanelli, Hall-Andersen, Kamp, USENIX Security 23 / ePrint 2022/756).

Cite that paper wherever the construction is described. Do not brand the product "Curve Trees".

## Statement

Spend is admissible in J = rho * u over the fluxset.

- **fluxset** — the live output set Admit proves against
- **jroot** — commitment to J as of a reference height
- **admit_proof** — opaque proof blob (length from input count + tree depth)
- **admit_prove** / **admit_verify** — construct and verify

## Note → P = x·G (coinbase and Flow)

Every sealed output (coinbase hash/pot/levy notes, Flow pays, dummy value-0 notes) carries a ristretto point `P` on the vout as `admitPub`. Notes stay Pedersen `C = v·G + r·H` plus Ed25519 spend sig; Admit rings `P`, not `C`.

Wallet spend seed is the 32-byte Ed25519 seed. Coinbase and Flow use the same map — not a test-only function.

```
x_base = hashToScalar("shear-admit-x-v1" || "base" || spend_seed)
B      = x_base · G
delta  = hashToScalar("shear-admit-x-v1" || "note" || noteCommit || C || kind)
x      = x_base + delta
P      = B + delta·G = x · G
```

`B` travels in the payable dest: `ssa` payload is `dest20 || B` (52 bytes). `hash20FromAddress` still reads the first 20 bytes. Wallet Copy dest exports this dest so mining income enters J and is later spendable under Admit. Dummy outs pick a fresh `x`, publish `P`, and drop `x` (value 0).

Pedersen `r` is a sealed secret (`compactTx` drops it). Coinbase and Flow seals wrap `r` to dest `B` as `rEph = e·G`, `rCt = r + H("shear-r-wrap-v1" || e·B || noteCommit || C)`. Compact vouts keep `rEph`/`rCt`. The owner unwraps with `x_base` and binds `commit`/`prev`/`index` by scanning sealed vouts (match `noteCommit` to dest20). Outputs this wallet seals (change) keep `r` locally.

`verifyBlock` and mempool `queueTx` call `admit_verify` against the **complete** live fluxset (every `admitPub` in appearance order on the sealed chain). A sampled subset is the wrong ring (`r.length !== |J|`). Missing `admit_proof` fails. A repeated `spendTag` fails. Fail reason is `admit` (or `confidential` when the Pedersen kernel fails).

J is append-only: spent notes stay in J because Admit does not reveal which flowline moved. Double-spend is a repeated `spendTag`. Reorgs rebuild J and spent tags from the sealed chain. `jroot` is committed on the coinbase (`txs[0].jroot`), not the 128-byte header (ShearK 1.6 job template stays 128 bytes).

Reserve lock / vote / withdraw stay typed. Vault dest stays. Admit is not required to delete the vault. Dummy outs enter J as value-0 notes. Curve Trees (Campanelli, Hall-Andersen, Kamp, USENIX Security 23 / ePrint 2022/756) remain the named later accumulator; AdmitV2 is a breaking statement change.

## Auth

Shear spend-key / EIP-712 intent. Do not write "SA+L" unless that composition is actually used.

## Linkability

Shear native (dest / spend-tag as already specified). Not a Monero key-image unless copied on purpose.

## Consensus names

| Layer | Name |
|-------|------|
| Public / user copy | Admittance |
| Long form | Shear Admittance |
| Consensus / tx type | AdmitV1 |
| Module | shear-admit (`crypto/admit.js`) |
| Fingerprint | `ADMIT=AdmitV1` |

Flipping `ADMIT=AdmitV1` is a different book (`AdmitV2` on a breaking statement change).

## Forbidden in consensus / RPC / crate names

FCMP++, FCMP, FCMP+SA+L, FCMPpp, fcmp_pp, CurveTrees, curve_trees, Principia, Chronoflux, Chronoset, Chrono, Shear-proof, ShearTree, Vortice-membership.

Allowed in prose: "Admit instantiates Curve Trees." "Motivation is Chronoflux continuity."

Leave historical citations of Monero's upgrade as "Monero FCMP++" (external).

## Implementation notes (do not silently inherit Monero)

- Helios/Selene exist to tower Ed25519. If Shear's base curve is not Ed25519, pick a cycle for that field or accept a worse in-circuit hash. Do not ship Helios/Selene because Monero FCMP++ did.
- Tree grow/trim/reorg, reference height, and unlock rules are Shear consensus — write them under Admit. Do not import Monero's 10-block lock by osmosis.
- Reviews of Curve Trees / FCMP++ gadgets stay attributed to their authors (Cypher Stack / Veridise / etc.). They are not "Admit audits" until they cover Shear's statement.

If divisor gadgets or Parker leaf/SA+L split are used: cite Parker FCMP++ spec as prior art, then state how Admit's statement differs.
