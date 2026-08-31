# ShearHash-v2 (RandomX-Shear-Lite)

Testnet only. New book `shear-testnet-v2`. Do not merge into live `shear-testnet-v1` until every gate is green and the operator explicitly says cut over. Mainnet `shear-v1` is a later, separate genesis.

ShearHash-v2 is a RandomX light-mode parameterisation (128 MiB cache, salt ShearHash-v2/rx, key bound to continuity_root). Grover still applies. Mitigation is oracle cost (VM, scratchpad writes, 64-bit multiplies, on-the-fly SuperscalarHash), not immunity.

Wire algorithm name: **ShearHash**. Personalisation: **ShearHash-v2**. Official miner: **ShearK-Miner** (repo display **[Testnet] ShearK**). Do not recut Shear-Miner **1.1** / **1.0**.

v1 8-round SHA-256 shares mint nothing after cutover.

## Upstream

Vendored [tevador/RandomX](https://github.com/tevador/RandomX) **v1.2.3** (`PROGRAM_SIZE` 256). Not RandomX v2 / 384-op programs.

- Commit: `12f2c2ffe2108d6cf54c391fee33c8bc3646cdab`
- License: BSD (see `crypto/randomx/LICENSE`)
- Tree: `crypto/randomx/`
- Parameters: `crypto/randomx/src/configuration.h` (upstream defaults saved as `configuration.upstream.h`)

## Parameter table (consensus)

| define | value |
|--------|--------|
| RANDOMX_ARGON_SALT | `"ShearHash-v2/rx"` |
| RANDOMX_ARGON_MEMORY | 131072 (128 MiB, KiB) |
| RANDOMX_ARGON_ITERATIONS | 3 |
| RANDOMX_ARGON_LANES | 1 |
| RANDOMX_CACHE_ACCESSES | 8 |
| RANDOMX_SUPERSCALAR_LATENCY | 170 |
| RANDOMX_DATASET_BASE_SIZE | 268435456 (256 MiB virtual; not a DRAM copy in light mode) |
| RANDOMX_DATASET_EXTRA_SIZE | 4194304 |
| RANDOMX_PROGRAM_SIZE | 256 |
| RANDOMX_PROGRAM_ITERATIONS | 2048 |
| RANDOMX_PROGRAM_COUNT | 8 |
| RANDOMX_SCRATCHPAD_L1 | 16384 |
| RANDOMX_SCRATCHPAD_L2 | 262144 |
| RANDOMX_SCRATCHPAD_L3 | 2097152 |
| RANDOMX_JUMP_BITS | 8 |
| RANDOMX_JUMP_OFFSET | 8 |

Do not cut program count, program iterations, program size, scratchpad L3, Argon iterations, or cache-accesses. Those are the Grover tax. Lite means drop the 2080 MiB DRAM dataset copy, not the VM.

Salt must differ from `"RandomX\x03"`.

## Mode

Mining and verification use **light mode only** (`RANDOMX_FLAG_FULL_MEM` off). Fast-mode dataset precompute is not consensus. If two implementations disagree, the **light-mode interpreter** digest wins. JIT is allowed for mining iff it matches the interpreter on the selftest vector.

## Key and input

Header is the frozen 128-byte little-endian testnet header (do not change size).

```
K     = first_32_bytes( SHA-512( "ShearHash-v2/key" || prev || continuity_root || merkle_root || bits_le32 ) )
input = full 128-byte header including nonce
digest = RandomX_lite(K, input)     # 32 bytes, Blake2b as in RandomX
valid  iff be256(digest) <= target(bits)
```

Field layout in K (not header order):

| bytes | source | header offset |
|------:|--------|----------------|
| 16 | ASCII `"ShearHash-v2/key"` (no NUL) | — |
| 32 | `prev_block_hash` | 4 |
| 32 | `continuity_root` | 68 |
| 32 | `merkle_root` | 36 |
| 4 | `bits` little-endian u32 | 108 |

K rebuilds every block from sealed header fields except nonce. Cache init from K once per block template; threads share that cache. Nonce only walks `input`. Do not put miner id, login, or pool job-id into K or input.

## Fingerprint strings (frozen identity)

Add to `consensusFingerprint()` / `consensusLaw()`:

```
HASH_FN=ShearHash-v2
RX_SALT=ShearHash-v2/rx
RX_ARGON_MEMORY=131072
RX_ARGON_ITERS=3
RX_CACHE_ACCESSES=8
RX_PROGRAM_SIZE=256
RX_PROGRAM_ITERATIONS=2048
RX_PROGRAM_COUNT=8
RX_SCRATCHPAD_L3=2097152
RX_MODE=light
RX_KEY=ShearHash-v2/key
```

Flipping any of those is a different book, not a config flag. Keep existing pins: `BOOK_LAW_ID`, 90 s, pot nanos, hash-bonus nanos, `HASH_TX_LIVE`, collate, confirm-on-block, miner-mint-only, dest HRP, spendable 6.

Live testnet magic for this book: `shear-testnet-v2`. Frozen old chain id: `shear-testnet-v1`.

## Selftest vector

Selftest header: 128 zero bytes with `version` u32le = 1 (byte 0 = `0x01`). Same shape as the v1 miner selftest header.

| field | hex |
|-------|-----|
| header | `01` then 127 zero bytes (`version` u32le = 1) |
| K | `e46e00191cde74015961b7a68274933c680b69f05bdbbad1ef51e75fbc19f389` |
| digest | `64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895` |

The v1 digest `5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066` **must fail** under v2.

## v1 shares

After cutover, v1 8-round SHA-256 shares mint **0**. Pool and node reject a header whose v2 digest misses the share target, including any v1-shaped pretender hash.

## Datadir

v2 nodes must not load the v1 book.

- Default: `~/.shear/testnet-v2`
- Germany: `/var/lib/shear/testnet-v2`

## Official miner

**ShearK-Miner** `1.4` (two-part). Banner: `ShearK-Miner 1.4 (ShearHash-v2 light)`. Submit carries the ShearHash-v2 digest. One share in flight; `busy` is retried. A timestamp restamp does not rebuild RandomX K.

`--print-config` includes `algorithm=ShearHash`, `personalisation=ShearHash-v2`, `headerBytes=128`, `rxMode=light`, `rxCacheMiB=128`, `feePct=0`, `magic=shear-testnet-v2`. Do not write “feeless”.

Shipped from GitHub **[Testnet] ShearK** (`rgsneddon/ShearK`). Do not attach these zips to `rgsneddon/shear` or recut Shear-Miner tags `1.1` / `1.0` on `shear-testnet`.

## Bench (filled after C)

| measure | value |
|---------|--------|
| H/s per laptop thread (interpreter, includes first-hash cache) | ~3 H/s (`ShearK-Miner --backend interpreter --bench 3` on Darwin arm64) |
| H/s per laptop thread (JIT) | ~48 H/s cold / ~144 H/s after cache (`--backend jit --bench 3`) |
| ms per node verify (warm cache, interpreter) | ~150–500 ms (target &lt; 200 ms warm; first share of a new K pays Argon2) |
| ms cold Argon2 cache init (128 MiB × 3) | ~500–2000 ms (do not cut locked #defines to chase this) |
