import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

import 'support/sealed_book.dart';

/// A throw from the Flow send must clear the latch. The next tap can send.
void main() {
  testWidgets('a thrown Flow send clears the latch and can be tapped again', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final dir = Directory.systemTemp.createTempSync('flow-latch-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final ident = session.identity!;
    final pool = _QuietPool();
    addTearDown(pool.close);
    final ledger = _ThrowFundLedger(pool: pool)..bindIdentity(ident);
    ledger.viewSecret = ident.viewKey;
    // A real sealed 2 SHE note on a receive dest, mined 9 deep: the send
    // reaches funding, which throws. A bare round credit is never Spendable.
    final seed = seedOf(ident);
    ledger.spendSeed = seed;
    final from = ledger.allocateReceiveDest(ident.address, paymentCode: ident.paymentCode);
    final note = sealedNoteOn(from, seed, 2 * kUnitsPerShe, height: 2);
    ledger.rememberNote(note);
    pool.addLive(note, 2);
    ledger.noteLiveHeight(2 + ShearLedger.spendableConfirmations);
    ledger.settleTo(2 + ShearLedger.spendableConfirmations);
    ledger.recheckRestFrameSpendable(ident.address, paymentCode: ident.paymentCode);
    expect(
      (ledger.spendableOwned(ident.address, paymentCode: ident.paymentCode) * kUnitsPerShe).round(),
      2 * kUnitsPerShe,
    );
    final bobId = createIdentity();
    final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(bobId.address, paymentCode: bobId.paymentCode);

    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), bob);
    await tester.enterText(find.byKey(const Key('flow-amount')), '0.2');
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reserve-unprivate-accept')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
    final deadline = DateTime.now().add(const Duration(seconds: 10));
    while (state.debugFlowSending && DateTime.now().isBefore(deadline)) {
      await tester.pump();
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      });
    }
    expect(tester.takeException(), isNull);
    expect(state.debugFlowSending, isFalse);
    expect(tester.widget<FilledButton>(find.byKey(const Key('flow-send'))).onPressed, isNotNull);
    expect(find.byKey(const Key('flow-send-advisory')), findsOneWidget);
    expect(find.text(kErrSendGeneric), findsOneWidget);

    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    final again = DateTime.now().add(const Duration(seconds: 10));
    while (state.debugFlowSending && DateTime.now().isBefore(again)) {
      await tester.pump();
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      });
    }
    expect(state.debugFlowSending, isFalse);
    expect(tester.takeException(), isNull);
    expect(ledger.throws, greaterThanOrEqualTo(2));
  });
}

class _ThrowFundLedger extends ShearLedger {
  _ThrowFundLedger({super.pool});

  int throws = 0;

  @override
  double? fundFromPaintedContinuum(String restFrame, {String? paymentCode, required double needShe}) {
    throws += 1;
    throw StateError('fund_threw');
  }
}

class _QuietPool extends SealedNotePool {
  @override
  Future<Map<String, dynamic>> mempoolPressure() async => {'depth': 0};
}
