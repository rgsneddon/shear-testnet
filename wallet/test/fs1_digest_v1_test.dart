// Shared vector: crypto/vectors/fs1_digest_v1.json, checked by crypto/fs1_spend.test.js.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_identity.dart' show kBookMagic;

String _toHex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Map<String, dynamic> _vector() {
  for (final p in ['../crypto/vectors/fs1_digest_v1.json', 'crypto/vectors/fs1_digest_v1.json']) {
    final f = File(p);
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  }
  throw StateError('fs1_digest_v1.json not found');
}

void main() {
  final vec = _vector();
  final cases = (vec['cases'] as List).cast<Map<String, dynamic>>();

  test('the wallet FS-1 body digest is the node digest for every case', () {
    expect(vec['magic'], kBookMagic);
    expect(cases.length, greaterThanOrEqualTo(3));
    for (final c in cases) {
      final got = fs1BodyDigest(
        magic: vec['magic'] as String,
        kind: c['kind'] as String,
        anchor: c['anchor'] as int,
        fee: c['fee'] as int,
        nIn: c['nIn'] as int,
        vout: [for (final o in (c['vout'] as List)) Map<String, dynamic>.from(o as Map)],
        memoCt: c['memoCt'] == null ? null : Map<String, dynamic>.from(c['memoCt'] as Map),
      );
      expect(_toHex(got), c['digest']);
    }
  });

  test('the wallet signs the memo envelope the node signs; stripped or swapped, the digest moves', () {
    final c = cases.firstWhere((c) => c['memoCt'] != null);
    final memo = Map<String, dynamic>.from(c['memoCt'] as Map);
    expect(_toHex(fs1MemoDigest(memo)), c['memoDigest']);
    final vout = [for (final o in (c['vout'] as List)) Map<String, dynamic>.from(o as Map)];
    String d(Map<String, dynamic>? m) => _toHex(fs1BodyDigest(
          magic: kBookMagic,
          kind: c['kind'] as String,
          anchor: c['anchor'] as int,
          fee: c['fee'] as int,
          nIn: c['nIn'] as int,
          vout: vout,
          memoCt: m,
        ));
    expect(d(memo), c['digest']);
    expect(d(null), cases.first['digest']);
    expect(d({...memo, 'ct': 'R' * (memo['ct'] as String).length}), isNot(c['digest']));
  });

  test('a changed fee or anchor changes the digest', () {
    final c = cases.first;
    final vout = [for (final o in (c['vout'] as List)) Map<String, dynamic>.from(o as Map)];
    String d({int? fee, int? anchor}) => _toHex(fs1BodyDigest(
          magic: kBookMagic,
          kind: c['kind'] as String,
          anchor: anchor ?? c['anchor'] as int,
          fee: fee ?? c['fee'] as int,
          nIn: c['nIn'] as int,
          vout: vout,
        ));
    expect(d(), c['digest']);
    expect(d(fee: (c['fee'] as int) + 1), isNot(c['digest']));
    expect(d(anchor: (c['anchor'] as int) + 8), isNot(c['digest']));
  });

  test('the newest anchor that holds every input is picked', () {
    final rows = fs1AnchorsOf([
      {'height': 24, 'n': 30},
      {'height': 16, 'n': 20},
      {'height': 8, 'n': 9},
      {'height': 'x', 'n': 1},
    ]);
    expect(rows.length, 3);
    expect(pickFs1Anchor(rows, 5)!.height, 24);
    expect(pickFs1Anchor(rows, 29)!.height, 24);
    expect(pickFs1Anchor(rows, 30), isNull);
  });
}
