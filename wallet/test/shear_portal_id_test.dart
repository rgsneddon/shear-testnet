import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_reserve.dart';

void main() {
  test('a portal id is not recomputed from the public address', () {
    final seed = Uint8List(32);
    final dest20 = Uint8List(20);
    for (var i = 0; i < 32; i++) seed[i] = i + 1;
    for (var i = 0; i < 20; i++) dest20[i] = 0xa0 + (i % 16);
    final blind = portalBlindFromSeed(seed);
    expect(blind, isNotNull);
    final pid = portalIdFromDest20(dest20, blind!);
    expect(pid, isNotNull);
    expect(pid!.length, 64);
    const address = 'ssa1qqexamplepublicaddress';
    expect(pid, isNot(portalIdFromDest(address)));
    final publicOnly = sha256.convert(<int>[...utf8.encode(kPortalIdTag), ...dest20]).toString();
    expect(pid, isNot(publicOnly));
    expect(portalIdFromDest20(dest20, Uint8List(32)), isNot(pid));
  });
}
