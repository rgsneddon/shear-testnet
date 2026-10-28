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
ShearK-Miner --pool stratum+ssl://pool.shear.digital:443 --user rig1 --blu YOUR_MINING_ADDRESS --backend jit-full
```

R28 BluNotes: `--blu` is the `shm1…` mining address your wallet shows ("This wallet mines"; checksummed, so a typo is refused; raw 128-hex B‖Y is accepted off mainnet only). Every share carries a fresh one-time key; the pool never learns a payout address, and a submit without a key is refused (`need_key`).

Solo, on your own node (`npm run solo`, cleartext stratum on 127.0.0.1:1111):

```
ShearK-Miner --pool 127.0.0.1:1111 --user rig1 --blu YOUR_MINING_ADDRESS --solo
```

`--solo` sends the mining address to your node at login so an empty round's pot is paid to a one-time key of it; without it the node refuses the login (`need_blu`). `--solo` without `--blu` exits 2. Never pass `--solo` to a public pool.

R28 option 2: `--user` is a worker name only (e.g. `rig1`). An address there exits 2, because it would be sent to the pool. `--dest` is retired. `YOUR_MINING_ADDRESS` is the `shm1…` string the wallet shows under "This wallet mines"; it never leaves the rig except with `--solo` to your own node.

Default `--backend jit-full` is the 260 MiB RandomX dataset (same ShearHash-v3 digest as light). Pool/node still light-verify. `--backend jit` is the 128 MiB cache path.

Speed (R41, measured with `sheark-miner/bench/`):
- **Threads.** With no `--threads`, ShearK measures the fastest thread count on first start (a short auto-tune, cached per device in `~/.config/sheark/tune.txt`, `%APPDATA%\ShearK\tune.txt` or `~/Library/Application Support/ShearK/tune.txt`, and re-measured when the CPU, limits or version change). It never goes above the CPUs it may use (affinity, cgroup quota), one per 2 MiB of L3, minus `--leave-free` (default 1 on a desktop or laptop with 4 or more CPUs). SMT siblings add RandomX throughput (+77% for a sibling pair on EPYC Milan). More threads than CPUs lose (8 threads on 2 CPUs: -31%). `--retune` measures again; `--no-tune` uses the ceiling.
- **Memory mode.** Full mode (`jit-full`, the 260 MiB dataset) when there is RAM for it (about 0.9 GiB with two datasets during a block change), otherwise light mode (`jit`); the banner says which and why. `--backend` overrides.
- **Thermal.** `--max-temp C` runs half the threads at C and one thread at C+3, and all again below C-5, where the OS exposes a CPU sensor.
- **Huge pages.** Reserved 2 MiB pages (hugetlb) are used when the OS has them. Without them, on Linux, the dataset, cache and scratchpads ask for transparent huge pages (`madvise`), which the default `madvise` THP mode grants: +12-20% over 4K pages. The miner never changes a system setting; reserving hugetlb pages (`vm.nr_hugepages`) or 1 GiB pages is the operator's choice.
- Every optimisation is byte-identical: `sheark-miner/tests/test_golden_corpus_v12.js` checks 64 digests from the R28 base on every backend.

Rig details and stats (R41) are **local only**. At start ShearK prints the device type, OS, CPU and its features, cores, SMT, P/E split, caches, NUMA nodes, clocks, memory, huge pages, RandomX mode, threads and why, and each thread's CPU. Anything it cannot detect reads `unknown` or `unavailable`. A stats table (H/s total and per thread over 10 s, 60 s and 15 min, per-thread idle %, shares with reject and stale reasons, job age, pool latency, the hash accounting `computed = reported = checked + discarded`, temperature) prints every `--stats-interval` seconds (default 60), when you type `s` and Enter, or on SIGUSR1. `--rig` prints the device details and exits. `--stats-file PATH` also writes the stats as JSON (opt-in). `--redact` masks the host name, home paths and IP addresses when you paste output for support. None of this is sent to the pool or anywhere else: the login and stats carry only the worker name, client version and hash counters (`tests/test_rig_privacy_v12.js` captures the traffic to prove it).

**Optional: huge and large pages (your choice; ShearK never sets these itself).** ShearK uses them when the system already provides them and falls back with a message when it does not. Nothing in the miner writes a system setting (`tests/test_no_system_settings_v12.js` guards that).
- Linux, transparent huge pages: most distributions default to `madvise`, which ShearK already uses. Check with `cat /sys/kernel/mm/transparent_hugepage/enabled`.
- Linux, reserved 2 MiB pages (a little faster again, and steadier): as root, `sysctl -w vm.nr_hugepages=400` (two 260 MiB datasets and 128 MiB caches while a block changes, plus 8 scratchpads; add 1 page per extra thread). Make it permanent in `/etc/sysctl.d/` if you want. The banner then shows `huge pages hugetlb`.
- Windows, large pages: give your account the "Lock pages in memory" right (Local Security Policy, `secpol.msc`, then Local Policies, User Rights Assignment), then sign out and back in. ShearK only switches the right on in its own process when you already hold it; it never grants it.
- 1 GiB pages, MSR tweaks and CPU governors are not used by ShearK.

**Phones are refused.** Mining overheats a phone and damages its battery, so ShearK will not run on Android (Termux or otherwise) or iOS/iPadOS. It checks local signals only (Android's environment and system files, the Termux prefix, the kernel), before it allocates anything or opens a connection, and exits with **exit code 86** and a message. There is no flag, setting or environment variable to override it. Raspberry Pi and other ARM boards, ARM servers, Apple Silicon Macs and ChromeOS Linux are not phones and run normally. Mine on a desktop, laptop or server.

On a new job or restamp (prev, merkle/continuity, bits, time, job id) the miner bumps its job generation and **aborts** in-flight hashes. Results for the old generation are dropped (`dropped`, debug `aborted_stale`) and are **not** counted as Rejected. Pool `stale` / `stale_job` is labelled `stale` on the console, not reject. Hashrate is counted hashes over the last 10 s of wall time (no smoothing); `round` / `proven_round` is accepted work this block and **may reset at block found**.

`--print-config` includes `rxMode=light`, `rxCacheMiB=128`, `feePct=0`. `--selftest` must print digest `e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4` and must not match the v1 vector `5d00a242…`.

Windows zip root: `ShearK-Miner.exe`, `example.bat`, `example.sh`, and the OpenSSL DLLs the exe imports (`libssl-3-x64.dll`, `libcrypto-3-x64.dll`, plus any further non-system DLL). The exe alone does not start. Unix zip root (`linux`, `archlinux`, `fedora`, `opensuse`, `macos`): `ShearK-Miner`, `example.bat`, `example.sh`, and that OS's OpenSSL libraries beside the binary. Each zip is built on that OS. How-to: the `[Testnet] ShearK` README.

Build (from this tree, with `crypto/randomx` already vendored in the parent Shear repo):

```
make
./ShearK-Miner --selftest
```
