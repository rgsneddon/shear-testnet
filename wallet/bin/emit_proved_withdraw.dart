import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_withdraw.dart';

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Object? _json(Object? v) {
  if (v is Uint8List) return _hex(v);
  if (v is List<int>) return _hex(v);
  if (v is List) return [for (final row in v) _json(row)];
  if (v is Map) {
    return {for (final e in v.entries) e.key.toString(): _json(e.value)};
  }
  return v;
}

void main() {
  const pi = 314159265358;
  final portal = 'ab' * 32;
  final seed = Uint8List(32)..[0] = 9;
  final blob = Uint8List(321)..[0] = 0xf1;
  final fs1 = Uint8List(41)..[0] = 0xf1;
  final tilde = Uint8List(32)..[0] = 4;
  final leaves = <Map<String, Object?>>[];
  for (var i = 0; i < 2; i++) {
    final scalar = scalarBytes(hashToScalar([utf8Bytes('leaf-scalar-$i')]));
    final blind = scalarBytes(hashToScalar([utf8Bytes('leaf-blind-$i')]));
    final note = vaultLeafNote(amount: pi, scalar: scalar, blind: blind, unlock: 16);
    leaves.add({
      'scalar': scalar,
      'blind': blind,
      'note': note,
      'unlock': 16,
      'amount': pi,
      'epochs': [3, 4, 5],
      'withdrawPeriod': 3,
    });
  }
  final built = buildProvedWithdraw(
    dest20: Uint8List(20)..[0] = 0x11,
    nanos: pi * 2,
    id: 'dart-wd',
    portalId: portal,
    anchor: 16,
    excess: List<int>.filled(32, 8),
    fs1: fs1,
    vin: [
      {'commit': tilde},
      {'commit': Uint8List(32)..[0] = 5},
    ],
    admitProofs: [
      {'blob': blob, 'cTilde': tilde, 'spendTag': Uint8List(32)..[1] = 2},
      {
        'blob': Uint8List(321)..[0] = 0xf1,
        'cTilde': Uint8List(32)..[0] = 5,
        'spendTag': Uint8List(32)..[1] = 3,
      },
    ],
    leaves: leaves,
    spendSeed: seed,
    releaseEpoch: 0,
    fee: 0,
    withdrawNonce: Uint8List(32)..[31] = 7,
  );
  if (built == null) {
    stderr.writeln('null');
    exitCode = 1;
    return;
  }
  stdout.writeln(jsonEncode(_json(built)));
}
