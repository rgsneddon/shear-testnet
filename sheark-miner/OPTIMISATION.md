# ShearK-Miner optimisation (R41)

Russell, 28 Oct 2026. Goal: the fastest, most stable ShearHash-v3 miner on every platform Shear ships, with no consensus change.

## Rules

- **Byte-identical.** Every digest, RandomX key, one-time key and nonce binding matches the reference. The golden vectors run on every build:
  - `sheark-miner/tests/test_sha512_fips_v12.js`: FIPS 180-4 SHA-512 (R40) and `shear_key`, C against a node:crypto derivation;
  - `sheark-miner/tests/test_blunote_vectors_v12.js`: R28 one-time keys and binding, C against JS;
  - `crypto/shear_hash.test.js`: selftest, interpreter against JIT;
  - `sheark-miner/tests/test_miner.js`: selftest, `--verify`, `--print-config`.
- **Nothing that moves a pin.** If a speed-up needs an algorithm, pin or share-format change, it is written up as a proposal, not coded.
- **Privacy unchanged.** `--blu` and `--solo` behave as in R28, with no telemetry or phone-home, and nothing new reaches a pool.
- **Measured.** A change stays only if it shows a measured gain on at least one shipped platform, no loss on the others, and no failed vector.

## Where ShearK stands at the R28 base (269a0893)

- RandomX flags come from `randomx_get_flags()` at run time: JIT, hardware AES, and Argon2 SSSE3/AVX2.
- The interpreter is the fallback when JIT allocation fails. Apple aarch64 uses `RANDOMX_FLAG_SECURE`.
- Large pages are tried first, falling back to 4K with a message.
- `--backend jit-full` uses the 260 MiB dataset (RANDOMX_DATASET_BASE_SIZE 256 MiB + 4 MiB extra), the same digest as light.
- Threads are pinned (`pthread_setaffinity_np`, `g_cpu_map`).
- Release builds target the x86-64 baseline (`-march=x86-64`). `SHEARK_NATIVE=1` is a local opt-in only.

## Method

1. **Baseline.** `sheark-miner/bench/` records CPU model, flags, OS, cores, L3 and huge-page state. It measures H/s per thread and per core, watts where RAPL or powercap is readable, and share accept rate and latency against a local regtest stratum. Hosts: idle agent-box, pool, p2p-a and p2p-b, and the Windows pack (CI runner).
2. **Profile** with `perf` on Linux: the RandomX VM, dataset init, `shear_key`, nonce binding and stratum I/O.
3. **Optimise in order of measured gain.** Each change is one commit, with its before/after numbers and its vector run in the commit message.
4. **Soak** for 12 h or more on the soak hosts, then a before/after table per host in the PR's Review section.
