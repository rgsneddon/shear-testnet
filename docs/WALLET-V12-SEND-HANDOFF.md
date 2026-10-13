# Wallet v12 send handoff

Code commit: `1ed54ef691692f0be4c6a937c7858bbb57b6f764` on `cursor/wallet-v12-send-1013`, parent `ff92ba545c6433dff067feaad8fe05aa4d7b6585`.

The proof in this note is the interim testnet membership proof pending FS-1: byte 3 plus one anchor. FS-1 replaces the statement. The group of 32 is the current testnet statement.

## What’s done

Wallet send, transfer, and multi-input (cap 8) are wired to that proof.

- `crypto/flow_membership.js` binds each input with the native tag and C̃, hashes one statement, then calls `admitProveV3`. A single input posts `admit_proof` only. Two or more inputs post `admit_proofs` only. Byte-2 prove and verify in `crypto/admit.js` are untouched.
- The Dart wallet (`shear_admit.dart`, `shear_native_prove.dart`, `shear_ledger.dart`, `shear_membership.dart`, `shear_membership_ffi.dart`) uses the same statement and the same native prove. Seal and prove run in `Isolate.run`. The production prove wait is 4 hours per input, on the worker isolate. A debug stand-in still returns in 8 seconds and may be a byte-2 mock.
- Android 64-bit loads `libshear_admit.so` through FFI. That path does not spawn node and does not write a temp file. This VM built the Linux x86_64 release library only. No arm64 phone library was built, and no phone was attached.
- The node fluxset and the pool fluxset return `anchor` and `anchorN`. The wallet proves against that prefix of the live set, which is the book `verifyFlowAdmitV3` checks.
- A posted fee is the fee hashed into the statement, so the node does not rewrite `fee` / `maxLevy` after the proof.

`node/tests/test_wallet_v12_send.js` drove `sealFlowMembership` against a 16-block chain (anchor 8). It was stopped during the 8-input seal. Do not start that 8-input prove again to finish the file.

| Step | Result |
| --- | --- |
| 1-input send seal | Byte 3, 23938-byte blob, anchor 8, fee 20000 covered the levy on the first attempt |
| 1-input send mempool and `verifyBlock` | Accepted (`send-accepted` at 14:38:03Z) |
| 1-input transfer seal | Same blob size and fee |
| 1-input transfer mempool and `verifyBlock` | Accepted (`transfer-accepted` at 15:25:44Z) |
| 8-input seal | First of eight proofs finished (23938 bytes). The second had started. Mempool, `verifyBlock`, `queueTx`, and append for that spend did not run |
| `queueTx` and block append of the 1-input send | Still later in the test, after the 8-input seal, so they did not run |

Dart wallet suite after `rustup update stable` (stable stayed rustc 1.99.0; the default toolchain is still 1.83.0) and a release addon build:

`flutter test --reporter compact` in `wallet/`: 386 passed, 49 failed, exit 1, about 35:44. The new `anchor` argument on `ShearPoolClient.send` is on the test doubles, so that compile break is gone. `wallet/test/wallet_v12_frame_test.dart` passed (anchor 8 at tip 16, and 16 ms ticks advanced while `Isolate.run` was busy). A second run of that file plus `t18_frame_test.dart` was 4 passed, 1 failed: the existing “whole hold inside the idle frame budget” case, “typing 2000 notes added 71505 us”.

## Prove time on this VM

Host: 4 cores. The native process sat at about 370–390% CPU, so it used all four. Resident set grew to about 4.3 GB during prove and about 9 GB while a proof was being checked.

Build: release. `crypto/native/shearadmit.node` and `crypto/native/admit/target/release/libshear_admit.so` were built with stable rustc 1.99.0. This was not a debug build. `cargo` without `+stable` is rustc 1.83.0 and cannot parse the current crate graph.

The timer is only the native prove (`prove-start` to `prove-done` in `/tmp/wallet-v12-send-progress.txt`). Bind, the statement, and growing 16 blocks sit outside it. Grow took 1.3 seconds. The gap from seal start to prove start on the first input was 78 ms.

| Input | Wall time | Blob | Machine |
| --- | --- | --- | --- |
| Send, index 0 | 7,414,823 ms (2 h 3 min) | 23938 | Dart suite shared the cores for the first ~36 min |
| Transfer, index 1 | 1,977,125 ms (33.0 min) | 23938 | Suite already finished |
| 8-input send, index 0 | 1,967,375 ms (32.8 min) | 23938 | Suite already finished |

Per input, once the machine was otherwise idle: about 33 minutes. The 2 hour figure is the same prove while `flutter test` was also running.

Checking one sealed spend (mempool, then `verifyBlock`) took 880 seconds for the send and 883 seconds for the transfer. That is the check, separate from the prove.

Where those 33 minutes go: the blob length is the one-layer layout, 23938 bytes.

`258` header + `1024` dest siblings + `20704` leaf + `1952` hide tail = `23938`.

`n_layers` is 1, so the paired proofs for layers above the leaf did not run. Inside that call the IPA work is the leaf’s slot-link (16 rounds, 2^16), two encode links (20 rounds, 2^20 each), and the spent-bucket hide (23 rounds, 2^23, 5,630,566 gates). No timer was split across those four proofs. The hide is the largest circuit in the call.

## The send path apart from prove speed

The path accepts a sealed spend. For the send and the transfer, the wallet seal produced a byte-3 proof with anchor 8, the posted fee already covered the weight levy, and the node’s mempool and `verifyBlock` both returned ok. Nothing in that accept path rewrote the fee or asked for another proof.

`queueTx` and appending the spend into a block were not reached. They use the same membership check as `verifyBlock`. They remain unrun because they sit after the 8-input seal in the test.

The Dart UI was not tapped through to a node. The e2e called `sealFlowMembership`, which is the prove the desktop helper and the Android FFI both call. The phone library for arm64 is still to be packaged. FS-1 still replaces `membershipStatement` / `flowMembershipStatement`; callers already pass those bytes through.
