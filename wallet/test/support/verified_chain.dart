// Test support: a verified header chain for a wallet book.
//
// Spendable counts confirmations from the verified tip (bookTip), and a
// header counts only when it links to a checkpoint pin (#125, 23 Oct). The
// shipped pin is a placeholder until the v12 cut, so a test installs this
// fixture pin and verifies real headers above it.
//
// Every header here is real: ShearHash-v3 (the native libshear_v3) meets the
// 4-bit target its ASERT quote sets, and each links to the digest of the one
// below. The pin's own block is mined the same way and its digest is the pin.
// Times run 26 h behind the 90 s schedule from the consensus anchor, so the
// ASERT quote at every height is the 4-bit floor (the same scheme as
// spendable_hard_lock_test's fixture pin).
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_checkpoint.dart';
import 'package:shear_wallet/shear_hash.dart';
import 'package:shear_wallet/shear_ledger.dart';

const int _anchorMs = 1599904780000;
const int _floorBits = 4 * 65536;

/// Header time at [height]: 26 h behind schedule, so the quote is 4 bits.
int verifiedChainTimeAt(int height) => _anchorMs + (height - 1) * 90000 + 93600000;

Uint8List _header({required Uint8List prev, required int timestampMs, int salt = 0}) {
  final h = Uint8List(128);
  h[0] = 1;
  h.setRange(4, 36, prev);
  var ts = timestampMs;
  for (var i = 0; i < 8; i++) {
    h[100 + i] = ts & 0xff;
    ts >>= 8;
  }
  var b = _floorBits;
  for (var i = 0; i < 4; i++) {
    h[108 + i] = b & 0xff;
    b >>= 8;
  }
  h[80] = salt;
  return h;
}

Uint8List _mine(Uint8List header) {
  for (var n = 0; n < 1 << 16; n++) {
    shearSetNonce(header, n);
    final digest = shearHashV3(Uint8List.fromList(header));
    if (digest != null && shearMeetsTarget(digest, _floorBits)) {
      return Uint8List.fromList(header);
    }
  }
  fail('no ShearHash-v3 nonce meets the 4-bit floor');
}

String _hex(Uint8List b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

class VerifiedChain {
  VerifiedChain({required this.pinHeight, this.salt = 0}) {
    expect(pinHeight, greaterThanOrEqualTo(11), reason: 'a pin sits at 11 or above');
    final pinHeader = _mine(_header(
      prev: Uint8List(32),
      timestampMs: verifiedChainTimeAt(pinHeight),
      salt: salt,
    ));
    _digests[pinHeight] = shearHashV3(pinHeader)!;
    pin = CheckpointPin(
      network: 'testnet-v12-fixture',
      height: pinHeight,
      hashHex: _hex(_digests[pinHeight]!),
      timeMs: verifiedChainTimeAt(pinHeight),
      bits: _floorBits,
      anchorHeight: kConsensusAnchorHeight,
      anchorTimeMs: _anchorMs,
      anchorBits: kConsensusAnchorBits,
      priorTimesMs: [for (var i = 10; i >= 1; i--) verifiedChainTimeAt(pinHeight - i)],
    );
    expect(checkpointPinWellFormed(pin), isTrue);
  }

  final int pinHeight;
  final int salt;
  late final CheckpointPin pin;
  final Map<int, Uint8List> _headers = {};
  final Map<int, Uint8List> _digests = {};

  /// The real mined header at [height] (above the pin), linked to the one below.
  Uint8List headerAt(int height) {
    expect(height, greaterThan(pinHeight));
    final have = _headers[height];
    if (have != null) return have;
    final prev = height - 1 == pinHeight ? _digests[pinHeight]! : shearHashV3(headerAt(height - 1))!;
    final mined = _mine(_header(prev: prev, timestampMs: verifiedChainTimeAt(height), salt: salt));
    _headers[height] = mined;
    _digests[height] = shearHashV3(mined)!;
    return mined;
  }

  String hexAt(int height) => _hex(headerAt(height));

  Future<List<({int height, Uint8List header})>> fetch(int from, int to) async => [
        for (var h = from < pinHeight + 1 ? pinHeight + 1 : from; h <= to; h++) (height: h, header: headerAt(h)),
      ];

  /// Install the pin on [ledger] and verify every header up to [tip].
  Future<void> verify(ShearLedger ledger, int tip) async {
    ledger.bindHeaderClock(verifiedChainTimeAt(tip));
    if (ledger.bookTip < pinHeight) ledger.installCheckpoint(pin);
    if (tip > pinHeight) {
      final reached = await ledger.catchUpVerifiedChain(tip, fetch: fetch);
      expect(reached, tip, reason: 'headers verified to $tip');
    }
    expect(ledger.bookTip, tip);
  }
}
