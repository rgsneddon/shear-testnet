# v12 distro packs

Packs for the testnet-v12 soak. Build them with `scripts/packaging/build-all.sh`. The script does not tag, deploy, SSH, or cut genesis. Tarballs and `SHA256SUMS` are written under `scripts/packaging/out/` and are not committed.

Each image builds from this tree, on that distro:

- Shear Sentinel v19 (product pin 19.0), including `shearhash.node` and `shearadmit.node`
- ShearK 2.9
- Wallet CLI 0.72
- Wallet desktop 0.72 (GTK), for an operator machine on that distro

`crypto/native/admit` depends on zeroize 1.9, which needs Rust edition 2024. Every image runs `rustup update stable` before `cargo build --locked`. RandomX is built with `-DARCH=default` (not `-march=native`).

| Pack | Base image |
| --- | --- |
| Ubuntu LTS | `ubuntu:26.04` |
| Debian stable | `debian:13` (trixie) |
| Fedora | `fedora:44` |
| openSUSE Leap | `opensuse/leap:16.1` |

Node inside the pack is the official Node.js 22.23.3 linux-x64 tarball. Flutter is 3.47.7 (Dart 3.13.5), which satisfies the wallet SDK constraint `^3.12.2`.

## Hosts

Confirm `/etc/os-release` on the host before extracting. Install only the pack built for that distro. `178.105.75.124` was a Fedora soak address in older notes; for this soak it is opensuse-p2p.

| Host | Address | Distro | Pack id | Miner |
| --- | --- | --- | --- | --- |
| fedora-p2p | 2.31.49.23 | Fedora 44 | `fedora` | yes |
| debian-p2p | 89.167.98.124 | Debian 13 stable | `debian` | yes |
| opensuse-p2p | 178.105.75.124 | openSUSE Leap 16.1 | `opensuse` | yes |
| p2p-a | 157.180.70.110 | Ubuntu 26.04 LTS | `ubuntu` | yes |
| p2p-b | 2.28.8.89 | Ubuntu 26.04 LTS | `ubuntu` | yes |
| shear-pool | 77.42.91.84 | unchanged | none | no |

p2p-a and p2p-b are the two soak hosts whose names are not a distro. They share the Ubuntu LTS pack. The pool stays where it is and never mines. Do not enable `sheark-miner.service` there. Do not install a miner on `p2p-d`, and do not use the deleted soak addresses `2.28.39.91` or the old Fedora role of `178.105.75.124`.

## Install

On the matching host, as root, after `sha256sum -c SHA256SUMS` in the directory that holds that distro's tarballs:

```bash
install -d -m 0755 /opt/shear-v12 /var/lib/shear/testnet-v12
tar -xzf shear-node-v19-<distro>.tar.gz -C /opt/shear-v12
tar -xzf ShearK-Miner-2.9-<distro>.tar.gz -C /opt/shear-v12
tar -xzf shear-wallet-0.72-<distro>-cli.tar.gz -C /opt/shear-v12
# Optional GUI. The host needs the distro GTK 3 and libsecret packages.
# tar -xzf shear-wallet-0.72-<distro>-desktop.tar.gz -C /opt/shear-v12

install -m 0644 /opt/shear-v12/share/systemd/shear-sentinel.service /etc/systemd/system/shear-sentinel.service
install -m 0644 /opt/shear-v12/share/systemd/sheark-miner.service /etc/systemd/system/sheark-miner.service
install -m 0600 /opt/shear-v12/share/sheark-miner.default.example /etc/default/sheark-miner
```

Edit `/etc/default/sheark-miner` on that host. Set `SHEARK_USER` to the host's existing worker login. Do not commit the filled file. `sheark-run` refuses an empty user and the placeholder `YOUR_SSA1.worker`.

Replace `<distro>` with `ubuntu`, `debian`, `fedora`, or `opensuse`. p2p-a and p2p-b both use `ubuntu`.

Check the binaries before enabling units:

```bash
/opt/shear-v12/bin/node --version
/opt/shear-v12/bin/ShearK-Miner --selftest
/opt/shear-v12/bin/shear version
/opt/shear-v12/bin/node /opt/shear-v12/node/src/node.js --print-config
```

`ShearK-Miner --selftest` must print `e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4` (R40, 28 Oct: FIPS 180-4 SHA-512 key; builds before R40 printed `98818c31…`). `shear version` must print pin `0.72` and magic `shear-testnet-v12`. `--print-config` must show `Shear Sentinel v19`.

Desktop runtime packages, only if the GUI tarball is extracted:

| Distro | Packages |
| --- | --- |
| Ubuntu, Debian | `libgtk-3-0 libsecret-1-0 libsodium23` (or `libsodium26` if that is the soname on the host) |
| Fedora | `gtk3 libsecret libsodium` |
| openSUSE Leap | `gtk3 libsecret libsodium` |

The CLI does not need GTK. Soak hosts can skip the desktop tarball.

### Units

```bash
systemctl daemon-reload
systemctl enable --now shear-sentinel.service
systemctl enable --now sheark-miner.service
```

Run the miner enable only on the five p2p hosts, and only after the checklist below. On `77.42.91.84`:

```bash
systemctl disable --now sheark-miner.service
```

Do not start a miner there. Leave the pool datadir alone.

`shear-sentinel.service` listens on `:30303` and binds RPC to `127.0.0.1:18332`. Seeds in the unit are hostnames (`p2p.shear.digital`, `r2r.shear.digital`, `b2b.shear.digital`). The datadir is `/var/lib/shear/testnet-v12`, a new directory for this soak, not a copy of a v11 chain.

## Soak pre-flight

Do not start the soak clock from this document. There is no soak stamp here. Candle Count is not reset here.

1. `V12_GENESIS_BLOCK_HASH` in the packed `node/src/chain.js` is still empty on this branch. Do not enable `shear-sentinel.service` against a live book until that pin is filled on a later tip and the node pack is rebuilt from that tip. This tree does not cut genesis.
2. No `v19`, `0.72`, or ShearK tag is cut from these packs. Do not move `0.70`, `0.71`, or `v18`.
3. `sha256sum -c SHA256SUMS` passes for the distro you are installing.
4. `/etc/os-release` matches the pack id in the host table.
5. `node --version`, `ShearK-Miner --selftest`, and `shear version` pass on the host, as above.
6. `--print-config` shows Shear Sentinel v19, magic `shear-testnet-v12`, and `mainnet: false`.
7. `/var/lib/shear/testnet-v12` is empty. Do not copy `tip.json` into it. Do not point the unit at a v11 datadir.
8. `/etc/default/sheark-miner` exists only on the five p2p hosts, mode `0600`, with that host's own `SHEARK_USER`. The pool host has no miner unit enabled.
9. The pool at `77.42.91.84` is not mining. `sheark-v4-afk` on the pool stays disabled.
10. Workers that lived on the deleted Ubuntu soak `2.28.39.91` are not started. `p2p-d` `91.99.128.192` is not a soak host.
11. Enabling the units is a separate step after CoS says the book is live. Extracting a pack is not that step.

## Rebuild

From a clean checkout of this branch, with Docker available:

```bash
bash scripts/packaging/build-all.sh
```

One distro: `bash scripts/packaging/build-all.sh ubuntu`. Images are tagged `shear-v12-pack:<distro>`. The image entrypoint is the smoke test: `node --version`, `ShearK-Miner --selftest`, `shear version`, a Sentinel `--print-config`, and a load of both native addons. When the desktop pack is enabled, `ldd` must not report a missing library for `shear_wallet`.

## Build record

Run on the packaging VM on 2026-10-13. Docker image builds and in-image smokes. No SSH, no tag, no deploy. Tarballs stayed in `scripts/packaging/out/` and are not in git. A later rebuild can differ: `rustup update stable` follows the stable channel (this run resolved rustc 1.99.0, `b940084d7`, 2026-09-28).

Every smoke printed `v22.23.3`, ShearK self-test digest `98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b` (`backend=jit-full`), `Shear wallet 0.72  magic shear-testnet-v12`, `--print-config` display Shear Sentinel v19, `addons ok interpreter`, and `SMOKE desktop binary ok`.

| Distro | Image | Smoke |
| --- | --- | --- |
| Ubuntu 26.04.1 LTS | `shear-v12-pack:ubuntu` built | `SMOKE OK ubuntu` |
| Debian GNU/Linux 13 (trixie) | `shear-v12-pack:debian` built | `SMOKE OK debian` |
| Fedora Linux 44 | `shear-v12-pack:fedora` built | `SMOKE OK fedora` |
| openSUSE Leap 16.1 | `shear-v12-pack:opensuse` built | `SMOKE OK opensuse` |

SHA256 of that run:

| File | SHA256 |
| --- | --- |
| `ShearK-Miner-2.9-ubuntu.tar.gz` | `945579c860e3bcf426d97036e684016354c046d966977577d70539a5d2ab1e7e` |
| `shear-node-v19-ubuntu.tar.gz` | `9fff0e388f79be0f973b8d6e221ae1ea8f5e840196e703944fe10e8d7cb2bd9a` |
| `shear-wallet-0.72-ubuntu-cli.tar.gz` | `0845231adce7a8af27ce5c8a6a1c6c1a5818bf407c3c46be5f9c65117c997269` |
| `shear-wallet-0.72-ubuntu-desktop.tar.gz` | `4366b9ec23f707959f427cd37893472791aef180a7b0610a8b560975fe19be69` |
| `ShearK-Miner-2.9-debian.tar.gz` | `0591ce3ffd3b0e13ebe73b7e220a2662d3d49a7c15ecb1959e36e3cd7aece5cf` |
| `shear-node-v19-debian.tar.gz` | `1f76ec6343b940668fe8605cc6ce03ae164fed49940534e7e9d76a7dc9b7b7e4` |
| `shear-wallet-0.72-debian-cli.tar.gz` | `104f59f1f3ec38b9ed7d90dcc521a7a1c5ac906bb0031e1729c2c3ed92710f85` |
| `shear-wallet-0.72-debian-desktop.tar.gz` | `8b0d485304422300abc50234444397bef019c205f0fed409caa99216c4da1174` |
| `ShearK-Miner-2.9-fedora.tar.gz` | `a25c06455bf27cc3878a4d43892036ce68507937b2b2fb71e139ebdb3ba0b1ad` |
| `shear-node-v19-fedora.tar.gz` | `8bfb4829a1a4411baf01459ca749c81af503e0fbe38e999ea320e0a47c073558` |
| `shear-wallet-0.72-fedora-cli.tar.gz` | `77e3321f28944c55ab8082c8aafacff9785e3f3d439b847748f0705c74e20d09` |
| `shear-wallet-0.72-fedora-desktop.tar.gz` | `aaeeba579ab5d29d3faf0c1dc3536ef0ef0bd4bc9842fc128fb2bfd64514b42b` |
| `ShearK-Miner-2.9-opensuse.tar.gz` | `f01b4cfe9452532289f77bd75d0bbc79d5ff64e1be009355c260e527f201bed0` |
| `shear-node-v19-opensuse.tar.gz` | `c4ce7c2177d37f0ec9794c3d2dbc861d26657c3ea488c9b5add86de3183ba651` |
| `shear-wallet-0.72-opensuse-cli.tar.gz` | `b91224434c4dd0c0c5f58421c644af8827525f928b37090c333514e3e9185d4c` |
| `shear-wallet-0.72-opensuse-desktop.tar.gz` | `72a2c3e43aac9fd69290116ba414e9855c74a4f1c4e8d5e5ac381e556c1731bc` |

Still open after this pack: `V12_GENESIS_BLOCK_HASH` is empty, so do not enable `shear-sentinel.service` on a live book until that pin is set and the node pack is rebuilt. No `v19`, `0.72`, or ShearK tag. The five hosts were not contacted. p2p-a and p2p-b are assigned the Ubuntu pack from the soak list; confirm `/etc/os-release` before extract. The pool at `77.42.91.84` does not get a miner.
