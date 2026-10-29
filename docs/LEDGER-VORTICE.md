# Ledger vortice: design note

Status: design note (rule 16), branch `claude/ledger-vortice`. Plan: VORT1-SUITE-PLAN §3d,
roadmap rows R46 (host vortice) and R47 (device app and account type).
Not connected, not published, not minted. Russell gives the final GO for each.

## 0. Rulings this note builds on

- A Ledger-backed Shear account is an **additional, clearly labelled account type**. Its keys
  live on the device and it restores from the device's own recovery phrase. Normal wallets stay
  `shewall.bin` plus password, no seed phrase, unchanged. Nothing in this note touches that path.
- The vortice pairs over USB HID and Bluetooth (Nano X BLE), works with the coin apps on the
  device, and has a donate function: the user signs on their own Ledger to donate to Russell.
- Donation addresses live in one file, `vortices/ledger/donate-addresses.json`. They were read
  and confirmed on Russell's device. The wallet and donate.shear.digital both read that file.
- No consensus change, no pin change, no `rx_privacy_browser.dart` edit.

## 1. Transport layer

One `LedgerTransport` interface: `exchange(Uint8List apdu) -> Future<Uint8List>` (response with
the 2-byte status word), `close()`. Everything above it is transport-agnostic.

| Transport | Platform | Framing |
|---|---|---|
| USB HID | Windows, Linux, macOS desktop; Android USB OTG | 64-byte reports, channel `0x0101`, tag `0x05` |
| BLE | Android (Nano X, Stax, Flex) | GATT notify/write, tag `0x05`, no channel, MTU from `0x08` query |
| Mock replay | tests | recorded `=> apdu` / `<= response` trace pairs |
| Speculos | CI | TCP APDU port 9999: 4-byte BE length, APDU; reply length, data, SW |

Framing (`ledger_frame.dart`), the same for HID and BLE apart from the channel and packet size:

```
packet 0: [channel u16 BE]? 0x05 seq=0x0000 len u16 BE  apdu[0..]
packet k: [channel u16 BE]? 0x05 seq=k (u16 BE)         apdu[...]
```

HID packets are zero-padded to 64 bytes. The decoder checks the channel, tag and sequence, and
rejects a wrong sequence. It never trusts a length beyond 64 KiB.

Desktop HID uses the OS HID API through FFI (hidapi on Linux and macOS, `hid.dll` and SetupAPI on
Windows). It filters on vendor `0x2c97` and usage page `0xffa0`. Android BLE uses the Ledger GATT
service `13d63400-2c97-0004-0000-4c6564676572` (Nano X), with write characteristic `...0002` and
notify characteristic `...0001`. Pairing uses the OS bond. The device shows the pairing code, and
the user confirms it on both screens. The platform transports are plugin shims behind the
interface. The core and the tests never import them.

## 2. Device discovery and app detection

- `GET_APP_AND_VERSION` `B0 01 00 00`: response `01 nameLen name verLen ver flagsLen flags 9000`.
  `BOLOS` means the dashboard. The UI then asks the user to open a coin app.
- The vortice polls every 2 s while the pane is open and never opens an app itself. Opening an app
  (`E0 D8`) needs a device confirmation, and we leave that to the user.
- Status words map to one message table: `6985` refused on device, `5515` or `6982` locked,
  `6e00`/`6d00` wrong app, `6a80` bad data.

## 3. Per-chain modules

Each chain has a module with `appNames`, `address(path, {verify})` and later `signAndBuild(...)`.
`verify: true` makes the device show the address. The host shows the same string, and the user
compares the two.

| Chain | Device app | Address APDU | Sign | Default path |
|---|---|---|---|---|
| ETH/EVM | Ethereum (and EVM clones) | `E0 02 01 00` path | `E0 04` typed tx `0x02‖rlp` (EIP-1559) | `44'/60'/0'/0/0` |
| BTC | Bitcoin 2.x | `E1 00` xpub, and `E1 03` wallet address (`wpkh(@0/**)`) with merkle client commands | PSBTv2 `E1 04` | `84'/0'/0'/0/0` |
| LTC, DOGE | Litecoin, Dogecoin (legacy app protocol) | `E0 40 P1 P2` (P2 `02` bech32, `00` legacy) | legacy `E0 44`/`E0 4A`/`E0 48` | `84'/2'`, `44'/3'` |
| SOL | Solana | `E0 05 01 00` path, 32-byte pubkey to base58 | `E0 06` message signing | `44'/501'/0'` |
| XMR, KAS | Monero, Kaspa | APDUs as in the working `read-xmr.mjs` / `read-kas.mjs` | phase 2 | |
| XRP, TRX, XLM, ATOM, ALGO | their apps | address readers only | phase 3 | |
| SHE | Shear (new, §5) | `E0 10` account keys | `E0 12` spend auth | `44'/SHEAR'/acct'` |

Order: address read and verify for every chain first, then donate for ETH/EVM, then BTC, LTC and
DOGE (PSBT), then SOL.

### Donate flow

1. The user picks a chain. The host reads the donation address from the pinned JSON. The JSON's
   SHA-256 is in the bundle manifest, so a swapped file fails the bundle hash.
2. The host reads the user's own address from the device (`verify: false`) and fetches the
   nonce and fee or the UTXOs from a public RPC that the user can change. The RPC is never an
   authority: the device shows what it signs.
3. The host builds the unsigned transaction (EIP-1559, PSBT or a Solana message). The device
   shows the destination and amount, and the user confirms on the device.
4. The host checks that the returned signature recovers to the user's address, and only then
   broadcasts.

donate.shear.digital uses the same address JSON and the same transaction-building rules. The
JS twin of `ledger_eth.dart` must give byte-identical unsigned payloads for the shared test
vectors in `wallet/test/ledger/vectors/`.

## 4. Ledger-backed Shear account type

- A new account kind `ledger`, labelled "Ledger account (keys on device)" everywhere it appears.
  It is never mixed with `shewall.bin`. Its local file `ledger-<fpr>.json` holds only public
  data: `spendPub`, `admitBase`, `viewKey`, the path and the device fingerprint.
- Restore: re-pair the device. Same seed and path give the same keys. There is no password and no
  phrase in the wallet.
- Removing the device cannot lose funds, because the device's recovery phrase is the backup.
  The UI says this in one line at creation.

## 5. Shear on the device: the key split (FS-1)

The keys of a normal identity (`createIdentity`) come from one 32-byte seed `s`:
`spendPub = Ed25519(s)`, `viewKey = SHA256("shear-view-v1"‖pkcs8‖s)`,
`b = H(admitXDst,"base",s)`, `admitBase B = b·G`, and per note `x = b + δ(note)`, where `δ` comes
from public note data.

On the device, `s` = SLIP-10 Ed25519 at `m/44'/SHEAR'/acct'` (the coin type is registered at
listing). The device exports `spendPub`, `B` and `viewKey`, after a confirmation on its screen.
The view key lets the host scan, so the host sees incoming notes and amounts, as a watch-only
wallet does. The device never exports `s` or `b`.

**The FS-1 split works without a consensus change.** In `shear-fs1/src/spend.rs`, `sal_prove`
takes the witness `(x, o, a, b)`, the publics `(Õ, Ĩ, R, L)` and the transcript `m`. Here `o`,
`a` and `b` are the re-randomisation blinds. The host chooses them and they are not secrets of
the owner. `m` = SHA-512 over the body digest, the anchor, the root, the record heads and
`SHA512(fcmp)`. All of these exist before SA+L. So:

1. The host builds the re-randomisation, the FCMP membership proof and `m`. The host sends the
   device `δ`, `(o, a, b)`, `Õ, Ĩ, R`, `Hp(admitPub)` and the plaintext send summary (amount,
   destination, fee).
2. The device computes `x = b_dev + δ`. It checks `x·G == admitPub` (Ristretto encoding) and
   `Õ − o·T == x·G`. It computes the tag `L = x·Hp` (Ristretto-encoded, then lifted to Ed25519
   as `ristretto_to_ed`). It recomputes `m` from the streamed parts, so it signs exactly the body
   it showed, and it runs the five-scalar SA+L Schnorr with its own nonces.
3. The device returns `L` and the 160-byte SA+L. The host assembles the record. The verifier is
   unchanged, so the posted bytes are the same as a software spend.

Security: `s_x = k_x + e·x` with a device-random `k_x` is zero-knowledge, so the host learns
nothing about `x`. Without `x` the host can't produce a SA+L for any `m`, so it can't forge a
spend. A host that lies about `Õ`, `Ĩ` or `R` produces a proof that fails membership. A host
that lies about the summary is caught because the device recomputes the body digest from the
streamed vout rows and the opening of the destination row. The memo envelope signature uses
Ed25519 with `s` on the device (`cx_eddsa_sign`).

**Host half (ruling D1, 29 Oct: YES).** `shear-fs1/src/spend.rs` gains `external_tag`,
`prove_spend_external`, `sal_sign_external` (the reference signer that the device app must
match) and `assemble_external`. None of the existing functions change. `libshear_admit` exports
`shear_fs1_prove_external`, `shear_fs1_external_assemble` and `shear_fs1_external_free`, plus
`shear_fs1_external_tag` and `shear_fs1_external_sign`, which are for tests and vectors only.
The node addon has the same functions (`fs1ProveExternal`, `fs1ExternalAssemble`,
`fs1ExternalTag`, `fs1ExternalSign`), and the Dart binding is `wallet/lib/ledger_hw/ledger_fs1.dart`.
The request is 289 bytes: `m(64) index(1) Õ Ĩ R tag o i ib`. It carries host blinds and never
`x`. To avoid being an oracle for `x·P`, the signer computes the tag itself as `x·Hp(x·G)`.

Tests: Rust (`external_signer_*`), JS (`crypto/fs1_external.test.js`) and Dart
(`wallet/test/ledger/ledger_fs1_test.dart`) each check three things. First, `x` appears in no
request and no SA+L. Second, the unchanged `verify_spend` / `shear_fs1_verify` accepts the
assembled spend. Third, a forged SA+L or a foreign signer fails. JS and Dart also check one
shared tag vector, `crypto/vectors/fs1_external_v1.json`.

`SHEAR_ADMIT_SHA256` moves at the next wallet release. Linux x86_64 release build on agent-box
(the same toolchain for both builds):
- old, at b3efdc26: `dbb7f456fceab3eaa3bacd555a300a6b21ce2d2b5f5c1c7c96befc1277212f54`
- new, with the split: `7e24aa4a681027a37c771c582e7f1053462bded6289c28b55156b3e7134b54d6`

The release pipeline stamps the shipped hash for each platform as usual.

The device needs Ristretto255 encode and decode and hash-to-point on top of the SDK's Ed25519
point operations (`cx_ecfp_*`, `cx_bn_*` for the field square root). It does no other heavy
cryptography. The range proofs stay on the host.

## 6. Sandbox and host API

- The vortice runs in the vort1 sandbox. Its host API is `ledger.list()`, `ledger.app()`,
  `ledger.address(chain, path, verify)` and `ledger.sign(chain, unsignedPayload)`. There is no
  raw APDU passthrough to other vortices.
- **Every signature is confirmed on the device.** The host never signs, and no API caches an
  approval.
- **Spendable is never painted** for a Ledger account from host data alone. Balances show as
  "watch-only (view key)" until a spend is confirmed on-chain. No pending send, donation or
  device reply changes the Spendable figure.

## 7. Tests

- Mock transport replaying APDU traces. Each trace is a list of `=> apdu` / `<= response` pairs,
  and any deviation fails. Traces recorded on Russell's Nano X are read-only address reads.
- Framing, RLP and EIP-1559 vectors, checked against known published values.
- Speculos in CI for `ledger/app-shear`: build, derive, export and SA+L, and the SA+L verified by
  the Rust `sal_verify` over the same `m`.
- An on-device signing test needs Russell's GO each time.

## 8. Packaging

`vortices/ledger/` holds the manifest (files, sizes, SHA-256), the address JSON and the built
Dart code. `scripts/ledger-vortice-bundle.sh` makes a deterministic tar (sorted entries, mtime 0,
uid 0) and prints its SHA-256. Minting the vort1 waits for Russell's GO.

## 9. Decisions for Russell

- **D1: YES (29 Oct).** The split exports are done, as described in §5.
- **D2: YES (29 Oct).** A new SLIP-44 type. Russell submits the request himself, from
  Desktop/SLIP44-SHE-PR.md, proposing 2004. Until then the only placeholder is
  `SHEAR_COIN_TYPE` in `ledger/app-shear/Makefile`.
- **D3:** submitting the device app to Ledger review and listing it.
- **D4:** a signing test on his Nano X (testnet ETH first).
