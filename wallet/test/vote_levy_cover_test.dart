import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart' show vaultDest;
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_reserve.dart';

import 'support/sealed_book.dart';

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
    // Spendable is real sealed notes mined deep enough, never a backup or
    // remembered figure (Gate 3, 25 Oct). A note is whole protocol units, so
    // the boundary is one unit: a note one unit short of the vote levy is
    // refused by the command, a note of exactly the levy covers it. The
    // sub-unit dust case is spendableCoversLevy itself, in the first test.
    final id = createIdentity();
    final seed = seedOf(id);
    final dest = vaultDest(id.address, viewKey: id.viewKey)!;
    final reserve = ShearReserve();
    reserve.portal(dest).staked = kPiSheNanos;
    ShearLedger bookOf(int units) {
      final ledger = ShearLedger()..bindIdentity(id);
      final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
      ledger.rememberNote(sealedNoteOn(home, seed, units, height: 1));
      ledger.noteLiveHeight(1 + ShearLedger.spendableConfirmations);
      ledger.settleTo(1 + ShearLedger.spendableConfirmations);
      ledger.recheckRestFrameSpendable(id.address, paymentCode: id.paymentCode);
      expect(
        (ledger.spendableOwned(id.address, paymentCode: id.paymentCode) * kUnitsPerShe).round(),
        units,
      );
      return ledger;
    }

    final short = await castPlannedLeafVotes(
      ledger: bookOf(voteL - 1),
      reserve: reserve,
      planDir: '',
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: dest,
      choice: kVoteHold,
      local: true,
    );
    expect(short.enacted, isFalse);
    expect(short.remark, contains('Not enough Continuum spendable for vote tx fee'));

    // Current law: a book that covers the levy and has no census fails closed
    // as not_voter. It does not fall through to a portal vote.
    final exact = await castPlannedLeafVotes(
      ledger: bookOf(voteL),
      reserve: reserve,
      planDir: '',
      restFrame: id.address,
      paymentCode: id.paymentCode,
      dest: dest,
      choice: kVoteHold,
      local: true,
    );
    expect(exact.remark, isNot(contains('Not enough Continuum spendable for vote tx fee')));
    expect(exact.remark, 'You’re not eligible to vote from this portal this epoch');
    expect(need, voteL / kUnitsPerShe);

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
