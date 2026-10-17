import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_leaf_vote.dart';
import 'package:shear_wallet/shear_vote_plan.dart';
import 'package:shear_wallet/shear_withdraw.dart';

void main() {
  test('two leaves in heights 0-100 have a plan, and a restart reuses it', () {
    final notes = [
      {'kind': 'lock', 'commit': '11' * 32},
      {'kind': 'send', 'spent': true, 'commit': '22' * 32},
      {'kind': 'send', 'locked': true, 'commit': '33' * 32},
      {'kind': 'send', 'commit': '44' * 32, 'parentTx': 'a'},
      {'kind': 'send', 'commit': '66' * 32, 'parentTx': 'a'},
      {'kind': 'send', 'commit': '55' * 32, 'parentTx': 'b', 'voteChange': true},
      {'kind': 'send', 'commit': '77' * 32, 'parentTx': 'c'},
    ];
    final plan = castWalletVotePlan(
      leaves: 2,
      notes: notes,
      openHeight: 0,
      closeHeight: 100,
      random: Random(1),
    );
    expect(plan, isNotNull);
    final txs = (plan!['txs'] as List).cast<Map<String, Object?>>();
    expect(txs, hasLength(2));
    final heights = txs.map((row) => row['height'] as int).toList()..sort();
    expect(heights.first, greaterThanOrEqualTo(10));
    expect(heights.last, lessThanOrEqualTo(90));
    expect(heights.last - heights.first, greaterThanOrEqualTo(voteMinSeparation));
    final fees = txs.map((row) => row['feeInput']).toSet();
    expect(fees.contains('11' * 32), isFalse);
    expect(fees.contains('55' * 32), isFalse);
    expect(fees.length, 2);
    expect(fees.contains('66' * 32) && fees.contains('44' * 32), isFalse);

    final root = '${Directory.systemTemp.path}${Platform.pathSeparator}vote-plan-${pid}-${Random(1).nextInt(1 << 20)}';
    final dir = votePlanFolder(root);
    final first = plannedLeafVotes(
      dir: dir,
      leaves: 2,
      notes: notes,
      openHeight: 0,
      closeHeight: 100,
      random: Random(2),
    );
    expect(first, isNotNull);
    final again = plannedLeafVotes(
      dir: dir,
      leaves: 2,
      notes: notes,
      openHeight: 0,
      closeHeight: 400,
      random: Random(9),
    );
    expect(again!['txs'], first!['txs']);
    final file = File(votePlanPath(dir));
    expect(file.statSync().mode & 0x1ff, voteFileMode);
    expect(Directory(dir).statSync().mode & 0x1ff, voteDirMode);
    expect(file.readAsStringSync().contains('lockedLeaves'), isFalse);
    expect(() => saveWalletVotePlan(dir, first), throwsA(isA<StateError>()));
    final link = '${dir}${Platform.pathSeparator}link.json';
    Link(link).createSync(file.path);
    expect(FileSystemEntity.typeSync(votePlanPath(dir), followLinks: false), FileSystemEntityType.file);
  });

  test('a leaf vote spends the note it picked and does not publish that note', () {
    final notes = [
      {'kind': 'send', 'commit': 'aa' * 32, 'parentTx': 'p'},
      {'kind': 'send', 'commit': 'bb' * 32, 'parentTx': 'p'},
      {'kind': 'send', 'commit': 'cc' * 32, 'parentTx': 'q', 'voteChange': true},
      {'kind': 'reward-claim', 'commit': 'ee' * 32, 'parentTx': 's'},
      {'kind': 'send', 'commit': 'dd' * 32, 'parentTx': 'r'},
    ];
    final picked = <String>[];
    final vote = buildLeafVote(
      vote: {
        'voteProof': 'proof',
        'choice': 1,
        'voteSeq': 1,
        'voteParam': 'hb',
        'earnEpoch': 1,
        'height': 40,
      },
      notes: notes,
      fee: 10,
      anchor: 16,
      random: Random(1),
      usedParents: {'p'},
      prove: (note) {
        final commit = note['commit'].toString();
        picked.add(commit);
        final blob = List<int>.filled(321, 9);
        blob[0] = 0xf1;
        final tilde = List<int>.generate(32, (i) => int.parse(commit.substring(i * 2, i * 2 + 2), radix: 16));
        final fs1 = List<int>.filled(41, 1);
        fs1[0] = 0xf1;
        return {
          'fs1': fs1,
          'excess': List<int>.filled(32, 8),
          'admitProof': {'blob': blob, 'cTilde': tilde},
        };
      },
    );
    expect(vote, isNotNull);
    expect(picked, ['dd' * 32]);
    expect(vote!.containsKey('from'), isFalse);
    expect(vote.containsKey('feeInput'), isFalse);
    expect(vote.containsKey('parentTx'), isFalse);
    expect(vote.containsKey('parent'), isFalse);
    expect((vote['fs1'] as List).first, 0xf1);
    final tilde = ((vote['admit_proofs'] as List).first as Map)['cTilde'] as List;
    expect((vote['vin'] as List).first['commit'], tilde);
    expect((vote['vout'] as List), isEmpty);
    expect(
      buildLeafVote(
        vote: {'voteProof': 'proof', 'height': 40},
        notes: notes,
        fee: 10,
        anchor: 16,
        random: Random(1),
        prove: (_) => null,
      ),
      isNull,
    );
  });

  test('a plan for a new epoch replaces the file and a reward-claim is not a fee', () {
    final notes = [
      {'kind': 'reward-claim', 'commit': '11' * 32, 'parentTx': 'claim'},
      {'kind': 'send', 'commit': '22' * 32, 'parentTx': 'fee'},
    ];
    final root = '${Directory.systemTemp.path}${Platform.pathSeparator}vote-plan-roll-${pid}';
    final dir = votePlanFolder(root);
    final first = plannedLeafVotes(
      dir: dir,
      leaves: 1,
      notes: notes,
      openHeight: 0,
      closeHeight: 100,
      epoch: 1,
      random: Random(1),
    );
    expect(first, isNotNull);
    expect(first!['epoch'], 1);
    expect((first['txs'] as List).first['feeInput'], '22' * 32);
    final next = plannedLeafVotes(
      dir: dir,
      leaves: 1,
      notes: notes,
      openHeight: 0,
      closeHeight: 100,
      epoch: 2,
      random: Random(2),
    );
    expect(next, isNotNull);
    expect(next!['epoch'], 2);
    expect(loadWalletVotePlan(dir, epoch: 1), isNull);
    expect(loadWalletVotePlan(dir, epoch: 2)!['epoch'], 2);
    expect(File(votePlanPath(dir)).statSync().mode & 0x1ff, voteFileMode);
    expect(Directory(dir).statSync().mode & 0x1ff, voteDirMode);
  });

  test('a withdraw builder refuses a plaintext from', () {
    final blob = List<int>.filled(321, 7);
    blob[0] = 0xf1;
    final fs1 = List<int>.filled(41, 1);
    fs1[0] = 0xf1;
    final built = buildFundedWithdraw(
      to: 'shear1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2w5k2x',
      nanos: 1,
      id: 'wd',
      portalId: 'ab' * 32,
      anchor: 16,
      excess: List<int>.filled(32, 4),
      fs1: fs1,
      vin: [
        {'commit': List<int>.filled(32, 3)},
      ],
      admitProofs: [
        {'blob': blob, 'cTilde': List<int>.filled(32, 3)},
      ],
      retireProof: List<int>.filled(8, 1),
      principalProof: {'R': List<int>.filled(32, 2), 'z': List<int>.filled(32, 9)},
    );
    expect(built, isNotNull);
    expect(built!.containsKey('from'), isFalse);
    expect(
      buildFundedWithdraw(
        to: 'shear1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2w5k2x',
        nanos: 1,
        id: 'wd',
        portalId: 'ab' * 32,
        anchor: 16,
        excess: List<int>.filled(32, 4),
        fs1: fs1,
        vin: [
          {'commit': List<int>.filled(32, 3)},
        ],
        admitProofs: [
          {'blob': blob},
        ],
        retireProof: const [],
        principalProof: const {},
        from: 'shear1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2w5k2x',
      ),
      isNull,
    );
  });
}
