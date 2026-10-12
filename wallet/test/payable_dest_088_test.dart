import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_levy.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_qr.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_session.dart';

String longDest(int tag, int seedByte) {
  final dest20 = Uint8List.fromList(List.filled(20, tag));
  final seed = Uint8List.fromList(List.filled(32, seedByte));
  seed[0] = tag;
  return encodeDestAddress(dest20, admitBaseBytes(seed));
}

void main() {
  test('a payable dest is dest20||B for any tag, and every other form is refused', () {
    final id = createIdentity();
    for (final tag in [0, 1, 7, 19, 255]) {
      for (final seedByte in [1, 9, 40, 200]) {
        final dest = longDest(tag, seedByte);
        expect(isDestAddress(dest), isTrue, reason: 'tag=$tag seed=$seedByte');
        expect(isPayableDest(dest), isTrue, reason: 'tag=$tag seed=$seedByte');
        expect(continuumPayable(dest), isTrue, reason: 'tag=$tag seed=$seedByte');
        expect(parseReceiveQr(dest), dest, reason: 'tag=$tag seed=$seedByte');
        expect(payableChainDest(dest), dest, reason: 'tag=$tag seed=$seedByte');
        expect(receiveQrFailCopy(dest), isNull, reason: 'tag=$tag seed=$seedByte');
      }
      final short = encodeDestAddress(Uint8List.fromList(List.filled(20, tag)));
      expect(isDestAddress(short), isTrue, reason: 'short $tag');
      expect(isPayableDest(short), isFalse, reason: 'short $tag');
      expect(isUnpayableSsa1(short), isTrue, reason: 'short $tag');
      expect(parseReceiveQr(short), isNull, reason: 'short $tag');
      expect(receiveQrFailCopy(short), kErrShortSsa1, reason: 'short $tag');
      expect(payableChainDest(short), isNull, reason: 'short $tag');
      expect(continuumPayable(short), isFalse, reason: 'short $tag');
    }
    final bad = encodeDestAddress(
      Uint8List.fromList(List.filled(20, 3)),
      Uint8List.fromList(List.filled(32, 1)),
    );
    expect(isDestAddress(bad), isTrue);
    expect(isPayableDest(bad), isFalse);
    expect(receiveQrFailCopy(bad), kErrShortSsa1);
    final trailed = encodeHrp(
      'ssa',
      Uint8List.fromList([
        ...List.filled(20, 2),
        ...admitBaseBytes(Uint8List.fromList(List.filled(32, 5))),
        9,
      ]),
    );
    expect(isPayableDest(trailed), isFalse);
    expect(isPayableDest(id.address), isFalse);
    expect(isPayableDest(id.paymentCode), isFalse);
    expect(isPayableDest(id.paymentCodeFull), isFalse);
    expect(continuumPayable(id.paymentCodeFull), isTrue);
    expect(parseReceiveQr(id.paymentCodeFull), id.paymentCodeFull);
    expect(parseReceiveQr(id.paymentCode), isNull);
    expect(receiveQrFailCopy(id.paymentCode), isNot(kErrShortSsa1));
    expect(isDestAddress(kPoolFeeDest), isTrue);
    expect(isPayableDest(kPoolFeeDest), isFalse);
    expect(flowSendAdvisoryOf(StateError(kErrShortSsa1)), kErrShortSsa1);
    expect(flowSendAdvisoryOf(StateError(kErrShortSsa1)), isNot(kErrShortShe1));
  });

  test('the payee gate refuses a short ssa1 for any amount and does not post', () async {
    final amounts = <num>[0, 0.00000000001, 1, 50, 9007199254740993];
    for (final amount in amounts) {
      final ledger = ShearLedger();
      final result = await submitContinuumSend(
        ledger: ledger,
        restFrame: 'she1rest',
        startTo: 'kept',
        enteredTo: kPoolFeeDest,
        amount: amount.toDouble(),
        nanosWire: amount == 9007199254740993 ? '9007199254740993' : null,
      );
      expect(result.posted, isFalse, reason: 'amount=$amount');
      expect(result.to, 'kept', reason: 'amount=$amount');
      expect(result.remark, kErrShortSsa1, reason: 'amount=$amount');
      expect(result.tx, isNull, reason: 'amount=$amount');
      expect(ledger.transactions, isEmpty, reason: 'amount=$amount');
    }
    final finger = await submitContinuumSend(
      ledger: ShearLedger(),
      restFrame: 'she1rest',
      startTo: 'kept',
      enteredTo: createIdentity().paymentCode,
      amount: 1,
    );
    expect(finger.posted, isFalse);
    expect(finger.to, 'kept');
    expect(finger.remark, kErrShortShe1);
  });

  test('seal throws for a third-party short dest of any amount and binds B for a long dest', () {
    final sender = Uint8List.fromList(List.generate(32, (i) => i + 1));
    final other = Uint8List.fromList(List.generate(32, (i) => 200 - i));
    var seals = 0;
    Map<String, dynamic> stub(Object v, {Uint8List? dest20, String kind = 'send'}) {
      seals += 1;
      return {
        'kind': kind,
        'nanos': v is BigInt ? v.toString() : v,
        'commit': Uint8List(32),
        'noteCommit': Uint8List(32),
        'r': Uint8List(32),
      };
    }

    debugNativeSealNote = (v, {dest20, kind = 'send'}) => stub(v, dest20: dest20, kind: kind);
    debugNativeSealUnits = (v, {dest20, kind = 'send'}) => stub(v, dest20: dest20, kind: kind);
    addTearDown(() {
      debugNativeSealNote = null;
      debugNativeSealUnits = null;
    });
    final amounts = <String>[
      '1',
      '1000',
      '100000000000',
      '9007199254740993',
      ((BigInt.one << 64) - BigInt.one).toString(),
    ];
    for (final wire in amounts) {
      final before = seals;
      expect(
        () => sealFlowSpendVouts({
          'spendSeed': sender,
          'destTo': kPoolFeeDest,
          'src': longDest(4, 8),
          'vouts': [
            {'address': kPoolFeeDest, 'nanos': wire, 'kind': 'send'},
          ],
        }),
        throwsA(isA<StateError>().having((e) => e.message, 'message', kErrShortSsa1)),
        reason: wire,
      );
      expect(seals, before, reason: 'short $wire must not seal');
      final bad = encodeDestAddress(
        Uint8List.fromList(List.filled(20, 3)),
        Uint8List.fromList(List.filled(32, 1)),
      );
      expect(
        () => sealFlowSpendVouts({
          'spendSeed': sender,
          'destTo': bad,
          'src': longDest(4, 8),
          'vouts': [
            {'address': bad, 'nanos': wire, 'kind': 'send'},
          ],
        }),
        throwsA(isA<StateError>().having((e) => e.message, 'message', kErrShortSsa1)),
        reason: 'bad $wire',
      );
      final dest = longDest(wire.hashCode & 255, 40);
      final built = sealFlowSpendVouts({
        'spendSeed': sender,
        'destTo': dest,
        'src': longDest(9, 8),
        'vouts': [
          {'address': dest, 'nanos': wire, 'kind': 'send'},
        ],
      });
      final note = Map<String, dynamic>.from((built['vouts'] as List).single as Map);
      final fromBase = pointBytes(admitPubFromBase(pointFrom(admitBaseFromAddress(dest)!), note));
      final fromSeed = pointBytes(admitPub(admitScalarFromSeed(sender, note)));
      expect(note['admitPub'], fromBase, reason: wire);
      expect(note['admitPub'], isNot(fromSeed), reason: wire);
      expect(note['rEph'], isA<Uint8List>(), reason: wire);
      expect(note['rCt'], isA<Uint8List>(), reason: wire);
      final self = sealFlowSpendVouts({
        'spendSeed': sender,
        'destTo': kPoolFeeDest,
        'src': kPoolFeeDest,
        'vouts': [
          {'address': kPoolFeeDest, 'nanos': wire, 'kind': 'send'},
        ],
      });
      expect((self['vouts'] as List).single, isA<Map>(), reason: 'self $wire');
    }
    expect(other, isNot(sender));
  });

  test('CLI send prints the short-form sentence for any amount', () async {
    for (final amount in ['0.01', '1', '50', '90071992547.40993']) {
      final err = StringBuffer();
      final code = await runShearCli(
        ['send', '--to', kPoolFeeDest, '--amount', amount],
        stdout: StringBuffer(),
        stderr: err,
      );
      expect(code, 2, reason: amount);
      expect(err.toString().trim(), kErrShortSsa1, reason: amount);
    }
    final err = StringBuffer();
    final code = await runShearCli(
      ['send', '--to', longDest(6, 6), '--amount', '1'],
      stdout: StringBuffer(),
      stderr: err,
    );
    expect(err.toString(), isNot(contains(kErrShortSsa1)));
    expect(code, isNot(0));
  });

  testWidgets('Flow shows the sentence and disables Send for a short ssa1', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('payable-dest-088-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ShearLedger()..bindIdentity(session.identity!),
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), kPoolFeeDest);
    await tester.pump();
    expect(find.byKey(const Key('flow-short-ssa1')), findsOneWidget);
    expect(find.text(kErrShortSsa1), findsWidgets);
    expect(tester.widget<FilledButton>(find.byKey(const Key('flow-send'))).onPressed, isNull);
    await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), longDest(11, 12));
    await tester.pump();
    expect(find.byKey(const Key('flow-short-ssa1')), findsNothing);
    expect(tester.widget<FilledButton>(find.byKey(const Key('flow-send'))).onPressed, isNotNull);
  });
}
