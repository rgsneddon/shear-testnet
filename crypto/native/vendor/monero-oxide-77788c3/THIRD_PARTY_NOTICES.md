# Third-party notices

Shear vendors the full-chain membership crates below from
[monero-oxide](https://github.com/monero-oxide/monero-oxide) commit
`77788c368145127f2dde2ac3e2ddce919f3ddd01`
(crypto tree `6ba344ad5412c103dab278845a8b418886fdd3d5`).

Each crate keeps the upstream `LICENSE` file beside its source. Those files
are the licence terms. This notice names the crate, the licence, and the
copyright holders copied from those files. Shear shows this notice on its
site at launch.

`monero-fcmp-plus-plus` and `monero-fcmp-plus-plus-generators` are not
imported.

The adaptation crate `shear-fs1` is Shear code. It is not wired into
consensus.

## Vendored crates

| Crate | Path | Licence | Copyright |
| --- | --- | --- | --- |
| helioselene | `helioselene/` | MIT | Copyright (c) 2022-2025 Luke Parker |
| ec-divisors | `divisors/` | MIT | Copyright (c) 2023-2025 Luke Parker |
| generalized-bulletproofs | `generalized-bulletproofs/` | MIT | Copyright (c) 2021-2025 Luke Parker. Copyright (c) 2025 monero-oxide Developers |
| full-chain-membership-proofs | `fcmps/` | MIT | Copyright (c) 2024-2025 Luke Parker |
| generalized-bulletproofs-circuit-abstraction | `fcmps/circuit-abstraction/` | MIT | Copyright (c) 2024-2025 Luke Parker |
| generalized-bulletproofs-ec-gadgets | `fcmps/ec-gadgets/` | MIT | Copyright (c) 2024-2025 Luke Parker |

## Pinned crates.io crate

`multiexp` version `0.5.2` is not vendored as source. `shear-fs1` depends on
it as `multiexp = "=0.5.2"`. The vendored FCMP crates accept the `0.5` line,
and the lockfile resolves them to this same version.

| Crate | Version | Licence | Copyright |
| --- | --- | --- | --- |
| multiexp | 0.5.2 | MIT | Copyright (c) 2022-2026 Serai Contributors |

The crate author recorded on crates.io is Luke Parker.
