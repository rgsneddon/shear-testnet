import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
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

  test('any amount quotes the weight floor and a sealed body binds once', () {
    const amounts = <int>[0, 1, 100, 100000000000, 500000000000, 10000000000000, 9007199254740993];
    for (final amount in amounts) {
      expect(levyNanos(amount), kLevyFloorUnits, reason: 'amount=$amount');
      expect(levyNanos(amount, depth: 1 << 20), kLevyFloorUnits, reason: 'depth amount=$amount');
      expect(levyBase(amount), kLevyFloorUnits, reason: 'base amount=$amount');
    }
    const weights = <int>[0, 1, 2047, 2048, 2049, 204800, 426512, 5000000];
    for (final weight in weights) {
      final raw = (weight + kLevyWeightRateDen - 1) ~/ kLevyWeightRateDen;
      final quote = raw < kLevyFloorUnits ? kLevyFloorUnits : raw;
      expect(levyFromWeight(weight), quote, reason: 'weight=$weight');
      expect(levyNanos(9007199254740993, weight: weight), quote, reason: 'named weight=$weight');
      final body = <String, dynamic>{'kind': 'send', 'fee': 1, 'pad': 'a' * weight};
      expect(levyNanos(1, tx: body), levyFromWeight(flowWeight(body)), reason: 'tx weight=$weight');
    }
    final posted = <String, dynamic>{'kind': 'send', 'fee': 7, 'pad': 'b' * 3000};
    final before = flowWeight(posted);
    bindWeightFee(posted);
    expect(posted['fee'], levyFromWeight(before));
    expect(posted['maxLevy'], isNull);
    final withCap = <String, dynamic>{'kind': 'lock', 'fee': 1, 'maxLevy': 1, 'pad': 'c' * 100};
    final capBefore = flowWeight(withCap);
    bindWeightFee(withCap);
    expect(withCap['fee'], levyFromWeight(capBefore));
    expect(withCap['maxLevy'], withCap['fee']);
    final withdraw = <String, dynamic>{'kind': 'withdraw', 'fee': 7, 'pad': 'd' * 9000};
    bindWeightFee(withdraw);
    expect(withdraw['fee'], 7);
    for (final reserved in <int>[kLevyFloorUnits, 265, 1000, 50000]) {
      final light = <String, dynamic>{'kind': 'send', 'pad': 'e' * 64};
      expect(sealedFeeCovers(reserved, light), isTrue, reason: 'reserved=$reserved');
      expect(light.containsKey('fee'), isFalse);
    }
    final heavy = <String, dynamic>{'kind': 'send', 'pad': 'f' * 500000};
    expect(sealedFeeCovers(kLevyFloorUnits, heavy), isFalse);
    expect(heavy.containsKey('fee'), isFalse);
    expect(voteFailCopy(StateError('levy')), isNot(contains('Not enough Continuum spendable')));
    expect(voteFailCopy(StateError('insufficient')), isNot(contains('Not enough Continuum spendable')));
    expect(flowSendAdvisoryOf(StateError('levy')), isNot(contains('Not enough Continuum spendable')));
    expect(flowSendAdvisoryOf(StateError('fee_short')), kErrFeeShort);
    const above = 9007199254740993;
    expect(formatSheFromNanos(above), '90071.99254740993');
    expect(formatSheFromNanos(above), isNot(formatShe(above / kUnitsPerShe)));
    expect(formatSheFromNanos(kUnitsPerShe), formatShe(1));
    expect(
      vortexFlowNanos(spendableShe: 1, exactNotes: [BigInt.from(above)]),
      kUnitsPerShe,
    );
    expect(
      vortexFlowNanos(spendableShe: 1e20, exactNotes: [BigInt.from(above), BigInt.one]),
      above + 1,
    );
    expect(vortexFlowNanos(spendableShe: 0, exactNotes: [BigInt.from(above)]), 0);
    final main = File('lib/main.dart').readAsStringSync();
    expect(main, contains('continuumFlowNanos('));
    expect(main, contains('formatSheFromNanos(reserve.totalLockedNanos)'));
    final ledger = File('lib/shear_ledger.dart').readAsStringSync();
    expect(ledger, contains('sealedFeeCovers(feeUnits'));
    expect(ledger, contains('kSendProveBudgetMs ~/ kMeasuredProveMs'));
    expect(ledger, contains('kMeasuredProofHexBytes'));
    expect(ledger, isNot(contains('kMaxInputsPerSend = 8')));
  });

  test('the input cap is the tighter of prove time and tx size', () {
    expect(kMaxInputsPerSend, measuredInputCap());
    expect(kConsolidateAboveCount, kMaxInputsPerSend);
    expect(kMaxInputsPerSend, greaterThan(1));
    expect(kSendTimeCap, kSendProveBudgetMs ~/ kMeasuredProveMs);
    final loose = measuredInputCap(outputs: 1);
    final tight = measuredInputCap(outputs: 12, memo: true);
    expect(tight, lessThan(loose));
    expect(tight, lessThanOrEqualTo(kSendTimeCap));
    final src = File('lib/shear_ledger.dart').readAsStringSync();
    expect(src, contains('kSendTimeCap < kSendSizeCap ? kSendTimeCap : kSendSizeCap'));
    expect(src, isNot(contains('kMaxInputsPerSend = 8')));

    Map<String, dynamic> row(String nanos, {int height = 1}) => {
          'address': kPoolFeeDest,
          'nanos': nanos,
          'height': height,
          'locked': false,
          'spent': false,
        };
    final amounts = <String>['1000', '100000000000', '9007199254740993'];
    final counts = <int>[1, 3, kMaxInputsPerSend - 1, kMaxInputsPerSend, kMaxInputsPerSend + 1, 2000];
    for (final memo in [false, true]) {
      final cap = measuredInputCap(memo: memo);
      for (final n in counts) {
        for (final amt in amounts) {
          if (n >= 2000 && amt != amounts.first) continue;
          final notes = <Map<String, dynamic>>[
            for (var i = 0; i < n; i++) row(i.isEven ? amt : '1'),
            row('9007199254740995', height: 80),
          ];
          final dust = selectSpendNotesWire({
            'notes': notes,
            'needNanos': '1',
            'tip': 40,
            'confs': 9,
            'memo': memo,
            'cap': 100000,
          });
          expect(dust['covered'], isTrue, reason: 'dust n=$n amt=$amt memo=$memo');
          final batches = (dust['batches'] as List).cast<Map>();
          expect(batches, isNotEmpty);
          for (final b in batches) {
            expect((b['notes'] as List).length, inInclusiveRange(1, cap), reason: 'n=$n amt=$amt memo=$memo');
          }
        }
      }
      final mixed = selectSpendNotesWire({
        'notes': [for (final amt in amounts) row(amt)],
        'needNanos': '9007199254740993',
        'tip': 40,
        'confs': 9,
        'memo': memo,
      });
      expect(mixed['covered'], isTrue, reason: 'mixed memo=$memo');
      final mixedNotes = ((mixed['batches'] as List).first as Map)['notes'] as List;
      expect(mixedNotes.length, lessThanOrEqualTo(cap));
      expect((mixedNotes.first as Map)['nanos'], '9007199254740993');
    }
    for (final nDust in <int>[1, kMaxInputsPerSend, 2000]) {
      final onlyDust = selectSpendNotesWire({
        'notes': [for (var i = 0; i < nDust; i++) row('1')],
        'needNanos': '1',
        'tip': 40,
        'confs': 9,
      });
      expect(onlyDust['covered'], isFalse, reason: 'dust notes n=$nDust');
      expect(onlyDust['shortFee'], isTrue, reason: 'dust notes n=$nDust');
    }
    final n = kMaxInputsPerSend;
    final one = BigInt.from(kUnitsPerShe);
    final fee = BigInt.from(estimateSendLevyUnits(inputs: n));
    final full = one * BigInt.from(n) - fee;
    final whole = selectSpendNotesWire({
      'notes': [for (var i = 0; i < n; i++) row(one.toString())],
      'needNanos': full.toString(),
      'tip': 40,
      'confs': 9,
    });
    expect(whole['covered'], isTrue);
    expect((whole['batches'] as List), hasLength(1));
    expect(((whole['batches'] as List).first as Map)['payNanos'], full.toString());
    expect(((whole['batches'] as List).first as Map)['notes'], hasLength(n));

    final over = selectSpendNotesWire({
      'notes': [for (var i = 0; i < n + 1; i++) row(one.toString())],
      'needNanos': (one * BigInt.from(n)).toString(),
      'tip': 40,
      'confs': 9,
      'cap': n + 50,
    });
    expect(over['covered'], isTrue);
    final overBatches = (over['batches'] as List).cast<Map>();
    expect(overBatches.length, greaterThan(1));
    for (final b in overBatches) {
      expect((b['notes'] as List).length, inInclusiveRange(1, n));
    }
  });

  test('a surplus under the old percent fee still sends', () async {
    for (final amount in <double>[0.01, 1, 4, 50, 100]) {
      final alice = createIdentity();
      final ledger = ShearLedger()..bindIdentity(alice);
      final from = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
      final surplus = 1000 / kUnitsPerShe;
      ledger.confirmRound(address: from, pot: amount + surplus, height: 1);
      ledger.settleTo(1 + ShearLedger.spendableConfirmations);
      final tx = await ledger.send(
        from: from,
        to: kPoolFeeDest,
        amount: amount,
        local: true,
        restFrame: alice.address,
        paymentCode: alice.paymentCode,
      );
      expect(tx.kind, 'send', reason: 'amount=$amount');
    }
  });

  test('a pool withdraw posts kind withdraw and the exact nanos', () async {
    final pool = _RecordWithdraw();
    final ledger = ShearLedger(pool: pool);
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
      final posted = await postReserveWithdraw(
        ledger,
        reserve: reserve,
        dest: dest,
        payout: dest,
        nowMs: now,
      );
      expect(posted, isNotNull, reason: 'principal=$principal');
      expect(posted!.tx.kind, 'withdraw');
      expect(pool.posts, isNotEmpty);
      final body = pool.posts.last;
      expect(body['kind'], 'withdraw', reason: 'principal=$principal');
      expect(body['nanosWire'], principal.toString(), reason: 'principal=$principal');
      expect(reserve.portal(dest).staked, 0);
    }
    final src = File('lib/shear_reserve.dart').readAsStringSync();
    final start = src.indexOf('postReserveWithdraw(');
    final slice = src.substring(start, src.indexOf('}) async', start));
    expect(slice.contains('bool local = false'), isTrue);
  }, timeout: const Timeout(Duration(seconds: 45)));
}

class _RecordWithdraw extends ShearPoolClient {
  _RecordWithdraw()
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 30),
        );

  final posts = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> mempoolPressure() async => {'depth': 0};

  @override
  Future<Map<String, dynamic>> send({
    required String from,
    required String to,
    required double amount,
    Map<String, dynamic>? memoCt,
    String? open,
    String? sig,
    String? portalOpen,
    String? kind,
    String? programId,
    String? choice,
    int? currentEpoch,
    int? epochStartMs,
    String? change,
    String? spendPub,
    String? ephPub,
    List<dynamic>? vin,
    List<dynamic>? vout,
    dynamic excess,
    Map<String, dynamic>? admitProof,
    List<Map<String, dynamic>>? admitProofs,
    String? spendTag,
    int? fee,
    int paintedOwedNanos = 0,
    bool legacyPoolSend = false,
    String? nanosWire,
  }) async {
    posts.add({
      'kind': kind,
      'nanosWire': nanosWire,
      'from': from,
      'to': to,
    });
    return {
      'ok': true,
      'tx': {
        'id': 'wd-${posts.length}',
        'from': from,
        'to': to,
        'amount': amount,
        'kind': kind ?? 'send',
      },
    };
  }
}
