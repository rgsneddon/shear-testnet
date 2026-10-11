import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_lock.dart';
import 'package:shear_wallet/shear_session.dart';

/// A saved book paints the same coins after a JSON load. Counts and amounts
/// are a spread. A locked note, a young note, and a `{v}`-only row stay out.
void main() {
  test('a restored book keeps exact nanos for any count and any u64', () {
    const wires = ['1', '1000', '9007199254740993', '18446744073709551615'];
    final counts = <int>[
      1,
      3,
      kMaxInputsPerSend - 1,
      kMaxInputsPerSend,
      kMaxInputsPerSend + 1,
      2000,
    ];
    final id = createIdentity();
    final home = ShearLedger()..bindIdentity(id);
    final dest = home.homeDest(id.address, paymentCode: id.paymentCode);
    expect(sessionProofNanos('18446744073709551615'), '18446744073709551615');
    expect(sessionProofNanos(18446744073709551615.0), isNull);
    for (final count in counts) {
      for (final wire in wires) {
        final book = ShearLedger()..bindIdentity(id);
        var expectSum = BigInt.zero;
        for (var i = 0; i < count; i++) {
          final nanos = i == 0 ? wire : '1';
          expectSum += BigInt.parse(nanos);
          book.rememberNote({
            'address': dest,
            'dest': dest,
            'kind': 'pool-fee',
            'commit': _commit(count, i, wire),
            'height': 1,
            'verified': true,
            'proofChecked': true,
            'nanos': nanos,
            'verifiedNanos': nanos,
            'proofKey': 'c$i|$wire',
            'spent': false,
            'locked': false,
          });
        }
        book.rememberNote({
          'address': dest,
          'dest': dest,
          'kind': 'pool-fee',
          'commit': _commit(count, 9000, 'lock'),
          'height': 1,
          'verified': true,
          'nanos': 100000000000,
          'verifiedNanos': 100000000000,
          'proofKey': 'lock|$wire',
          'locked': true,
          'spent': false,
        });
        book.rememberNote({
          'address': dest,
          'dest': dest,
          'kind': 'pool-fee',
          'commit': _commit(count, 9001, 'young'),
          'height': 40,
          'verified': true,
          'nanos': 100000000000,
          'verifiedNanos': 100000000000,
          'proofKey': 'young|$wire',
          'locked': false,
          'spent': false,
        });
        book.rememberNote({
          'address': dest,
          'dest': dest,
          'kind': 'pool-fee',
          'valueProof': {'v': 50},
          'amount': 5,
        });
        final replay = ShearLedger()..bindIdentity(id);
        replay.restoreSessionNotes(
          book.exportNotesForSession(),
          covered: 40,
          paymentCode: id.paymentCode,
        );
        final saved = jsonDecode(jsonEncode(replay.exportNotesForSession()));
        final proofs = sessionOpenedProofRows(
          jsonDecode(jsonEncode(replay.exportOpenedProofs())),
        );
        expect(
          proofs.any((row) => row['n'] == wire),
          isTrue,
          reason: 'count=$count wire=$wire',
        );
        final fresh = ShearLedger()..bindIdentity(id);
        fresh.restoreSealedTip(40);
        fresh.restoreOpenedProofs(proofs);
        fresh.restoreSessionNotes(saved, covered: 40, paymentCode: id.paymentCode);
        final plan = selectSpendNotesWire({
          'notes': fresh.notes,
          'needNanos': '1',
          'tip': 40,
          'confs': 9,
        });
        expect(plan['spendableNanos'], expectSum.toString(), reason: 'count=$count wire=$wire');
        final picked = (plan['batches'] as List)
            .cast<Map>()
            .expand((b) => (b['notes'] as List))
            .cast<Map>();
        expect(picked.any((n) => n['nanos'] == '100000000000'), isFalse, reason: 'count=$count wire=$wire');
        if (BigInt.parse(wire) > BigInt.from(100)) {
          expect(picked.any((n) => n['nanos'] == wire), isTrue, reason: 'count=$count wire=$wire');
        }
      }
    }
  });

  test('session peek does not decode a note list of any size', () {
    final dir = Directory.systemTemp.createTempSync('c072-peek-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final file = File('${dir.path}/session.json');
    final notes = jsonEncode([
      for (var i = 0; i < 2000; i++)
        {'nanos': '9007199254740993', 'kind': 'pool-fee', 'pad': 'x' * 64},
    ]);
    file.writeAsStringSync(
      '{"kind":"${ShearLock.kind}","biometricsEnabled":false,"notes":$notes}',
    );
    expect(file.lengthSync(), greaterThan(512));
    final sw = Stopwatch()..start();
    final session = ShearSession(store: file);
    sw.stop();
    expect(session.sealed, isTrue);
    expect(session.rememberedNotes, isEmpty);
    expect(session.rememberedOpenedProofs, isEmpty);
    expect(sw.elapsedMilliseconds, lessThan(500));
  });
}

Uint8List _commit(int count, int i, String wire) {
  final out = Uint8List(32);
  out[0] = count & 255;
  out[1] = i & 255;
  out[2] = (i >> 8) & 255;
  out[3] = wire.codeUnitAt(0) & 255;
  out[4] = wire.length & 255;
  return out;
}
