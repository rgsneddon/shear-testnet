import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_reserve.dart';

void main() {
  final levies = <int>{
    0,
    1,
    kLevyFloorUnits - 1,
    kLevyFloorUnits,
    kLevyFloorUnits + 1,
    2047,
    2048,
    2049,
    10000,
    100000,
    kLevyCapNanos - 1,
    kLevyCapNanos,
    kLevyCapNanos + 1,
  };
  for (var shift = 1; shift <= 20; shift++) {
    levies.add(1 << shift);
  }

  test('any levy is covered at equality, refused one nano short, and dust under 1e-12 still covers', () {
    for (final levy in levies) {
      final need = levy / kUnitsPerShe;
      expect(spendableCoversLevy(need, levy), isTrue, reason: 'equal $levy');
      expect(spendableCoversLevy(need - 1e-12, levy), isTrue, reason: 'epsilon $levy');
      if (levy == 0) {
        expect(spendableCoversLevy(-1, levy), isFalse);
        continue;
      }
      final oneNanoShort = (levy - 1) / kUnitsPerShe;
      expect(spendableCoversLevy(oneNanoShort, levy), isFalse, reason: 'nano $levy');
      expect(spendableCoversLevy(need - 2e-12, levy), isFalse, reason: 'past epsilon $levy');
      expect(spendableCoversLevy(need - 1e-13, levy), isTrue, reason: 'dust $levy');
    }
    expect(spendableCoversLevy(1, -1), isFalse);
    expect(spendableCoversLevy(1, -100000), isFalse);
    expect(spendableCoversLevy(double.nan, kLevyFloorUnits), isFalse);
    expect(spendableCoversLevy(double.negativeInfinity, kLevyFloorUnits), isFalse);
    expect(spendableCoversLevy(double.infinity, kLevyFloorUnits), isFalse);
  });

  test('a second claim while a submit is held does not start another post', () {
    expect(claimSingleSubmit(held: false), isTrue);
    for (var extra = 0; extra < 1000; extra++) {
      expect(claimSingleSubmit(held: true), isFalse, reason: 'extra $extra');
    }
    expect(claimSingleSubmit(held: false), isTrue);
  });

  test('the vote screen and the vote command share the levy cover', () async {
    final voteL = estimateSendLevyUnits(inputs: 1, outputs: 1);
    final need = voteL / kUnitsPerShe;
    final reserve = ShearReserve();
    final dest = kPoolFeeDest;
    reserve.portal(dest).staked = kPiSheNanos;

    final shortBook = ShearLedger();
    shortBook.replaceFromBackup(
      address: dest,
      spendable: (voteL - 1) / kUnitsPerShe,
      pending: 0,
      txs: const [],
    );
    expect(shortBook.spendableOwned(dest), closeTo((voteL - 1) / kUnitsPerShe, 1e-18));
    final short = await castPlannedLeafVotes(
      ledger: shortBook,
      reserve: reserve,
      planDir: '',
      restFrame: dest,
      dest: dest,
      choice: kVoteHold,
      local: true,
    );
    expect(short.enacted, isFalse);
    expect(short.remark, contains('Not enough Continuum spendable for vote tx fee'));

    final dustBook = ShearLedger();
    dustBook.replaceFromBackup(
      address: dest,
      spendable: need - 1e-13,
      pending: 0,
      txs: const [],
    );
    expect(dustBook.spendableOwned(dest), closeTo(need - 1e-13, 1e-18));
    // Current law: a book that covers the levy and has no census fails closed
    // as not_voter. It does not fall through to a portal vote.
    final dust = await castPlannedLeafVotes(
      ledger: dustBook,
      reserve: reserve,
      planDir: '',
      restFrame: dest,
      dest: dest,
      choice: kVoteHold,
      local: true,
    );
    expect(dust.remark, isNot(contains('Not enough Continuum spendable for vote tx fee')));
    expect(dust.remark, 'You’re not eligible to vote from this portal this epoch');

    final reserveSrc = File('lib/shear_reserve.dart').readAsStringSync();
    final commandStart = reserveSrc.indexOf('Future<ReserveVoteResult> castPlannedLeafVotes');
    final commandEnd = reserveSrc.indexOf('class ReserveVoteTower');
    final command = reserveSrc.substring(commandStart, commandEnd);
    expect(command, contains('spendableCoversLevy('));
    expect(command, contains('estimateSendLevyUnits(inputs: 1, outputs: 1)'));
    expect(command.contains('+ 1e-12 < needShe'), isFalse);
    expect(command.contains("contains('insufficient')"), isFalse);

    final main = File('lib/main.dart').readAsStringSync();
    final voteStart = main.indexOf('Future<void> _reserveVote(');
    final voteEnd = main.indexOf('List<Widget> _reservePane(');
    final vote = main.substring(voteStart, voteEnd);
    expect(vote, contains('spendableCoversLevy('));
    expect(vote.contains('< voteL / kUnitsPerShe'), isFalse);
    expect(vote, contains('claimSingleSubmit(held: _reserveVoteBusy)'));
    expect(main, contains('claimSingleSubmit(held: _flowSending)'));
  });
}
