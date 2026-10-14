// Shared vector: crypto/vectors/amtct_v1.json, checked by node/tests/test_amount_leak_v12.js.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_pack.dart';

Uint8List _hex(String s) =>
    Uint8List.fromList([for (var i = 0; i < s.length; i += 2) int.parse(s.substring(i, i + 2), radix: 16)]);

String _toHex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Map<String, dynamic> _vector() {
  for (final p in ['../crypto/vectors/amtct_v1.json', 'crypto/vectors/amtct_v1.json']) {
    final f = File(p);
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  }
  throw StateError('amtct_v1.json not found');
}

void main() {
  final vec = _vector();
  final cases = (vec['cases'] as List).cast<Map<String, dynamic>>();

  test('owner opens amtCt for every case and gets the JS r', () {
    expect(cases.length, greaterThanOrEqualTo(5));
    for (final c in cases) {
      final got = openNoteAmount(c, admitBaseScalar(_hex(c['spendSeed'] as String)));
      expect(got, isNotNull, reason: c['v'] as String);
      expect(got!['v'], BigInt.parse(c['v'] as String));
      expect(_toHex(got['r'] as Uint8List), c['r']);
    }
  });

  test('a wrong seed or a flipped byte opens nothing', () {
    for (final c in cases) {
      expect(openNoteAmount(c, admitBaseScalar(_hex(c['wrongSeed'] as String))), isNull);
      final bad = _hex(c['amtCt'] as String);
      bad[0] ^= 1;
      final tampered = {...c, 'amtCt': bad};
      expect(openNoteAmount(tampered, admitBaseScalar(_hex(c['spendSeed'] as String))), isNull);
    }
  });

  test('flow spend digest binds amtCt like spend.js', () {
    for (final c in cases) {
      final digest = flowAmtDigest(_hex(c['packed'] as String), [_hex(c['amtCt'] as String)]);
      expect(_toHex(digest), c['spendPackDigest']);
    }
    final dst = utf8.encode(vec['dst']['spendAmt'] as String);
    expect(sha256.convert(dst).bytes.length, 32);
  });
}
