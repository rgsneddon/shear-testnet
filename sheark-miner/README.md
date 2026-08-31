# ShearK-Miner 1.5

Official CPU miner for **ShearHash-v2** (RandomX light, 128 MiB cache).

- Display repo: **[Testnet] ShearK** (`rgsneddon/ShearK`)
- Wire algo: `ShearHash` · personalisation `ShearHash-v2` · magic `shear-testnet-v2`
- Banner: `ShearK-Miner 1.5 (ShearHash-v2 light)`
- Pool: `pool.shear.digital:1111`
- Header: 128 bytes. Light mode only. Do not recut Shear-Miner **1.1** / **1.0**. Submit includes the ShearHash-v2 digest.

```
ShearK-Miner --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --threads 8
```

`--print-config` includes `rxMode=light`, `rxCacheMiB=128`, `feePct=0`. `--selftest` must print digest `64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895` and must not match the v1 vector `5d00a242…`.

Windows zip root: `ShearK-Miner.exe` + `example.bat`. macOS zip root: `ShearK-Miner` + `example.sh`.

Build (from this tree, with `crypto/randomx` already vendored in the parent Shear repo):

```
make
./ShearK-Miner --selftest
```
