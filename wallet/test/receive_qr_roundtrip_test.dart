import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_qr.dart';

/// A receive QR must decode to the she1 it was made from, for every
/// identity. Russell (30 Oct, and on v11): the Scan QR decode fails for
/// some identities and has since v11. The sweep is seeded, so a failing
/// identity fails every run.
Uint8List seedOf(int i) {
  final s = Uint8List(32);
  var x = 0x9e3779b9 ^ i;
  for (var k = 0; k < 32; k++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s[k] = (x >> 16) & 0xff;
  }
  return s;
}

void main() {
  test('every seeded identity round-trips encodeReceiveQrPng -> decodeReceiveQrImage', () {
    const sweep = 300;
    final failed = <String>[];
    for (var i = 0; i < sweep; i++) {
      final id = createIdentity(seedOf(i));
      final she1 = id.paymentCodeFull;
      final got = decodeReceiveQrImage(encodeReceiveQrPng(she1));
      if (got != she1) failed.add('seed $i len ${she1.length} got ${got == null ? 'null' : 'other'} $she1');
    }
    expect(failed, isEmpty, reason: '${failed.length}/$sweep identities do not round-trip:\n${failed.join('\n')}');
  });
}
