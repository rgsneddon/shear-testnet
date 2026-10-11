import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';

/// Progress and Cancel while a send is in flight. The crypto isolate stamps
/// are [t18_off_ui_test.dart]. This file only checks the window still draws.

void main() {
  testWidgets('Flow send shows progress and Cancel and still draws a frame', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final dir = Directory.systemTemp.createTempSync('t18-frame-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final ident = session.identity!;
    final pool = _HoldSendPool();
    addTearDown(pool.close);
    final ledger = ShearLedger(pool: pool)..bindIdentity(ident);
    ledger.viewSecret = ident.viewKey;
    ledger.confirmRound(address: ident.address, pot: 2, height: 2);
    ledger.settleTo(2 + ShearLedger.spendableConfirmations);
    final bob = destForLogin(createIdentity().address, height: 1, viewKey: 'ab' * 32)!;

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

    expect(find.byKey(const Key('flow-send-progress')), findsOneWidget);
    expect(find.byKey(const Key('flow-send-cancel')), findsOneWidget);
    final label = tester.widget<Text>(find.byKey(const Key('flow-send-progress'))).data ?? '';
    expect(label, isNotEmpty);
    expect(
      label.contains('Selecting') || label.contains('Building proof') || label.contains('Broadcasting'),
      isTrue,
      reason: label,
    );
    expect(tester.widget<FilledButton>(find.byKey(const Key('flow-send'))).onPressed, isNull);

    var drew = false;
    tester.binding.addPostFrameCallback((_) => drew = true);
    await tester.pump();
    expect(drew, isTrue);
    expect(find.byKey(const Key('flow-send-cancel')), findsOneWidget);
    expect(tester.takeException(), isNull);

    final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
    expect(state.debugFlowSending, isTrue);
    await tester.tap(find.byKey(const Key('flow-send-cancel')));
    await tester.pump();
    expect(state.debugFlowProgress, isNotNull);
    expect(state.debugFlowProgress!.cancelRequested, isTrue);
    expect(state.debugFlowSending, isTrue);

    if (!pool.gate.isCompleted) {
      pool.gate.complete(<String, dynamic>{'ok': false, 'reason': 'held'});
    }
    final deadline = DateTime.now().add(const Duration(seconds: 20));
    while (state.debugFlowSending && DateTime.now().isBefore(deadline)) {
      await tester.pump();
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
    }
    expect(state.debugFlowSending, isFalse);
    expect(tester.takeException(), isNull);
  });
}

class _HoldSendPool extends ShearPoolClient {
  _HoldSendPool()
      : super(
          baseUrl: 'http://127.0.0.1:9',
          http: HttpClient()..connectionTimeout = const Duration(milliseconds: 200),
        );

  final Completer<Map<String, dynamic>> gate = Completer<Map<String, dynamic>>();

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
  }) {
    return gate.future;
  }
}
