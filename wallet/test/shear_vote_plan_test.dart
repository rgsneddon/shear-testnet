import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_vote_plan.dart';

void main() {
  test('the plan uses owned fee notes and stays a private file', () {
    final notes = [
      {'kind': 'lock', 'commit': '11' * 32},
      {'kind': 'send', 'spent': true, 'commit': '22' * 32},
      {'kind': 'send', 'locked': true, 'commit': '33' * 32},
      {'kind': 'send', 'commit': '44' * 32},
      {'kind': 'send', 'commit': '55' * 32},
    ];
    expect(castWalletVotePlan(leaves: 2, notes: notes, openHeight: 0, closeHeight: 100), isNull);
    final wide = castWalletVotePlan(
      leaves: 2,
      notes: notes,
      openHeight: 0,
      closeHeight: 400,
      random: Random(1),
    );
    expect(wide, isNotNull);
    final txs = (wide!['txs'] as List).cast<Map<String, Object?>>();
    expect(txs.map((row) => row['feeInput']), ['44' * 32, '55' * 32]);
    expect(txs.any((row) => row['feeInput'] == '11' * 32), isFalse);
    final dir = Directory.systemTemp.createTempSync('vote-plan-');
    saveWalletVotePlan(dir.path, wide);
    final file = File(votePlanPath(dir.path));
    expect(file.statSync().mode & 0x1ff, 0x180);
    expect(file.readAsStringSync().contains('lockedLeaves'), isFalse);
  });
}
