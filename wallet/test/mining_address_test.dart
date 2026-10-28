import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_blunote.dart';

/// R28 shm1 mining address (Russell, 28 Oct). The vectors come from the
/// node's crypto/address.js (fixtures/gen_mining_address_vectors.mjs); the
/// Dart port must encode and refuse exactly as it does.
Uint8List _b(String hex) => Uint8List.fromList([
      for (var i = 0; i < hex.length; i += 2) int.parse(hex.substring(i, i + 2), radix: 16),
    ]);

String _h(Uint8List b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

void main() {
  final vec = jsonDecode(File('test/fixtures/mining_address_vectors.json').readAsStringSync())
      as Map<String, dynamic>;

  test('B‖Y encodes to the node\'s shm1 string, and decodes back', () {
    final good = (vec['good'] as List).cast<Map<String, dynamic>>();
    expect(good.length, 3);
    for (final g in good) {
      final seed = _b(g['seed'] as String);
      expect(_h(admitBaseBytes(seed)), g['B']);
      expect(_h(bluScanPub(seed)), g['Y']);
      final addr = encodeMiningAddress(_b(g['B'] as String), _b(g['Y'] as String));
      expect(addr, g['address'], reason: g['label'] as String);
      expect(bluMiningAddress(seed), g['address']);
      final back = decodeMiningAddress(addr);
      expect(back, isNotNull);
      expect(_h(back!.B), g['B']);
      expect(_h(back.Y), g['Y']);
    }
  });

  test('every string the node refuses, the wallet refuses', () {
    final bad = (vec['bad'] as List).cast<Map<String, dynamic>>();
    expect(bad.length, greaterThanOrEqualTo(10));
    for (final b in bad) {
      expect(
        decodeMiningAddress(b['s'] as String, allowHex: b['allowHex'] == true),
        isNull,
        reason: b['name'] as String,
      );
    }
    expect(decodeMiningAddress(vec['hexAllowed'] as String), isNull, reason: 'raw hex only when allowed');
    expect(decodeMiningAddress(vec['hexAllowed'] as String, allowHex: true), isNotNull);
  });

  test('encoding a key that is not a point throws, as the node does', () {
    final g = (vec['good'] as List).first as Map<String, dynamic>;
    expect(() => encodeMiningAddress(Uint8List(32)..fillRange(0, 32, 0xff), _b(g['Y'] as String)), throwsA(anything));
    expect(() => encodeMiningAddress(Uint8List(31), _b(g['Y'] as String)), throwsArgumentError);
  });

  test('the rig commands carry the shm1 address and no ssa1', () {
    final addr = (vec['good'] as List).first['address'] as String;
    expect(bluPoolCommand(addr),
        './ShearK-Miner --pool stratum+ssl://pool.shear.digital:443 --user rig1 --blu $addr --threads 8');
    expect(bluSoloCommand(addr), './ShearK-Miner --pool 127.0.0.1:1111 --user rig1 --blu $addr --solo --threads 8');
  });
}
