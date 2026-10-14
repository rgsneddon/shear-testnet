# FS-1 generators

Status: **pending PA+CA ratification**. This set is not a ratified consensus set.

The points below are the set `Fs1Params::fixed` already uses. Nothing here changes a point. A different derivation would break existing proofs.

## Procedure

The domain separator is the ASCII label `shear-fs1-generators-v1` (`GENERATOR_DST` in `shear-fs1/src/generators.rs`).

`G` is the Ed25519 basepoint. A Shear `admitPub = x·G` on Ristretto maps to `x·G` on this curve.

Every other point is try-and-increment rejection sampling on a compressed encoding. This is not RFC 9380 and not Elligator. For `ctr = 0, 1, ...`:

```text
h = Blake2b-512(DST || 0x00 || curve || 0x00 || label || u32le(index) || u32le(ctr))
```

The first 32 bytes of `h` are read as a compressed point on `curve`. The first `ctr` that decodes to a non-identity point wins. On Ed25519 that point is multiplied by the cofactor 8, so the result has prime order. Selene and Helios have cofactor 1, so the decoded point is used as-is.

No discrete log between any two of these points is known.

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

1. `G`, `T`, `U`, `V`
2. Selene `g`, `h`, `init`, every `g_bold`, every `h_bold`
3. Helios `g`, `h`, `init`, every `g_bold`, every `h_bold`

The digest, and the compressed bytes of `T`, `U`, `V`, `selene_init`, and `helios_init`, are pinned in `crypto/native/vendor/monero-oxide-77788c3/shear-fs1/vectors/generators.txt`. The digest commits to every bold point as well. The test recomputes each one and asserts equality with the set those vectors name.

## Reproduce

From the repository root:

```sh
crypto/native/vendor/monero-oxide-77788c3/shear-fs1/scripts/recompute_generators.sh
```

The script runs `cargo run --release --bin fs1_generators`. That binary builds `Fs1Params::fixed`, recomputes every point from the labels above, and checks `vectors/generators.txt`. On success it prints `pending PA+CA ratification` and the digest. A mismatch exits 1. The release profile does not change the points.

The same check is `every_generator_recomputes_to_the_pinned_set` in `shear-fs1/src/generators.rs`:

```sh
cargo test -p shear-fs1 --lib every_generator_recomputes_to_the_pinned_set -- --exact
```

Run that `cargo` command from `crypto/native/vendor/monero-oxide-77788c3`, where the workspace manifest lives.
