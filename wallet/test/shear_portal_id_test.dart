import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_pack.dart';
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

  test('sealSignReserveWire stamps the spend-seed portal id', () {
    final id = createIdentity();
    final seed = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      seed[i] = int.parse(id.seedHex.substring(i * 2, i * 2 + 2), radix: 16);
    }
    final payer = createIdentity();
    final built = sealSignReserveWire(<String, dynamic>{
      'to': id.address,
      'from': payer.address,
      'kind': 'lock',
      'nanos': 1000,
      'spendSeed': seed,
      'vouts': <Map<String, dynamic>>[
        {'address': id.address, 'nanos': 1000, 'kind': 'lock'},
      ],
    });
    final d20 = hash20FromAddress(id.address);
    final blind = portalBlindFromSeed(seed);
    expect(d20, isNotNull);
    expect(blind, isNotNull);
    final want = portalIdFromDest20(d20!, blind!);
    expect(built['portalId'], want);
    expect(built['portalId'], isNot(portalIdFromDest(id.address)));
    expect(built['portalId'], isNot(reservePortalId(id.address)));
    final note = (built['vouts'] as List).first as Map;
    expect(note['portalId'], want);
  });
}
