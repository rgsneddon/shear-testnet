# FS-1 generators

Status: **pending PA+CA ratification**. This set is not a ratified consensus set.

The points below are the set `spend_params` already uses. Nothing here changes a point. The domain `shear-fs1-generators-v1` is version-bound: the same points on every network. That is the recorded decision.

## Roles

`G` in the spend proof is only the FCMP commitment blind. Spend auth uses `B`.

Shear's note blinding generator `H` is a Ristretto255 point:

```text
H = from_uniform_bytes(SHA-512("shear-bpplus-v2" || "shear-note-H-v1"))
```

`from_uniform_bytes` is the Ristretto map. The compressed encoding of `H` is pinned in `crypto/native/vendor/monero-oxide-77788c3/shear-fs1/vectors/note_h.txt`.

`E` maps that encoding onto Ed25519 (`ristretto_to_ed` in `shear-fs1/src/leaf.rs`). It rejects a representative with an odd `s`, decodes the Edwards point, and clears the cofactor: `E(P) = 8⁻¹·(8·P)`. `E(H)` is the proof's `G`. Its compressed Ed25519 encoding begins `132ba4e1`.

`B` is the Ed25519 basepoint. SA+L multiplies the spend secret by `B`. `B` is not the commitment blind.

`T`, `U`, and `V` stay on the Blake2b try-and-increment derivation below. Spec 100c §1.5.1 still names a different SHA-512 derivation of `T`. Amending that section is pending Russell's ruling. This file does not change the points.

No discrete log among `{B, E(H), T, U, V}` is known.

## Procedure

The domain separator is the ASCII label `shear-fs1-generators-v1` (`GENERATOR_DST` in `shear-fs1/src/generators.rs`).

`T`, `U`, `V`, and every Selene and Helios point are try-and-increment rejection sampling on a compressed encoding. This is not RFC 9380 and not Elligator. For `ctr = 0, 1, ...`:

```text
h = Blake2b-512(DST || 0x00 || curve || 0x00 || label || u32le(index) || u32le(ctr))
```

The first 32 bytes of `h` are read as a compressed point on `curve`. The first `ctr` that decodes to a non-identity point wins. On Ed25519 that point is multiplied by the cofactor 8, so the result has prime order. Selene and Helios have cofactor 1, so the decoded point is used as-is.

`Fs1Params::fixed` still stores the Ed25519 basepoint in its `g` field, for callers that build a membership parameter struct from the curve points alone. `spend_params` replaces that field with `E(H)`. The pinned digest is `generators_digest` of `spend_params`, which also hashes `B`.

## Labels

| Curve | Label | Index |
| --- | --- | --- |
| `ed25519` | `T`, `U`, `V` | 0 |
| `selene` | `g`, `h`, `init` | 0 |
| `selene` | `g_bold`, `h_bold` | `0 .. 2048` |
| `helios` | `g`, `h`, `init` | 0 |
| `helios` | `g_bold`, `h_bold` | `0 .. 1024` |

The row counts are `Fcmp::ipa_rows(8, 7)`: 2,048 on Selene and 1,024 on Helios. That is enough for 8 inputs at tree depth 7, which is the consensus maximum.

## Digest

`generators_digest` is Blake2b-512 over `DST` and then every compressed point, in this order:

1. `E(H)`, the proof's `G`
2. `B`, the Ed25519 basepoint
3. `T`, `U`, `V`
4. Selene `g`, `h`, `init`, every `g_bold`, every `h_bold`
5. Helios `g`, `h`, `init`, every `g_bold`, every `h_bold`

The digest, and the compressed bytes of `G` (`E(H)`), `B`, `T`, `U`, `V`, `selene_init`, and `helios_init`, are pinned in `crypto/native/vendor/monero-oxide-77788c3/shear-fs1/vectors/generators.txt`. The digest commits to every bold point as well. The test recomputes each one and asserts equality with the set those vectors name.

## Reproduce

From the repository root:

```sh
crypto/native/vendor/monero-oxide-77788c3/shear-fs1/scripts/recompute_generators.sh
```

The script runs `cargo run --release --bin fs1_generators`. That binary builds `spend_params`, recomputes `E(H)` and every labelled point, checks `B`, and checks `vectors/generators.txt`. On success it prints `pending PA+CA ratification` and the digest. A mismatch exits 1. The release profile does not change the points.

The same check is `generators::tests::every_generator_recomputes_to_the_pinned_set` in `shear-fs1/src/generators.rs`. `commitment_blind_recomputes_independently` derives `E(H)` from the SHA-512 label on its own and checks the `132ba4e1` prefix.

```sh
cargo test -p shear-fs1 --lib generators::tests::every_generator_recomputes_to_the_pinned_set -- --exact
```

Run that `cargo` command from `crypto/native/vendor/monero-oxide-77788c3`, where the workspace manifest lives.
