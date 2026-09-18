# ShearK-Miner 2.4

Official CPU miner for **ShearHash-v3** (RandomX light, 128 MiB cache).

- Display repo: **[Testnet] ShearK** (`rgsneddon/ShearK`)
- Wire algo: `ShearHash` · personalisation `ShearHash-v3` · magic `shear-testnet-v4`
- Banner: `ShearK-Miner 2.4 (ShearHash-v3 light)`
- Pool: `pool.shear.digital:1111`
- Header: 128 bytes. Light mode only. Do not recut Shear-Miner **1.1** / **1.0**. Submit includes the ShearHash-v3 digest.

Paid login is an owned `ssa1` dest (wallet **Copy dest**). Copy dest is dest20-sized (~43 chars); long dest20||B still verifies. 2.3 dest-binds both; 2.1 fails the long form (`low_diff`). Each hasher dest that produced proven work receives its own hash bonus on the next sealed block. Share floor is dest-bound (`sha256("shear-share-dest-v1" || rx || noteCommit)`), so a pool cannot restamp dest on a stolen nonce. The 128-byte job is unchanged.

```
ShearK-Miner --pool pool.shear.digital:1111 --user YOUR_SSA1.worker --backend jit-full --threads 8
```

A `she1` login needs `--dest YOUR_SSA1` so the bonus can land on Copy dest. Rest-frame `shear1` stays off stratum.

Default `--backend jit-full` is the 2 GiB RandomX dataset (same ShearHash-v3 digest as light). Pool/node still light-verify. `--backend jit` is the 128 MiB cache path. Huge pages fall back to 4K if unavailable.

On a new job or restamp (prev, merkle/continuity, bits, time, job id) the miner bumps its job generation and **aborts** in-flight hashes. Results for the old generation are dropped (`dropped`, debug `aborted_stale`) and are **not** counted as Rejected. Pool `stale` / `stale_job` is labelled `stale` on the console, not reject. Hashrate is a time-window / EMA; `round` / `proven_round` is accepted work this block and **may reset at block found**.

`--print-config` includes `rxMode=light`, `rxCacheMiB=128`, `feePct=0`. `--selftest` must print digest `98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b` and must not match the v1 vector `5d00a242…`.

Windows zip root: `ShearK-Miner.exe` + `example.bat`. Linux zip root: `ShearK-Miner` + `example.sh`. How-to: the `[Testnet] ShearK` README.

Build (from this tree, with `crypto/randomx` already vendored in the parent Shear repo):

```
make
./ShearK-Miner --selftest
```
