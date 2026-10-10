# ShearK-Miner 2.9

Official CPU miner for **ShearHash-v3** (RandomX light, 128 MiB cache). TLS-aware stratum. Not a quiet rebuild of 2.6 or 2.8.

- Display repo: **[Testnet] ShearK** (`rgsneddon/ShearK`)
- Wire algo: `ShearHash` · personalisation `ShearHash-v3` · magic `shear-testnet-v12`
- Banner: `ShearK-Miner 2.9 (ShearHash-v3 light)`
- The v12 pool refuses a ShearK older than 2.9 and names the required version.
- Difficulty comes from the pool job. A job with no share width or no block width is not mined.
- `sheark-v4-afk` is not in this tree. Point that unit at this binary. Keep each host's worker name and payout address.
- Public pool: `stratum+ssl://pool.shear.digital:443` (443 is the reachable edge; the pool process TLS port 1113 does not receive public SYNs)
- Localhost solo: `stratum+tcp://127.0.0.1:1111` (cleartext only when you ask for it)
- Header: 128 bytes. Light mode only. Do not recut Shear-Miner **1.1** / **1.0**. Submit includes the ShearHash-v3 digest.

Paid login is an owned `ssa1` dest (wallet **Copy dest**). Copy dest is dest20-sized (~43 chars); long dest20||B still verifies. 2.3 dest-binds both; 2.1 fails the long form (`low_diff`). Each hasher dest that produced proven work receives its own hash bonus on the next sealed block. Share floor is dest-bound (`sha256("shear-share-dest-v1" || rx || noteCommit)`), so a pool cannot restamp dest on a stolen nonce. The 128-byte job is unchanged.

```
ShearK-Miner --pool stratum+ssl://pool.shear.digital:443 --user YOUR_SSA1.worker --backend jit-full --threads 8
```

A `she1` login needs `--dest YOUR_SSA1` so the bonus can land on Copy dest. Rest-frame `shear1` stays off stratum.

Default `--backend jit-full` is the 2 GiB RandomX dataset (same ShearHash-v3 digest as light). Pool/node still light-verify. `--backend jit` is the 128 MiB cache path. Huge pages fall back to 4K if unavailable.

On a new job or restamp (prev, merkle/continuity, bits, time, job id) the miner bumps its job generation and **aborts** in-flight hashes. Results for the old generation are dropped (`dropped`, debug `aborted_stale`) and are **not** counted as Rejected. Pool `stale` / `stale_job` is labelled `stale` on the console, not reject. Hashrate is a time-window / EMA; `round` / `proven_round` is accepted work this block and **may reset at block found**.

`--print-config` includes `rxMode=light`, `rxCacheMiB=128`, `feePct=0`. `--selftest` must print digest `98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b` and must not match the v1 vector `5d00a242…`.

Windows zip root: `ShearK-Miner.exe`, `example.bat`, `example.sh`, and the OpenSSL DLLs the exe imports (`libssl-3-x64.dll`, `libcrypto-3-x64.dll`, plus any further non-system DLL). The exe alone does not start. Unix zip root (`linux`, `archlinux`, `fedora`, `opensuse`, `macos`): `ShearK-Miner`, `example.bat`, `example.sh`, and that OS's OpenSSL libraries beside the binary. Each zip is built on that OS. How-to: the `[Testnet] ShearK` README.

Build (from this tree, with `crypto/randomx` already vendored in the parent Shear repo):

```
make
./ShearK-Miner --selftest
```
