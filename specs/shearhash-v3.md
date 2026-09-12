# ShearHash-v3 (RandomX-Shear-Lite)

Privacy-class book magic is `shear-testnet-v3`. Frozen `shear-testnet-v2` is a different book. Reset the datadir; do not load a v2 chain. Mainnet `shear-v1` is a later, separate genesis. Do not invent a genesis datetime.

ShearHash-v3 is the same RandomX light-mode parameterisation as v2 (128 MiB cache, on-the-fly dataset) with a new Argon salt and key personalisation so v2 digests cannot pretender. Coin numbers are unchanged: 90 s ASERT, 1 SHE pot PROP, hash unit 1, levy cap 0.001 SHE 50/50, no premine, no `setTip`.

Wire algorithm name: **ShearHash**. Personalisation: **ShearHash-v3**. Official miner: **ShearK-Miner**. ShearK implements this hash. The hash is not recut to match a miner.

v1 SHA-256 and v2 light digests mint nothing.

## Upstream

Vendored [tevador/RandomX](https://github.com/tevador/RandomX) **v1.2.3**. Tree `crypto/randomx/`. Parameters in `crypto/randomx/src/configuration.h`.

## Parameter table (consensus)

| define | value |
|--------|--------|
| RANDOMX_ARGON_SALT | `"ShearHash-v3/rx"` |
| RANDOMX_ARGON_MEMORY | 131072 (128 MiB, KiB) |
| RANDOMX_ARGON_ITERATIONS | 3 |
| RANDOMX_ARGON_LANES | 1 |
| RANDOMX_CACHE_ACCESSES | 8 |
| RANDOMX_PROGRAM_SIZE | 256 |
| RANDOMX_PROGRAM_ITERATIONS | 2048 |
| RANDOMX_PROGRAM_COUNT | 8 |
| RANDOMX_SCRATCHPAD_L3 | 2097152 |

Lite means no 2080 MiB DRAM dataset. Do not cut the Grover tax.

## Mode

Light only (`RANDOMX_FLAG_FULL_MEM` off). `jit-full` is a different digest and is not ShearHash-v3. If implementations disagree, the **light interpreter** wins. JIT mining is allowed iff it matches the interpreter on the selftest vector **and** on the submitted header. Pool/node verify light interpreter. `clientHashes` is not a digest.

## Key and input

Header is 128 bytes little-endian.

```
K     = first_32_bytes( SHA-512( "ShearHash-v3/key" || prev || continuity_root || merkle_root || bits_le32 ) )
input = the entire 128-byte header (including timestamp and nonce)
digest = RandomX_lite(K, input)
valid  iff leading-zero-bits(digest) >= shareBits (share) or blockBits (block)
```

`K` does not include timestamp or nonce, so a stratum restamp does not rebuild the cache. The digest **does** include timestamp and nonce. digest(H0) submitted against restamp H1 is `bad_hash`. A miner first/next pipeline must hash one exact header: abort the in-flight pair when time/bits/prev change.

Sealed-block shares use the frozen parent header, nonce replaced per share, no restamp (`specs/law.md`).

K field layout:

| bytes | source | header offset |
|------:|--------|----------------|
| 16 | ASCII `"ShearHash-v3/key"` (no NUL) | — |
| 32 | `prev_block_hash` | 4 |
| 32 | `continuity_root` | 68 |
| 32 | `merkle_root` | 36 |
| 4 | `bits` little-endian u32 | 108 |

## Fingerprint

```
HASH_FN=ShearHash-v3
RX_SALT=ShearHash-v3/rx
RX_MODE=light
RX_KEY=ShearHash-v3/key
```

plus the frozen RandomX sizes, 90 s, pot, hash-bonus 1, `HASH_TX_LIVE`, dest HRP `ssa`, spendable 6. Flipping any is a different book.

## Selftest vector

Header: byte 0 = `0x01`, 127 zero bytes.

| field | hex |
|-------|-----|
| K | `55111f0216ab10a6ba15fc0146990b10d26edcf58c86fa1418c41d96fa40b8e4` |
| digest | `98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b` |

Must fail:

- v1 `5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066`
- v2 `64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895`

## Datadir

v3 nodes must not load a v2 or v1 book. Reset `SHEAR_DATA` on cutover.

## Official miner

ShearK implements ShearHash-v3 light. Banner `ShearK-Miner 1.6 (ShearHash-v3 light)`. `--print-config` `personalisation=ShearHash-v3`, `rxMode=light`. Default `--backend jit` is light JIT + HARD_AES + huge pages. Never `jit-full` against this book.
