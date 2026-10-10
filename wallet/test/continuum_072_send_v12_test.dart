import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_reserve.dart';

void main() {
  test('exact SHE text stays a decimal nanos string above 2^53', () {
    expect(parseSheDecimalToNanos('1'), '100000000000');
    expect(parseSheDecimalToNanos('0.00000000001'), '1');
    const scale = '100000000000';
    final above = BigInt.parse('9007199254740993');
    final she = above ~/ BigInt.parse(scale);
    final frac = (above % BigInt.parse(scale)).toString().padLeft(11, '0');
    final text = '$she.$frac';
    expect(parseSheDecimalToNanos(text), above.toString());
    expect(parseSheDecimalToNanos(text), isNot(above.toDouble().toString()));
    expect(parseSheDecimalToNanos('1.000000000001'), isNull);
    expect(parseSheDecimalToNanos(''), isNull);
  });

  test('selector caps any note count and keeps any lock out of the pay set', () {
    Map<String, dynamic> row(int i, num she, {int height = 1, bool locked = false}) => {
          'address': kPoolFeeDest,
          'amount': she,
          'height': height,
          'locked': locked,
          'spent': false,
        };
    for (final memo in [false, true]) {
      for (final n in [1, 3, kMaxInputsPerSend - 1, kMaxInputsPerSend, kMaxInputsPerSend + 1, 2000]) {
        final plan = selectSpendNotesWire({
          'notes': [for (var i = 0; i < n; i++) row(i, 1)],
          'needShe': 0.5,
          'tip': 40,
          'confs': 9,
          'memo': memo,
          'holdShe': 0,
        });
        expect(plan['stamp'], isNotEmpty);
        expect(plan['covered'], isTrue);
        final batches = (plan['batches'] as List).cast<Map>();
        for (final b in batches) {
          expect((b['notes'] as List).length, inInclusiveRange(1, kMaxInputsPerSend));
        }
      }
      final wide = selectSpendNotesWire({
        'notes': [for (var i = 0; i < 20; i++) row(i, 0.01)],
        'needShe': 0.01 * (kMaxInputsPerSend + 1),
        'tip': 40,
        'confs': 9,
        'memo': memo,
      });
      final wholeShe = selectSpendNotesWire({
        'notes': [for (var i = 0; i < 20; i++) row(i, 0.99)],
        'needShe': 10,
        'tip': 40,
        'confs': 9,
        'memo': memo,
      });
      expect((wholeShe['batches'] as List).length, greaterThan(1), reason: 'memo=$memo');
      final wideBatches = (wide['batches'] as List).cast<Map>();
      expect(wideBatches.length, greaterThan(1));
      for (final b in wideBatches) {
        expect((b['notes'] as List).length, inInclusiveRange(1, kMaxInputsPerSend));
      }
    }
    final held = selectSpendNotesWire({
      'notes': [
        row(0, 1),
        row(1, 4),
        row(2, 9, locked: true),
        row(3, 8, height: 40),
      ],
      'needShe': 4,
      'tip': 20,
      'confs': 9,
      'holdShe': 1,
    });
    final picked = (held['batches'] as List).cast<Map>().expand((b) => (b['notes'] as List)).toList();
    expect(picked, isNotEmpty);
    expect(picked.every((n) => n['she'] != 1 && n['she'] != 9 && n['she'] != 8), isTrue);
    expect(picked.first['she'], 4);
  });

  test('a second beginSend does not start another send', () async {
    final ledger = ShearLedger();
    expect(ledger.beginSend(), isTrue);
    final blocked = await submitContinuumSend(
      ledger: ledger,
      restFrame: 'she1rest',
      startTo: '',
      enteredTo: kPoolFeeDest,
      amount: 1,
    );
    expect(blocked.posted, isFalse);
    expect(blocked.remark, 'send_in_flight');
    ledger.endSend();
    expect(ledger.beginSend(), isTrue);
    ledger.endSend();
  });

  test('withdraw posts kind withdraw for any finished-epoch principal', () async {
    final ledger = ShearLedger();
    final reserve = ShearReserve();
    final dest = kPoolFeeDest;
    const samples = <int>[1, 100000000000, 9007199254740993];
    for (final principal in samples) {
      reserve.epochStartMs = 1;
      reserve.epochBps = 0;
      reserve.bonusEnacted = false;
      reserve.portal(dest)
        ..staked = principal
        ..idle = 0
        ..joined = true;
      reserve.totalLockedNanos = principal;
      final now = 1 + kReserveEpochMs;
      expect(reserveWithdrawPayoutNanos(reserve, dest, now), principal);
      final posted = await postReserveWithdraw(
        ledger,
        reserve: reserve,
        dest: dest,
        payout: dest,
        nowMs: now,
        local: true,
      );
      expect(posted, isNotNull, reason: 'principal=$principal');
      expect(posted!.tx.kind, 'withdraw');
      expect(posted.tx.kind, isNot('send'));
      expect(reserve.portal(dest).staked, 0);
    }
    reserve.epochBps = 100;
    reserve.epochStartMs = 1;
    reserve.portal(dest)
      ..staked = 100000000000
      ..idle = 0
      ..joined = true;
    reserve.totalLockedNanos = 100000000000;
    final withInterest = await postReserveWithdraw(
      ledger,
      reserve: reserve,
      dest: dest,
      payout: dest,
      nowMs: 1 + kReserveEpochMs,
      local: true,
    );
    expect(withInterest, isNotNull);
    expect(withInterest!.tx.kind, 'withdraw');
    expect(withInterest.settled['payout']!, greaterThan(100000000000));
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('vortex sums are one reconstruct labelled portal, program, and continuum', () {
    final reserve = ShearReserve();
    final dest = kPoolFeeDest;
    reserve.portal(dest).staked = 7;
    reserve.totalLockedNanos = 9007199254740993;
    final sums = reconstructVortexSums(reserve, dest, flowNanos: 11);
    expect(sums.yourNanos, 7);
    expect(sums.overallNanos, 9007199254740993);
    expect(sums.flowNanos, 11);
    final empty = reconstructVortexSums(reserve, '', flowNanos: 3);
    expect(empty.yourNanos, 0);
    expect(empty.flowNanos, 3);
  });

  test('vote errors are not rewritten into the fee sentence', () {
    final src = File('lib/shear_reserve.dart').readAsStringSync();
    final start = src.indexOf('Future<ReserveVoteResult> commandReserveVote');
    final end = src.indexOf('class ReserveVoteTower');
    expect(start, greaterThan(0));
    final body = src.substring(start, end);
    expect(body.contains("contains('insufficient')"), isFalse);
    expect(body, contains('estimateSendLevyUnits(inputs: 1, outputs: 1)'));
    expect(voteFailCopy(StateError('no_note')), isNot(contains('Not enough Continuum spendable')));
    expect(voteFailCopy(StateError('unsigned')), isNot(contains('Not enough Continuum spendable')));
    final main = File('lib/main.dart').readAsStringSync();
    expect(main, contains("key: const Key('flow-send-progress')"));
    expect(main, contains("key: const Key('flow-send-cancel')"));
    expect(main, contains('postReserveWithdraw('));
    expect(main, contains("key: const Key('vortex-your-portal')"));
    expect(main, contains("key: const Key('vortex-overall-program')"));
    final ledger = File('lib/shear_ledger.dart').readAsStringSync();
    expect(ledger, contains('Isolate.run(() => selectSpendNotesWire('));
    expect(ledger, contains('Isolate.run(() => sealSignReserveWire(input))'));
    final seal = ledger.indexOf('Future<Map<String, dynamic>> _reserveSealOffUi');
    final sealBody = ledger.substring(seal, ledger.indexOf('\n}', seal));
    expect(sealBody.contains('sealFlowOnCaller'), isFalse);
  });

  test('selector spendable is exact nanos minus locked and immature', () {
    const above = '9007199254740993';
    const other = '9007199254740995';
    const huge = '100000000000000000000';
    final lossyShe = BigInt.parse(above).toDouble() / kUnitsPerShe;
    Map<String, dynamic> row(
      String nanos, {
      bool locked = false,
      int height = 1,
      bool lossyAmount = false,
    }) =>
        {
          'address': kPoolFeeDest,
          'nanos': nanos,
          if (lossyAmount) 'amount': lossyShe,
          'height': height,
          'locked': locked,
          'spent': false,
        };
    final freeSum = (BigInt.parse(above) + BigInt.parse(other)).toString();
    for (final memo in [false, true]) {
      for (final n in [1, 3, kMaxInputsPerSend - 1, kMaxInputsPerSend, kMaxInputsPerSend + 1, 2000]) {
        final plan = selectSpendNotesWire({
          'notes': [
            for (var i = 0; i < n; i++)
              row(i.isEven ? above : other, lossyAmount: i == 0),
            row(huge, locked: true),
            row(huge, height: 40),
          ],
          'needNanos': '1',
          'tip': 40,
          'confs': 9,
          'memo': memo,
        });
        expect(plan['covered'], isTrue, reason: 'n=$n memo=$memo');
        final batches = (plan['batches'] as List).cast<Map>();
        for (final b in batches) {
          expect((b['notes'] as List).length, inInclusiveRange(1, kMaxInputsPerSend));
          expect(b['payNanos'], '1');
        }
        final picked = batches.expand((b) => (b['notes'] as List)).cast<Map>();
        expect(picked.every((note) => note['nanos'] != huge), isTrue);
        expect(picked.every((note) => note['nanos'] == above || note['nanos'] == other), isTrue);
      }
      final held = selectSpendNotesWire({
        'notes': [
          row(above, lossyAmount: true),
          row(other),
          row(huge, locked: true),
          row(huge, height: 40),
        ],
        'needNanos': '1',
        'holdNanos': above,
        'tip': 40,
        'confs': 9,
        'memo': memo,
      });
      expect(held['spendableNanos'], other, reason: 'memo=$memo');
      final heldNotes = (held['batches'] as List)
          .cast<Map>()
          .expand((b) => (b['notes'] as List))
          .cast<Map>();
      expect(heldNotes.single['nanos'], other);
    }
    final open = selectSpendNotesWire({
      'notes': [
        row(above, lossyAmount: true),
        row(other),
        row(huge, locked: true),
        row(huge, height: 40),
      ],
      'needNanos': '1',
      'tip': 40,
      'confs': 9,
    });
    expect(open['spendableNanos'], freeSum);
    final openNotes = (open['batches'] as List).cast<Map>().expand((b) => (b['notes'] as List)).cast<Map>();
    expect(openNotes.single['nanos'], other);
  });

  test('send nanos stay exact for any u64 and reject a wider string', () {
    expect(sendNanosFromWire(null), 0);
    expect(sendNanosFromWire('0'), 0);
    expect(sendNanosFromWire('1'), 1);
    expect(sendNanosFromWire('9007199254740993'), 9007199254740993);
    expect(sendNanosFromWire((BigInt.one << 62).toString()), (BigInt.one << 62).toInt());
    expect(sendNanosFromWire((BigInt.one << 63).toString()), (BigInt.one << 63).toInt());
    final maxU64 = (BigInt.one << 64) - BigInt.one;
    expect(sendNanosFromWire(maxU64.toString()), maxU64.toInt());
    expect(sendNanosFromWire((BigInt.one << 64).toString()), 0);
    expect(sendNanosFromWire('-1'), 0);
    expect(sendNanosFromWire('1.5'), 0);
    expect(sendNanosFromWire(' 1'), 0);
    expect(sendNanosFromWire('1 '), 0);
  });

  test('one hold is the larger of the lock sum and the reserve principal', () {
    final one = BigInt.one;
    final above = BigInt.parse('9007199254740993');
    final huge = BigInt.parse('100000000000000000000');
    expect(
      selectionHoldNanos(lockDebits: [one], reservePrincipals: [one]),
      '1',
    );
    expect(
      selectionHoldNanos(lockDebits: [above], reservePrincipals: [one]),
      above.toString(),
    );
    expect(
      selectionHoldNanos(lockDebits: [one], reservePrincipals: [above]),
      above.toString(),
    );
    expect(
      selectionHoldNanos(lockDebits: [huge], reservePrincipals: [huge]),
      huge.toString(),
    );
    expect(
      selectionHoldNanos(lockDebits: [huge, above], reservePrincipals: [huge]),
      (huge + above).toString(),
    );
    expect(
      selectionHoldNanos(lockDebits: [above, above], reservePrincipals: [BigInt.zero]),
      (above * BigInt.two).toString(),
    );
    expect(
      selectionHoldNanos(lockDebits: [BigInt.from(-5), one], reservePrincipals: const []),
      '1',
    );
  });
}
