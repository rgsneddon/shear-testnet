# ShearK-Miner 2.9

Official CPU miner for **ShearHash-v3** (RandomX light, 128 MiB cache). TLS-aware stratum. Not a quiet rebuild of 2.6 or 2.8.

- Display repo: **[Testnet] ShearK** (`rgsneddon/ShearK`)
- Wire algo: `ShearHash` · personalisation `ShearHash-v3` · magic `shear-testnet-v12`
- Banner: `ShearK-Miner 2.9 (ShearHash-v3 light)`
- The v12 pool refuses a ShearK older than 2.9 and names the required version.
- Difficulty comes from the pool job. A job with no share width or no block width is not mined.
- `run-afk.sh`, `sheark-v4-afk.default`, and `deploy/sheark-v4-afk.service` are the v12 defaults. The unit reads `SHEARK_USER` from the host file. Keep each host's worker name and payout address. The pool host keeps the unit disabled.
- Public pool: `stratum+ssl://pool.shear.digital:443` (443 is the reachable edge; the pool process TLS port 1113 does not receive public SYNs)
- Localhost solo: `stratum+tcp://127.0.0.1:1111` (cleartext only when you ask for it)
- Header: 128 bytes. Light mode only. Do not recut Shear-Miner **1.1** / **1.0**. Submit includes the ShearHash-v3 digest.

The login is a worker name; payment goes to one-time keys of your mining address (R28 BluNotes, below), so nothing that names your wallet reaches a pool. The 128-byte job is unchanged.

```
ShearK-Miner --pool stratum+ssl://pool.shear.digital:443 --user rig1 --blu YOUR_MINING_ADDRESS --backend jit-full --threads 8
```

R28 BluNotes: `--blu` is the `shm1…` mining address your wallet shows ("This wallet mines"; checksummed, so a typo is refused; raw 128-hex B‖Y is accepted off mainnet only). Every share carries a fresh one-time key; the pool never learns a payout address, and a submit without a key is refused (`need_key`).

Solo, on your own node (`npm run solo`, cleartext stratum on 127.0.0.1:1111):

```
ShearK-Miner --pool 127.0.0.1:1111 --user rig1 --blu YOUR_MINING_ADDRESS --solo --threads 8
```

`--solo` sends the mining address to your node at login so an empty round's pot is paid to a one-time key of it; without it the node refuses the login (`need_blu`). `--solo` without `--blu` exits 2. Never pass `--solo` to a public pool.

R28 option 2: `--user` is a worker name only (e.g. `rig1`). An address there exits 2, because it would be sent to the pool. `--dest` is retired. `YOUR_MINING_ADDRESS` is the `shm1…` string the wallet shows under "This wallet mines"; it never leaves the rig except with `--solo` to your own node.

Default `--backend jit-full` is the 2 GiB RandomX dataset (same ShearHash-v3 digest as light). Pool/node still light-verify. `--backend jit` is the 128 MiB cache path. Huge pages fall back to 4K if unavailable.

On a new job or restamp (prev, merkle/continuity, bits, time, job id) the miner bumps its job generation and **aborts** in-flight hashes. Results for the old generation are dropped (`dropped`, debug `aborted_stale`) and are **not** counted as Rejected. Pool `stale` / `stale_job` is labelled `stale` on the console, not reject. Hashrate is a time-window / EMA; `round` / `proven_round` is accepted work this block and **may reset at block found**.

`--print-config` includes `rxMode=light`, `rxCacheMiB=128`, `feePct=0`. `--selftest` must print digest `e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4` and must not match the v1 vector `5d00a242…`.

Windows zip root: `ShearK-Miner.exe`, `example.bat`, `example.sh`, and the OpenSSL DLLs the exe imports (`libssl-3-x64.dll`, `libcrypto-3-x64.dll`, plus any further non-system DLL). The exe alone does not start. Unix zip root (`linux`, `archlinux`, `fedora`, `opensuse`, `macos`): `ShearK-Miner`, `example.bat`, `example.sh`, and that OS's OpenSSL libraries beside the binary. Each zip is built on that OS. How-to: the `[Testnet] ShearK` README.

Build (from this tree, with `crypto/randomx` already vendored in the parent Shear repo):

```
make
./ShearK-Miner --selftest
```
