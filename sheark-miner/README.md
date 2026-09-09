# ShearK-Miner 1.6

Official CPU miner for **ShearHash-v3** (RandomX light, 128 MiB cache).

- Display repo: **[Testnet] ShearK** (`rgsneddon/ShearK`)
- Wire algo: `ShearHash` · personalisation `ShearHash-v3` · magic `shear-testnet-v2`
- Banner: `ShearK-Miner 1.6 (ShearHash-v3 light)`
- Pool: `pool.shear.digital:1111`
- Header: 128 bytes. Light mode only. Do not recut Shear-Miner **1.1** / **1.0**. Submit includes the ShearHash-v3 digest.

```
ShearK-Miner --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --dest YOUR_SSA1 --backend jit --threads 8
```

Default `--backend jit` is ShearHash-v3 light JIT + HARD_AES + huge pages (fallback to 4K if huge pages fail). Do not use `jit-full` against this pool: FULL_MEM hashes fail light verify.

`--print-config` includes `rxMode=light`, `rxCacheMiB=128`, `feePct=0`. `--selftest` must print digest `64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895` and must not match the v1 vector `5d00a242…`.

Windows zip root: `ShearK-Miner.exe` + `example.bat`. macOS zip root: `ShearK-Miner` + `example.sh`.

Build (from this tree, with `crypto/randomx` already vendored in the parent Shear repo):

```
make
./ShearK-Miner --selftest
```
