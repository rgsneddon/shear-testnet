import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_fs1.dart' show kFs1InputMax;
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_pack.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_ristretto.dart';

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
          'confs': 9, 'allowBare': true,
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
        'confs': 9, 'allowBare': true,
        'memo': memo,
      });
      final wholeShe = selectSpendNotesWire({
        'notes': [for (var i = 0; i < 20; i++) row(i, 0.99)],
        'needShe': 10,
        'tip': 40,
        'confs': 9, 'allowBare': true,
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
      'confs': 9, 'allowBare': true,
      'holdShe': 1,
    });
    final picked = (held['batches'] as List).cast<Map>().expand((b) => (b['notes'] as List)).toList();
    expect(picked, isNotEmpty);
    expect(picked.every((n) => n['she'] != 1 && n['she'] != 9 && n['she'] != 8), isTrue);
    expect(picked.first['she'], 4);
  });

  test('a second beginSend does not start another send', () async {
    const wires = <String>['1', '1000', '100000000000', '9007199254740993'];
    for (final wire in wires) {
      final ledger = ShearLedger();
      expect(ledger.beginSend(), isTrue, reason: wire);
      final blocked = await submitContinuumSend(
        ledger: ledger,
        restFrame: 'she1rest',
        startTo: '',
        enteredTo: encodeDestAddress(
          Uint8List.fromList(List.filled(20, 4)),
          admitBaseBytes(Uint8List.fromList(List.generate(32, (i) => i + 1))),
        ),
        amount: 1,
        nanosWire: wire,
        publicIpConsent: true,
      );
      expect(blocked.posted, isFalse, reason: wire);
      expect(blocked.remark, 'send_in_flight', reason: wire);
      ledger.endSend();
      expect(ledger.beginSend(), isTrue, reason: wire);
      ledger.endSend();
    }
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
      // Current law: no leaves and local:true do not settle. There is no
      // `from` send fallback.
      final posted = await postReserveWithdraw(
        ledger,
        reserve: reserve,
        dest: dest,
        payout: dest,
        nowMs: now,
        local: true,
      );
      expect(posted, isNull, reason: 'principal=$principal');
      expect(reserve.portal(dest).staked, principal);
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
    expect(withInterest, isNull);
    expect(reserve.portal(dest).staked, 100000000000);
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
    final start = src.indexOf('Future<ReserveVoteResult> castPlannedLeafVotes');
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
          'confs': 9, 'allowBare': true,
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
        'confs': 9, 'allowBare': true,
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
      'confs': 9, 'allowBare': true,
    });
    expect(open['spendableNanos'], freeSum);
    final openNotes = (open['batches'] as List).cast<Map>().expand((b) => (b['notes'] as List)).cast<Map>();
    expect(openNotes.single['nanos'], other);
  });

  test('selector skips any unsealed note for any amount and any count', () {
    final one = Uint8List(32)..[0] = 1;
    expect(
      noteHasSealedSpendBytes({'commit': one, 'r': one, 'amount': 4}),
      isFalse,
    );
    expect(
      noteHasSealedSpendBytes({'commit': Uint8List(0), 'noteCommit': one, 'r': one}),
      isFalse,
    );
    expect(
      noteHasSealedSpendBytes({'commit': one, 'noteCommit': one, 'r': one}),
      isTrue,
    );
    const amounts = <num>[0.00000000001, 1, 4, 1000000];
    final counts = <int>[1, 3, kMaxInputsPerSend - 1, kMaxInputsPerSend, kMaxInputsPerSend + 1, 2000];
    for (final she in amounts) {
      for (final n in counts) {
        final plan = selectSpendNotesWire({
          'notes': [
            for (var i = 0; i < n; i++)
              {
                'address': kPoolFeeDest,
                'amount': she,
                'height': 1,
                'spent': false,
                'sealed': false,
              },
            {
              'address': kPoolFeeDest,
              'amount': 0.5,
              'nanos': '50000000000',
              'height': 1,
              'spent': false,
              'sealed': true,
            },
          ],
          'needShe': 0.1,
          'tip': 40,
          'confs': 9, 'allowBare': true,
        });
        expect(plan['covered'], isTrue, reason: 'n=$n she=$she');
        final picked = (plan['batches'] as List)
            .cast<Map>()
            .expand((b) => (b['notes'] as List))
            .cast<Map>();
        expect(picked.single['nanos'], '50000000000', reason: 'n=$n she=$she');
      }
    }
    final none = selectSpendNotesWire({
      'notes': [
        for (final she in amounts)
          {
            'address': kPoolFeeDest,
            'amount': she,
            'height': 1,
            'spent': false,
            'sealed': false,
          },
      ],
      'needShe': 0.1,
      'tip': 40,
      'confs': 9, 'allowBare': true,
    });
    expect(none['covered'], isFalse);
    expect(none['empty'], isTrue);
    expect(none['spendableNanos'], '0');
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

  test('a pay above 2^63 keeps the u64 in the opening and the seal', () {
    final wires = <String>[
      '1',
      '9007199254740993',
      (BigInt.one << 63).toString(),
      ((BigInt.one << 64) - BigInt.one).toString(),
    ];
    for (final wire in wires) {
      final units = sendUnitsFromWire(wire);
      expect(units, BigInt.parse(wire), reason: wire);
      final note = sealCoinbaseUnits(units, kind: 'send');
      expect(openedSpendDigits(note), wire, reason: wire);
      expect(verifyValueUnits(note['commit'] as Uint8List, units, note['valueProof'] as Map), isTrue, reason: wire);
      if (units.bitLength > 63) {
        final clamped = BigInt.from(units.toInt());
        expect(clamped, isNot(units), reason: wire);
        expect(
          verifyValueUnits(note['commit'] as Uint8List, clamped, note['valueProof'] as Map),
          isFalse,
          reason: wire,
        );
      }
    }
    expect(sendUnitsFromWire((BigInt.one << 64).toString()), BigInt.zero);

    final max = (BigInt.one << 64) - BigInt.one;
    BigInt? seen;
    var intSeals = 0;
    debugNativeSealUnits = (v, {dest20, kind = 'send'}) {
      seen = v;
      return {'kind': kind, 'nanos': v.toString()};
    };
    debugNativeSealNote = (v, {dest20, kind = 'send'}) {
      intSeals += 1;
      return {'kind': kind, 'nanos': v};
    };
    addTearDown(() {
      debugNativeSealUnits = null;
      debugNativeSealNote = null;
    });
    final built = sealFlowSpendVouts({
      'spendSeed': Uint8List(32),
      'destTo': 'not-an-address',
      'src': 'not-an-address',
      'vouts': [
        {'address': 'not-an-address', 'nanos': max.toString(), 'kind': 'send'},
      ],
    });
    expect(seen, max);
    expect(intSeals, 0);
    expect(((built['vouts'] as List).single as Map)['nanos'], max.toString());

    final exact = spendPackDigest(
      from: 'ssa1q',
      vout: [
        {'kind': 'lock', 'nanos': max.toString()},
      ],
      kind: 'lock',
    );
    final clampedPack = spendPackDigest(
      from: 'ssa1q',
      vout: [
        {'kind': 'lock', 'nanos': max.toInt()},
      ],
      kind: 'lock',
    );
    expect(exact, isNot(clampedPack));
    expect(
      spendPackDigest(from: 'ssa1q', vout: [
        {'kind': 'lock', 'nanos': '1'},
      ], kind: 'lock'),
      spendPackDigest(from: 'ssa1q', vout: [
        {'kind': 'lock', 'nanos': 1},
      ], kind: 'lock'),
    );
  });

  test('nativeSealUnits attaches a node range blob for any u64', () {
    expect(debugNativeSealUnits, isNull);
    expect(debugNativeSealNote, isNull);
    final wires = <String>[
      '1',
      '9007199254740993',
      (BigInt.one << 63).toString(),
      ((BigInt.one << 64) - BigInt.one).toString(),
    ];
    final notes = <Map<String, dynamic>>[];
    for (final wire in wires) {
      final units = BigInt.parse(wire);
      final sw = Stopwatch()..start();
      final note = nativeSealUnits(units, kind: 'send');
      expect(sw.elapsedMilliseconds, lessThan(60000), reason: 'bound wire=$wire');
      final proof = note['rangeProof'];
      final commit = note['commit'];
      expect(proof, isA<Uint8List>(), reason: wire);
      expect(commit, isA<Uint8List>(), reason: wire);
      final blob = proof as Uint8List;
      expect(blob.length, greaterThan(1), reason: wire);
      expect(blob[0], 2, reason: wire);
      expect(_nodeRangeOk(commit as Uint8List, blob), isTrue, reason: wire);
      final flipped = Uint8List.fromList(blob);
      flipped[flipped.length - 1] ^= 1;
      expect(_nodeRangeOk(commit, flipped), isFalse, reason: 'flip $wire');
      final trailed = Uint8List(blob.length + 1)..setAll(0, blob);
      expect(_nodeRangeOk(commit, trailed), isFalse, reason: 'trail $wire');
      expect(openedSpendDigits(note), wire, reason: wire);
      if (units.bitLength > 63) {
        expect(note['nanos'], wire, reason: wire);
      }
      notes.add(note);
    }
    for (var i = 0; i < notes.length; i++) {
      for (var j = 0; j < notes.length; j++) {
        if (i == j) continue;
        expect(
          _nodeRangeOk(notes[i]['commit'] as Uint8List, notes[j]['rangeProof'] as Uint8List),
          isFalse,
          reason: 'proof $j on commit $i',
        );
      }
    }
    final max = (BigInt.one << 64) - BigInt.one;
    final built = sealFlowSpendVouts({
      'spendSeed': Uint8List(32),
      'destTo': 'not-an-address',
      'src': 'not-an-address',
      'vouts': [
        {'address': 'not-an-address', 'nanos': max.toString(), 'kind': 'send'},
      ],
    });
    final sent = (built['vouts'] as List).single as Map;
    final sentProof = sent['rangeProof'];
    final sentCommit = sent['commit'];
    expect(sentProof, isA<Uint8List>());
    expect(sentCommit, isA<Uint8List>());
    expect((sentProof as Uint8List)[0], 2);
    expect(_nodeRangeOk(sentCommit as Uint8List, sentProof), isTrue);
    expect(sent['nanos'], max.toString());
    expect(debugNativeSealUnits, isNull);
    expect(debugNativeSealNote, isNull);
  }, timeout: const Timeout(Duration(minutes: 4)));

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
    final tight = measuredInputCap(outputs: 16, memo: true);
    expect(tight, lessThan(loose));
    expect(measuredInputCap(outputs: 12, memo: true), lessThanOrEqualTo(loose));
    expect(loose, lessThanOrEqualTo(kFs1InputMax));
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
            'confs': 9, 'allowBare': true,
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
        'confs': 9, 'allowBare': true,
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
        'confs': 9, 'allowBare': true,
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
      'confs': 9, 'allowBare': true,
    });
    expect(whole['covered'], isTrue);
    expect((whole['batches'] as List), hasLength(1));
    expect(((whole['batches'] as List).first as Map)['payNanos'], full.toString());
    expect(((whole['batches'] as List).first as Map)['notes'], hasLength(n));

    final over = selectSpendNotesWire({
      'notes': [for (var i = 0; i < n + 1; i++) row(one.toString())],
      'needNanos': (one * BigInt.from(n)).toString(),
      'tip': 40,
      'confs': 9, 'allowBare': true,
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

  test('send keeps change nanos exact for any amount', () async {
    expect(debugNativeSealNote, isNull);
    expect(debugNativeSealUnits, isNull);
    final fee = BigInt.from(levyNanos(0));
    expect(fee, BigInt.from(levyNanos(1)));
    expect(fee, greaterThan(BigInt.zero));
    final scale = BigInt.from(kUnitsPerShe);
    final above53 = BigInt.parse('9007199254740993');
    final below53 = above53 - BigInt.two;
    final above63 = BigInt.one << 63;
    final cases = <({BigInt pay, BigInt change, String? memo})>[
      (pay: BigInt.one, change: BigInt.one, memo: null),
      (pay: scale, change: scale * BigInt.from(50), memo: null),
      (pay: BigInt.one, change: below53, memo: null),
      (pay: BigInt.one, change: above53, memo: null),
      (pay: above53, change: scale, memo: null),
      (pay: BigInt.one, change: above63, memo: null),
      (pay: BigInt.one, change: above63 + BigInt.from(4099), memo: null),
      (pay: BigInt.from(7), change: BigInt.from(11), memo: 'note'),
      (pay: scale, change: BigInt.zero, memo: null),
    ];
    final pool = _RecordChange();
    for (final c in cases) {
      final input = c.pay + fee + c.change;
      expect(input.bitLength, lessThanOrEqualTo(64), reason: 'pay=${c.pay} change=${c.change}');
      final sw = Stopwatch()..start();
      final sent = await _sendChange(
        pool,
        input: input,
        pay: c.pay,
        memo: c.memo,
      );
      expect(sw.elapsedMilliseconds, lessThan(180000), reason: 'pay=${c.pay} change=${c.change}');
      final kinds = (pool.posts.last['kinds'] as List).where((k) => k == 'send').length;
      if (c.change == BigInt.zero) {
        expect(sent.tx.change, isNull, reason: 'pay=${c.pay}');
        expect(sent.ledger.notes, isEmpty, reason: 'pay=${c.pay}');
        expect(kinds, 1, reason: 'pay=${c.pay}');
        continue;
      }
      expect(sent.tx.change, isNotNull, reason: 'change=${c.change}');
      final rows = sent.ledger.notes.where((n) => n['address'] == sent.tx.change).toList();
      expect(rows, hasLength(1), reason: 'change=${c.change}');
      final note = rows.single;
      expect(noteNanosExact(note), c.change, reason: 'change=${c.change}');
      expect(openedSpendDigits(note), c.change.toString(), reason: 'change=${c.change}');
      if (c.change.bitLength > 63) {
        expect(note['nanos'], c.change.toString(), reason: 'change=${c.change}');
        expect(note['nanos'], isA<String>());
      }
      final proof = note['rangeProof'];
      final commit = note['commit'];
      expect(proof, isA<Uint8List>(), reason: 'change=${c.change}');
      expect(commit, isA<Uint8List>(), reason: 'change=${c.change}');
      expect((proof as Uint8List)[0], 2, reason: 'change=${c.change}');
      expect(_nodeRangeOk(commit as Uint8List, proof), isTrue, reason: 'change=${c.change}');
      expect(kinds, 2, reason: 'change=${c.change} memo=${c.memo}');
    }
    final tooWide = (BigInt.one << 64) + fee + BigInt.one;
    await expectLater(
      _sendChange(pool, input: tooWide, pay: BigInt.one),
      throwsA(isA<StateError>().having((e) => e.message, 'msg', 'fee_short')),
    );
  }, timeout: const Timeout(Duration(minutes: 8)));

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
      // Current law: a withdraw with no lock leaves does not post and does
      // not settle. The legacy `from` body is gone.
      final posted = await postReserveWithdraw(
        ledger,
        reserve: reserve,
        dest: dest,
        payout: dest,
        nowMs: now,
        publicIpConsent: true,
      );
      expect(posted, isNull, reason: 'principal=$principal');
      expect(pool.posts, isEmpty);
      expect(reserve.portal(dest).staked, principal);
    }
    final src = File('lib/shear_reserve.dart').readAsStringSync();
    final start = src.indexOf('postReserveWithdraw(');
    final slice = src.substring(start, src.indexOf('}) async', start));
    expect(slice.contains('bool local = false'), isTrue);
  }, timeout: const Timeout(Duration(seconds: 45)));
}

/// One shipped [ShearLedger.send]. The change note is whatever send stored.
Future<({ShearLedger ledger, ShearTx tx})> _sendChange(
  _RecordChange pool, {
  required BigInt input,
  required BigInt pay,
  String? memo,
}) async {
  final seed = scalarBytes(randomScalar());
  final alice = createIdentity(seed);
  final ledger = ShearLedger(pool: pool)..bindIdentity(alice);
  final from = ledger.homeDest(alice.address, paymentCode: alice.paymentCode);
  ledger.confirmRound(address: from, pot: 2, height: 1);
  ledger.settleTo(1 + ShearLedger.spendableConfirmations);
  final commit = scalarBytes(randomScalar());
  final noteCommit = scalarBytes(randomScalar());
  final note = <String, dynamic>{
    'kind': 'pot',
    'address': from,
    'dest': from,
    'commit': commit,
    'noteCommit': noteCommit,
    'r': scalarBytes(randomScalar()),
    'nanos': input.toString(),
    'spent': false,
  };
  pool.pub = pointBytes(admitPub(admitScalarFromSeed(seed, note)));
  pool.commit = commit;
  final bob = createIdentity(scalarBytes(randomScalar()));
  final tx = await ledger.send(
    from: from,
    to: memo == null ? kPoolFeeDest : bob.paymentCodeFull,
    amount: 1,
    nanosWire: pay.toString(),
    memo: memo,
    local: false,
    restFrame: alice.address,
    paymentCode: alice.paymentCode,
    spendSeed: seed,
    spendNote: note,
  );
  return (ledger: ledger, tx: tx);
}

class _RecordChange extends ShearPoolClient {
  _RecordChange()
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 30),
        );

  Uint8List? pub;
  Uint8List? commit;
  final posts = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> mempoolPressure() async => {'depth': 0};

  @override
  Future<Map<String, dynamic>> fluxset() async => {
        'pubs': [pub],
        'commits': [commit],
      };

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
    bool publicConsent = false,
    String? nanosWire,
    String? id,
    String? withdrawNonce,
    String? portalId,
    String? payoutPortalId,
    String? lockAuth,
    String? ownerPub,
    String? vaultLockNote,
    String? fs1,
    int? anchor,
  }) async {
    posts.add({
      'kinds': [
        for (final row in vout ?? const [])
          if (row is Map) row['kind'],
      ],
    });
    return {
      'ok': true,
      'tx': {
        'id': 'chg-${posts.length}',
        'from': from,
        'to': to,
        'amount': amount,
        'kind': kind ?? 'send',
      },
    };
  }
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
    bool publicConsent = false,
    String? nanosWire,
    String? id,
    String? withdrawNonce,
    String? portalId,
    String? payoutPortalId,
    String? lockAuth,
    String? ownerPub,
    String? vaultLockNote,
    String? fs1,
    int? anchor,
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

String _rangeHex(Uint8List b) => b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();

/// The same node verifier T18 uses. A different commit, a flipped byte, or a
/// trailing byte must not pass.
bool _nodeRangeOk(Uint8List commit, Uint8List proof) {
  final script = File('test/t18_range_verify.mjs');
  if (!script.existsSync()) return false;
  final tmp = File(
    '${Directory.systemTemp.path}/shear-range-verify-${DateTime.now().microsecondsSinceEpoch}.json',
  );
  tmp.writeAsStringSync(
    '{"commit":"${_rangeHex(commit)}","proof":"${_rangeHex(proof)}"}',
    flush: true,
  );
  try {
    final result = Process.runSync('node', [script.path, tmp.path]);
    return result.exitCode == 0 && result.stdout.toString().contains('ok');
  } finally {
    if (tmp.existsSync()) tmp.deleteSync();
  }
}
