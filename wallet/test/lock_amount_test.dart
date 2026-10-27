import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_vault_reward.dart' show kPiSheNanos;

/// Counts what would reach the pool. A refused lock posts nothing.
class _CountingPool extends ShearPoolClient {
  _CountingPool()
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 50),
        );

  int posts = 0;

  @override
  Future<Map<String, dynamic>> postRaw(Map<String, dynamic> body) async {
    posts += 1;
    return {'ok': true};
  }
}

void main() {
  test('one π leaf is the only lock amount', () {
    expect(isOnePiLeaf(kPiSheNanos / kUnitsPerShe), isTrue);
    expect(isOnePiLeaf(1), isFalse);
    expect(isOnePiLeaf((kPiSheNanos + 1) / kUnitsPerShe), isFalse);
    expect(isOnePiLeaf((kPiSheNanos - 1) / kUnitsPerShe), isFalse);
    expect(isOnePiLeaf(2 * kPiSheNanos / kUnitsPerShe), isFalse);
  });

  test('a lock of any other amount is refused in the wallet before anything is posted', () async {
    final pool = _CountingPool();
    final ledger = ShearLedger(pool: pool);
    final seed = Uint8List(32)..fillRange(0, 32, 7);
    for (final she in [1.0, (kPiSheNanos + 1) / kUnitsPerShe, 2 * kPiSheNanos / kUnitsPerShe]) {
      await expectLater(
        ledger.send(
          from: 'ssa1unused',
          to: 'ssa1unused',
          amount: she,
          kind: 'lock',
          spendSeed: seed,
          allowPublicHttp: true,
        ),
        throwsA(isA<StateError>().having((e) => e.message, 'message', kErrLockAmount)),
        reason: '$she SHE',
      );
    }
    expect(pool.posts, 0, reason: 'nothing reached the pool');
    pool.close();
  });
}
